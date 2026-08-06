/**
 * Pipeline controller for swarm execution.
 *
 * Orchestrates execution waves within each iteration:
 * - Agents in the same wave execute in parallel
 * - Waves execute sequentially (wave N+1 starts after wave N completes)
 * - For pipeline mode, iterations repeat the full DAG execution
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSource, ModelRegistry, Settings, SingleResult } from "@oh-my-pi/pi-coding-agent";
import type { SwarmBeadsProjector, SwarmProjectionEvent } from "../adapters/beads";
import {
	resolveSwarmHistoryInheritance,
	resolveSwarmIsolation,
	type SwarmAgent,
	type SwarmDefinition,
} from "../definition/schema";
import type {
	SwarmPolicyBoundary,
	SwarmPolicyContext,
	SwarmPolicyDecision,
	SwarmPolicyObservations,
	SwarmPolicyRegistry,
} from "../policy/plugins";
import { mapWithConcurrency } from "./concurrency";
import { buildDependencyGraph } from "./dag";
import { executeSwarmAgent, type SwarmAgentRunner } from "./executor";
import { createAbortSignalScope } from "./signals";
import type { AgentStatus, StateTracker } from "./state";

// ============================================================================
// Types
// ============================================================================

export interface PipelineOptions {
	workspace: string;
	cwd?: string;
	signal?: AbortSignal;
	resume?: boolean;
	onProgress?: (state: PipelineProgress) => void;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	policyRegistry?: SwarmPolicyRegistry;
	beadsProjector?: SwarmBeadsProjector;
	/** Current parent OMP branch, copied into workers that request inheritance. */
	parentMessages?: AgentMessage[];
	/** Optional external worker backend; defaults to the in-process executor. */
	agentRunner?: SwarmAgentRunner;
}

export interface PipelineProgress {
	iteration: number;
	targetCount: number;
	currentWave: number;
	totalWaves: number;
	agents: Record<string, { status: AgentStatus; iteration: number }>;
}

export interface PipelineResult {
	status: "completed" | "failed" | "aborted";
	iterations: number;
	agentResults: Map<string, SingleResult[]>;
	errors: string[];
	policy?: SwarmPolicyDecision;
}

// ============================================================================
// Controller
// ============================================================================

export class PipelineController {
	#def: SwarmDefinition;
	#waves: string[][];
	#dependencies: Map<string, Set<string>>;
	#stateTracker: StateTracker;

	constructor(def: SwarmDefinition, waves: string[][], stateTracker: StateTracker) {
		this.#def = def;
		this.#waves = waves;
		this.#dependencies = buildDependencyGraph(def);
		this.#stateTracker = stateTracker;
	}

	async run(options: PipelineOptions): Promise<PipelineResult> {
		const { workspace, signal, onProgress, modelRegistry, settings, policyRegistry, agentRunner } = options;
		const allResults = new Map<string, SingleResult[]>();
		const errors: string[] = [];
		let latestPolicy: SwarmPolicyDecision | undefined;
		const targetCount = this.#def.targetCount;
		const resumeIteration = options.resume
			? Math.max(0, Math.min(targetCount, this.#stateTracker.state.nextIteration))
			: 0;

		for (const name of this.#def.agents.keys()) {
			allResults.set(
				name,
				options.resume ? loadCompletedHistory(this.#stateTracker.state.results[name], resumeIteration) : [],
			);
		}

		await this.#stateTracker.appendOrchestratorLog(
			`Pipeline '${this.#def.name}' starting: mode=${this.#def.mode} iterations=${targetCount} waves=${this.#waves.length} agents=${this.#def.agents.size} failurePolicy=${this.#def.failurePolicy}${options.resume ? " (resume)" : ""}`,
		);
		await this.#project(options.beadsProjector, {
			type: "started",
			swarmName: this.#def.name,
			status: "running",
			detail: options.resume ? "resumed" : "started",
		});

		try {
			for (let iteration = resumeIteration; iteration < targetCount; iteration++) {
				if (signal?.aborted) {
					return await this.#abort(allResults, errors, iteration, latestPolicy, options.beadsProjector);
				}

				await this.#stateTracker.updatePipeline({
					status: "running",
					iteration,
					nextIteration: iteration,
					currentWave: 0,
					completedAt: undefined,
				});
				await this.#stateTracker.appendOrchestratorLog(`--- Iteration ${iteration + 1}/${targetCount} ---`);

				const emitProgress = (currentWave: number) => {
					onProgress?.({
						iteration,
						targetCount,
						currentWave,
						totalWaves: this.#waves.length,
						agents: this.#buildProgressSnapshot(),
					});
				};

				const iterationRun = await this.#runIteration(iteration, {
					workspace,
					signal,
					resume: options.resume && iteration === resumeIteration,
					emitProgress,
					modelRegistry,
					settings,
					policyRegistry,
					agentRunner,
					parentMessages: options.parentMessages,
					history: allResults,
					onWaveComplete: async (wave, latestResults) => {
						const decision = await this.#evaluatePolicy(
							policyRegistry,
							"wave",
							iteration,
							wave,
							latestResults,
							this.#historyWithCurrent(allResults, latestResults),
							options,
							this.#waves[wave] ?? [],
						);
						latestPolicy = decision ?? latestPolicy;
						return decision;
					},
				});

				for (const [agentName, result] of iterationRun.results) {
					const history = allResults.get(agentName);
					if (!history) throw new Error(`Missing result history for agent '${agentName}'.`);
					history.push(result);
					if (resultFailed(result)) {
						errors.push(
							`${agentName} (iteration ${iteration + 1}): ${result.error || result.abortReason || `exit code ${result.exitCode}`}`,
						);
					}
				}

				if (signal?.aborted || iterationRun.aborted) {
					return await this.#abort(allResults, errors, iteration, latestPolicy, options.beadsProjector);
				}

				if (iterationRun.policyDecision && !iterationRun.policyDecision.accepted) {
					errors.push(...formatPolicyErrors(iterationRun.policyDecision));
					await this.#stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
					await this.#stateTracker.appendOrchestratorLog(
						`Pipeline blocked by policy at wave ${iterationRun.policyDecision.boundary}`,
					);
					await this.#project(options.beadsProjector, {
						type: "blocked",
						swarmName: this.#def.name,
						status: "failed",
						detail: `policy at ${iterationRun.policyDecision.boundary}`,
					});
					return {
						status: "failed",
						iterations: iteration + 1,
						agentResults: allResults,
						errors,
						policy: iterationRun.policyDecision,
					};
				}

				if (iterationRun.failed && this.#def.failurePolicy !== "continue") {
					await this.#stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
					await this.#stateTracker.appendOrchestratorLog(
						`Pipeline stopped after agent failure (${this.#def.failurePolicy})`,
					);
					await this.#project(options.beadsProjector, {
						type: "failed",
						swarmName: this.#def.name,
						status: "failed",
						detail: `agent failure at iteration ${iteration + 1}`,
					});
					return {
						status: "failed",
						iterations: iteration + 1,
						agentResults: allResults,
						errors,
						policy: latestPolicy,
					};
				}

				const iterationDecision = await this.#evaluatePolicy(
					policyRegistry,
					"iteration",
					iteration,
					undefined,
					iterationRun.results,
					allResults,
					options,
					this.#def.agentOrder,
				);
				if (signal?.aborted) {
					return await this.#abort(allResults, errors, iteration, latestPolicy, options.beadsProjector);
				}

				latestPolicy = iterationDecision ?? latestPolicy;
				if (iterationDecision && !iterationDecision.accepted) {
					errors.push(...formatPolicyErrors(iterationDecision));
					await this.#stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
					await this.#stateTracker.appendOrchestratorLog("Pipeline blocked by policy at iteration boundary");
					await this.#project(options.beadsProjector, {
						type: "blocked",
						swarmName: this.#def.name,
						status: "failed",
						detail: "policy at iteration boundary",
					});
					return {
						status: "failed",
						iterations: iteration + 1,
						agentResults: allResults,
						errors,
						policy: iterationDecision,
					};
				}

				await this.#stateTracker.updatePipeline({
					nextIteration: iteration + 1,
					currentWave: 0,
				});
			}

			if (signal?.aborted) {
				return await this.#abort(
					allResults,
					errors,
					this.#stateTracker.state.iteration,
					latestPolicy,
					options.beadsProjector,
				);
			}

			const completeDecision = await this.#evaluatePolicy(
				policyRegistry,
				"complete",
				targetCount - 1,
				undefined,
				this.#latestResults(allResults),
				allResults,
				options,
				this.#def.agentOrder,
			);
			latestPolicy = completeDecision ?? latestPolicy;
			if (signal?.aborted) {
				return await this.#abort(
					allResults,
					errors,
					this.#stateTracker.state.iteration,
					latestPolicy,
					options.beadsProjector,
				);
			}
			if (completeDecision && !completeDecision.accepted) {
				errors.push(...formatPolicyErrors(completeDecision));
				await this.#stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
				await this.#stateTracker.appendOrchestratorLog("Pipeline blocked by completion policy");
				await this.#project(options.beadsProjector, {
					type: "blocked",
					swarmName: this.#def.name,
					status: "failed",
					detail: "completion policy",
				});
				return {
					status: "failed",
					iterations: targetCount,
					agentResults: allResults,
					errors,
					policy: completeDecision,
				};
			}
			const status = errors.length > 0 ? ("failed" as const) : ("completed" as const);
			await this.#stateTracker.updatePipeline({ status, nextIteration: targetCount, completedAt: Date.now() });
			await this.#project(options.beadsProjector, {
				type: status === "completed" ? "completed" : "failed",
				swarmName: this.#def.name,
				status,
				detail: `${errors.length} error(s)`,
			});
			return { status, iterations: targetCount, agentResults: allResults, errors, policy: latestPolicy };
		} catch (err) {
			if (signal?.aborted)
				return await this.#abort(
					allResults,
					errors,
					this.#stateTracker.state.iteration,
					latestPolicy,
					options.beadsProjector,
				);
			const error = err instanceof Error ? err.message : String(err);
			await this.#project(options.beadsProjector, {
				type: "failed",
				swarmName: this.#def.name,
				status: "failed",
				detail: "fatal runtime error",
			});
			errors.push(error);
			return {
				status: "failed",
				iterations: resumeIteration,
				agentResults: allResults,
				errors,
				policy: latestPolicy,
			};
		}
	}

	async #abort(
		agentResults: Map<string, SingleResult[]>,
		errors: string[],
		iteration: number,
		policy: SwarmPolicyDecision | undefined,
		beadsProjector?: SwarmBeadsProjector,
	): Promise<PipelineResult> {
		await this.#stateTracker.updatePipeline({ status: "aborted", completedAt: Date.now() });
		await this.#stateTracker.appendOrchestratorLog(`Pipeline aborted during iteration ${iteration + 1}`);
		await this.#project(beadsProjector, {
			type: "aborted",
			swarmName: this.#def.name,
			status: "aborted",
			detail: `iteration ${iteration + 1}`,
		});
		return {
			status: "aborted",
			iterations: iteration,
			agentResults,
			errors,
			policy,
		};
	}
	async #project(projector: SwarmBeadsProjector | undefined, event: SwarmProjectionEvent): Promise<void> {
		if (!projector) return;
		try {
			await projector.project(event);
			await this.#stateTracker.recordProjection(projector.targetId, event.type, event.status, event.detail);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.#stateTracker.recordProjection(projector.targetId, event.type, event.status, event.detail, message);
			await this.#stateTracker.appendOrchestratorLog(`Beads projection failed: ${message}`);
		}
	}

	async #runIteration(
		iteration: number,
		options: {
			workspace: string;
			signal?: AbortSignal;
			resume?: boolean;
			emitProgress: (currentWave: number) => void;
			modelRegistry?: ModelRegistry;
			settings?: Settings;
			policyRegistry?: SwarmPolicyRegistry;
			parentMessages?: AgentMessage[];
			agentRunner?: SwarmAgentRunner;
			history: ReadonlyMap<string, readonly SingleResult[]>;
			onWaveComplete?: (
				wave: number,
				latestResults: ReadonlyMap<string, SingleResult>,
			) => Promise<SwarmPolicyDecision | undefined>;
		},
	): Promise<{
		results: Map<string, SingleResult>;
		policyDecision?: SwarmPolicyDecision;
		failed: boolean;
		aborted: boolean;
	}> {
		const results = new Map<string, SingleResult>();
		const blockedAgents = new Set<string>();
		let failed = false;
		let agentIndex = 0;

		if (options.resume) {
			for (const agentName of this.#def.agents.keys()) {
				const result = loadLatestResult(this.#stateTracker.state.results[agentName], iteration);
				if (result && !resultFailed(result)) results.set(agentName, result);
			}
		}

		for (let waveIdx = 0; waveIdx < this.#waves.length; waveIdx++) {
			const wave = this.#waves[waveIdx];

			if (options.signal?.aborted) {
				return { results, failed, aborted: true };
			}

			await this.#stateTracker.updatePipeline({ iteration, currentWave: waveIdx });
			await this.#stateTracker.appendOrchestratorLog(
				`Wave ${waveIdx + 1}/${this.#waves.length}: [${wave.join(", ")}]`,
			);

			const runnable: Array<{ agentName: string; index: number }> = [];
			for (const agentName of wave) {
				if (results.has(agentName)) {
					await this.#stateTracker.updateAgent(agentName, {
						status: "completed",
						iteration,
						wave: waveIdx,
					});
					continue;
				}
				if (
					this.#def.failurePolicy === "skip_dependents" &&
					[...(this.#dependencies.get(agentName) ?? [])].some(dependency => blockedAgents.has(dependency))
				) {
					const result = makeDependencyFailureResult(this.#def, agentName, iteration, agentIndex++);
					results.set(agentName, result);
					blockedAgents.add(agentName);
					failed = true;
					await this.#stateTracker.updateAgent(agentName, {
						status: "skipped",
						iteration,
						wave: waveIdx,
						error: result.error,
						completedAt: Date.now(),
					});
					await this.#stateTracker.recordResult(agentName, iteration, 0, result);
					continue;
				}
				const currentIndex = agentIndex++;
				runnable.push({ agentName, index: currentIndex });
				await this.#stateTracker.updateAgent(agentName, {
					status: "waiting",
					iteration,
					wave: waveIdx,
					error: undefined,
				});
			}
			options.emitProgress(waveIdx);

			const waveResults = await mapWithConcurrency(
				runnable,
				(this.#def.maxConcurrency ?? runnable.length) || 1,
				async ({ agentName, index: currentIndex }) => {
					const agent = this.#def.agents.get(agentName);
					if (!agent) throw new Error(`Unknown swarm agent '${agentName}'.`);
					const signalScope = createAbortSignalScope(options.signal, this.#def.agentTimeoutMs);
					try {
						const beforeContext = this.#buildAgentPolicyContext(
							iteration,
							waveIdx,
							agentName,
							0,
							results,
							options.history,
							options.workspace,
						);
						const before = options.policyRegistry
							? await options.policyRegistry.capture(this.#def, beforeContext, "before", agent)
							: new Map<string, unknown>();
						await this.#stateTracker.recordPolicyObservations(agentName, iteration, 0, "before", before);
						let beforeForAttempt = before;
						const result = await (options.agentRunner ?? executeSwarmAgent)(agent, currentIndex, {
							workspace: options.workspace,
							swarmName: this.#def.name,
							iteration,
							modelOverride: agent.model ?? this.#def.model,
							signal: signalScope.signal,
							onProgress: (_name, _progress) => {
								options.emitProgress(waveIdx);
							},
							modelRegistry: options.modelRegistry,
							settings: options.settings,
							workspaceIsolation: resolveSwarmIsolation(this.#def, agent),
							inheritHistory: resolveSwarmHistoryInheritance(this.#def, agent),
							parentMessages: options.parentMessages,
							stateTracker: this.#stateTracker,
							onFinalize:
								options.policyRegistry && this.#hasAgentPolicies(agent)
									? async (candidate: SingleResult, attempt: number) => {
											const finalized = await this.#finalizeAgent(
												options.policyRegistry!,
												agent,
												iteration,
												waveIdx,
												attempt,
												agentName,
												results,
												options.history,
												options.workspace,
												beforeForAttempt,
												candidate,
											);
											beforeForAttempt = finalized.beforeForNextAttempt;
											return finalized.feedback;
										}
									: undefined,
						});
						return { agentName, result };
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						const failResult: SingleResult = {
							index: currentIndex,
							id: `swarm-${this.#def.name}-${agentName}-${iteration}`,
							agent: agentName,
							agentSource: "project" as AgentSource,
							task: agent.task,
							exitCode: 1,
							output: "",
							stderr: error,
							truncated: false,
							durationMs: 0,
							tokens: 0,
							requests: 0,
							error,
						};
						return { agentName, result: failResult };
					} finally {
						signalScope.dispose();
					}
				},
			);

			for (const { agentName, result } of waveResults) {
				results.set(agentName, result);
				if (resultFailed(result)) {
					failed = true;
					if (this.#def.failurePolicy !== "continue") blockedAgents.add(agentName);
				}
			}

			if (options.signal?.aborted) return { results, failed, aborted: true };
			options.emitProgress(waveIdx);
			const policyDecision = await options.onWaveComplete?.(waveIdx, results);
			if (policyDecision && !policyDecision.accepted) {
				return { results, policyDecision, failed, aborted: false };
			}
			if (failed && this.#def.failurePolicy === "fail_fast") {
				return { results, failed, aborted: false };
			}
		}

		return { results, failed, aborted: options.signal?.aborted ?? false };
	}

	#hasAgentPolicies(agent: SwarmAgent): boolean {
		return agent.checks.length > 0 || agent.evals.length > 0;
	}

	#buildAgentPolicyContext(
		iteration: number,
		wave: number,
		agentName: string,
		attempt: number,
		latestResults: ReadonlyMap<string, SingleResult>,
		history: ReadonlyMap<string, readonly SingleResult[]>,
		workspace: string,
	): SwarmPolicyContext {
		return {
			definition: this.#def,
			cwd: workspace,
			workspace,
			swarmDir: this.#stateTracker.swarmDir,
			boundary: "agent",
			iteration,
			wave,
			attempt,
			agent: agentName,
			params: {},
			latestResults: new Map(latestResults),
			history: this.#historyWithCurrent(history, latestResults),
			state: this.#stateTracker.state,
		};
	}

	async #finalizeAgent(
		registry: SwarmPolicyRegistry,
		agent: SwarmAgent,
		iteration: number,
		wave: number,
		attempt: number,
		agentName: string,
		latestResults: ReadonlyMap<string, SingleResult>,
		history: ReadonlyMap<string, readonly SingleResult[]>,
		workspace: string,
		before: ReadonlyMap<string, unknown>,
		candidate: SingleResult,
	): Promise<{
		feedback?: string;
		beforeForNextAttempt: ReadonlyMap<string, unknown>;
	}> {
		const candidateResults = new Map(latestResults);
		candidateResults.set(agentName, candidate);
		const context = this.#buildAgentPolicyContext(
			iteration,
			wave,
			agentName,
			attempt,
			candidateResults,
			history,
			workspace,
		);
		await this.#stateTracker.recordPolicyObservations(agentName, iteration, attempt, "before", before);
		const after = await registry.capture(this.#def, context, "after", agent);
		await this.#stateTracker.recordPolicyObservations(agentName, iteration, attempt, "after", after);
		const observations: SwarmPolicyObservations = new Map(
			[...new Set([...before.keys(), ...after.keys()])].map(key => [
				key,
				{ before: before.get(key), after: after.get(key) },
			]),
		);
		const decision = await registry.evaluate(this.#def, context, agent, observations);
		await this.#stateTracker.updatePolicy(decision, { iteration, wave, agent: agentName });
		if (decision.accepted) return { beforeForNextAttempt: after };

		const nextContext = this.#buildAgentPolicyContext(
			iteration,
			wave,
			agentName,
			attempt + 1,
			candidateResults,
			history,
			workspace,
		);
		const beforeForNextAttempt = await registry.capture(this.#def, nextContext, "before", agent);
		await this.#stateTracker.recordPolicyObservations(
			agentName,
			iteration,
			attempt + 1,
			"before",
			beforeForNextAttempt,
		);
		return {
			feedback: formatAgentPolicyFeedback(agentName, decision),
			beforeForNextAttempt,
		};
	}

	async #evaluatePolicy(
		registry: SwarmPolicyRegistry | undefined,
		boundary: SwarmPolicyBoundary,
		iteration: number,
		wave: number | undefined,
		latestResults: ReadonlyMap<string, SingleResult>,
		history: ReadonlyMap<string, readonly SingleResult[]>,
		options: PipelineOptions,
		scopedAgents: readonly string[],
	): Promise<SwarmPolicyDecision | undefined> {
		if (!registry) return undefined;

		const hasGlobalPolicies = this.#def.checks.length > 0 || this.#def.evals.length > 0;
		const agentNames = [...new Set(scopedAgents)].filter(agentName => {
			const agent = this.#def.agents.get(agentName);
			return agent && (agent.checks.length > 0 || agent.evals.length > 0);
		});
		if (!hasGlobalPolicies && agentNames.length === 0) return undefined;

		const context: SwarmPolicyContext = {
			definition: this.#def,
			cwd: options.cwd ?? options.workspace,
			params: {},
			workspace: options.workspace,
			swarmDir: this.#stateTracker.swarmDir,
			boundary,
			iteration,
			wave,
			latestResults,
			history,
			state: this.#stateTracker.state,
		};
		const decisions: SwarmPolicyDecision[] = [];
		if (hasGlobalPolicies) {
			decisions.push(await registry.evaluate(this.#def, context));
		}
		for (const agentName of agentNames) {
			const agent = this.#def.agents.get(agentName);
			if (!agent) throw new Error(`Unknown swarm agent '${agentName}'.`);
			decisions.push(await registry.evaluate(this.#def, { ...context, agent: agentName }, agent));
		}

		const decision: SwarmPolicyDecision = {
			boundary,
			accepted: decisions.every(item => item.accepted),
			failures: decisions.flatMap(item => item.failures),
			evaluations: decisions.flatMap(item => item.evaluations),
		};
		await this.#stateTracker.updatePolicy(decision, { iteration, wave });
		return decision;
	}

	#historyWithCurrent(
		history: ReadonlyMap<string, readonly SingleResult[]>,
		current: ReadonlyMap<string, SingleResult>,
	): Map<string, readonly SingleResult[]> {
		const combined = new Map<string, readonly SingleResult[]>();
		for (const [agentName, results] of history) combined.set(agentName, [...results]);
		for (const [agentName, result] of current) {
			combined.set(agentName, [...(combined.get(agentName) ?? []), result]);
		}
		return combined;
	}

	#latestResults(history: ReadonlyMap<string, readonly SingleResult[]>): Map<string, SingleResult> {
		const latest = new Map<string, SingleResult>();
		for (const [agentName, results] of history) {
			const result = results.at(-1);
			if (result) latest.set(agentName, result);
		}
		return latest;
	}

	#buildProgressSnapshot(): Record<string, { status: AgentStatus; iteration: number }> {
		const snapshot: Record<string, { status: AgentStatus; iteration: number }> = {};
		for (const [name, agent] of Object.entries(this.#stateTracker.state.agents)) {
			snapshot[name] = { status: agent.status, iteration: agent.iteration };
		}
		return snapshot;
	}
}

function resultFailed(result: SingleResult): boolean {
	return result.exitCode !== 0 || Boolean(result.error) || Boolean(result.aborted);
}

function loadLatestResult(
	records: ReadonlyArray<{ iteration: number; attempt: number; result: SingleResult }> | undefined,
	iteration: number,
): SingleResult | undefined {
	const candidates = (records ?? []).filter(record => record.iteration === iteration);
	candidates.sort((left, right) => left.attempt - right.attempt);
	return candidates.at(-1)?.result;
}

function loadCompletedHistory(
	records: ReadonlyArray<{ iteration: number; attempt: number; result: SingleResult }> | undefined,
	beforeIteration: number,
): SingleResult[] {
	const byIteration = new Map<number, { attempt: number; result: SingleResult }>();
	for (const record of records ?? []) {
		if (record.iteration >= beforeIteration) continue;
		const previous = byIteration.get(record.iteration);
		if (!previous || record.attempt >= previous.attempt) {
			byIteration.set(record.iteration, { attempt: record.attempt, result: record.result });
		}
	}
	return [...byIteration.entries()].sort(([left], [right]) => left - right).map(([, value]) => value.result);
}

function makeDependencyFailureResult(
	definition: SwarmDefinition,
	agentName: string,
	iteration: number,
	index: number,
): SingleResult {
	const error = `Skipped because a dependency failed (${definition.failurePolicy}).`;
	return {
		index,
		id: `swarm-${definition.name}-${agentName}-${iteration}-skipped`,
		agent: agentName,
		agentSource: "project" as AgentSource,
		task: definition.agents.get(agentName)?.task ?? "",
		exitCode: 1,
		output: "",
		stderr: error,
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		error,
	};
}

function formatPolicyErrors(decision: SwarmPolicyDecision): string[] {
	return decision.failures.map(failure => `${failure.source} ${failure.id}: ${failure.message}`);
}
function formatAgentPolicyFeedback(agentName: string, decision: SwarmPolicyDecision): string {
	const failures = formatPolicyErrors(decision);
	return [
		`Agent '${agentName}' finalization was rejected by runtime policy.`,
		...failures.map(failure => `- ${failure}`),
		"Correct the work described by these findings, then continue working in this same session.",
	].join("\n");
}
