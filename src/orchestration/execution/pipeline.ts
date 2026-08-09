/**
 * Pipeline controller for Shortleash execution.
 *
 * Agents in the same dependency wave execute in parallel, while waves execute
 * sequentially. Each declared graph runs once; an agent's same-session policy
 * corrections are represented as attempts in durable state.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSource, ModelRegistry, Settings, SingleResult } from "@oh-my-pi/pi-coding-agent";
import type { ShortleashBeadsProjector, ShortleashProjectionEvent } from "../adapters/beads";
import {
	resolveShortleashHistoryInheritance,
	resolveShortleashIsolation,
	type ShortleashAgent,
	type ShortleashDefinition,
} from "../definition/schema";
import type {
	ShortleashPolicyBoundary,
	ShortleashPolicyContext,
	ShortleashPolicyDecision,
	ShortleashPolicyObservations,
	ShortleashPolicyRegistry,
} from "../policy/policies";
import { mapWithConcurrency } from "./concurrency";
import { buildDependencyGraph } from "./dag";
import { executeShortleashAgent } from "./executor";
import { createAbortSignalScope } from "./signals";
import type { AgentStatus, ShortleashResultRecord, StateTracker } from "./state";

export interface PipelineOptions {
	workspace: string;
	cwd?: string;
	signal?: AbortSignal;
	resume?: boolean;
	onProgress?: (state: PipelineProgress) => void;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	policyRegistry?: ShortleashPolicyRegistry;
	beadsProjector?: ShortleashBeadsProjector;
	/** Current parent OMP branch, copied into workers that request inheritance. */
	parentMessages?: AgentMessage[];
}

export interface PipelineProgress {
	currentWave: number;
	totalWaves: number;
	agents: Record<string, { status: AgentStatus }>;
}

export interface PipelineResult {
	status: "completed" | "failed" | "aborted";
	agentResults: Map<string, SingleResult[]>;
	errors: string[];
	policy?: ShortleashPolicyDecision;
}

interface GraphRunOptions {
	workspace: string;
	signal?: AbortSignal;
	resume?: boolean;
	emitProgress: (currentWave: number) => void;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	policyRegistry?: ShortleashPolicyRegistry;
	parentMessages?: AgentMessage[];
	history: ReadonlyMap<string, readonly SingleResult[]>;
	onWaveComplete?: (
		wave: number,
		latestResults: ReadonlyMap<string, SingleResult>,
	) => Promise<ShortleashPolicyDecision | undefined>;
}

interface GraphRunResult {
	results: Map<string, SingleResult>;
	policyDecision?: ShortleashPolicyDecision;
	failed: boolean;
	aborted: boolean;
}

export class PipelineController {
	#def: ShortleashDefinition;
	#waves: string[][];
	#dependencies: Map<string, Set<string>>;
	#stateTracker: StateTracker;

	constructor(def: ShortleashDefinition, waves: string[][], stateTracker: StateTracker) {
		this.#def = def;
		this.#waves = waves;
		this.#dependencies = buildDependencyGraph(def);
		this.#stateTracker = stateTracker;
	}

	async run(options: PipelineOptions): Promise<PipelineResult> {
		const { workspace, signal, onProgress, modelRegistry, settings, policyRegistry } = options;
		const history = new Map<string, readonly SingleResult[]>();
		const agentResults = new Map<string, SingleResult[]>();
		const errors: string[] = [];
		let latestPolicy: ShortleashPolicyDecision | undefined;

		if (options.resume) {
			for (const [agentName, records] of Object.entries(this.#stateTracker.state.results)) {
				history.set(
					agentName,
					records.map(record => record.result),
				);
				const latest = loadLatestResult(records);
				if (latest && !resultFailed(latest)) agentResults.set(agentName, [latest]);
			}
		}

		await this.#stateTracker.appendOrchestratorLog(
			`Pipeline '${this.#def.name}' starting: waves=${this.#waves.length} agents=${this.#def.agents.size} failurePolicy=${this.#def.failurePolicy}${options.resume ? " (resume)" : ""}`,
		);
		await this.#project(options.beadsProjector, {
			type: "started",
			shortleashName: this.#def.name,
			status: "running",
			detail: options.resume ? "resumed" : "started",
		});

		try {
			await this.#stateTracker.updatePipeline({
				status: "running",
				currentWave: 0,
				completedAt: undefined,
			});

			const emitProgress = (currentWave: number) => {
				onProgress?.({
					currentWave,
					totalWaves: this.#waves.length,
					agents: this.#buildProgressSnapshot(),
				});
			};

			const graphRun = await this.#runGraph({
				workspace,
				signal,
				resume: options.resume,
				emitProgress,
				modelRegistry,
				settings,
				policyRegistry,
				parentMessages: options.parentMessages,
				history,
				onWaveComplete: async (wave, latestResults) => {
					const decision = await this.#evaluatePolicy(
						policyRegistry,
						"wave",
						wave,
						latestResults,
						this.#historyWithCurrent(history, latestResults),
						options,
						this.#waves[wave] ?? [],
					);
					latestPolicy = decision ?? latestPolicy;
					return decision;
				},
			});

			for (const [agentName, result] of graphRun.results) {
				agentResults.set(agentName, [result]);
				if (resultFailed(result)) {
					errors.push(`${agentName}: ${result.error || result.abortReason || `exit code ${result.exitCode}`}`);
				}
			}

			if (signal?.aborted || graphRun.aborted) {
				return await this.#abort(agentResults, errors, latestPolicy, options.beadsProjector);
			}

			if (graphRun.policyDecision && !graphRun.policyDecision.accepted) {
				errors.push(...formatPolicyErrors(graphRun.policyDecision));
				await this.#stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
				await this.#stateTracker.appendOrchestratorLog(
					`Pipeline blocked by policy at wave ${graphRun.policyDecision.boundary}`,
				);
				await this.#project(options.beadsProjector, {
					type: "blocked",
					shortleashName: this.#def.name,
					status: "failed",
					detail: `policy at ${graphRun.policyDecision.boundary}`,
				});
				return {
					status: "failed",
					agentResults,
					errors,
					policy: graphRun.policyDecision,
				};
			}

			if (graphRun.failed && this.#def.failurePolicy !== "continue") {
				await this.#stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
				await this.#stateTracker.appendOrchestratorLog(
					`Pipeline stopped after agent failure (${this.#def.failurePolicy})`,
				);
				await this.#project(options.beadsProjector, {
					type: "failed",
					shortleashName: this.#def.name,
					status: "failed",
					detail: "agent failure",
				});
				return { status: "failed", agentResults, errors, policy: latestPolicy };
			}

			const completeDecision = await this.#evaluatePolicy(
				policyRegistry,
				"complete",
				undefined,
				graphRun.results,
				this.#historyWithCurrent(history, graphRun.results),
				options,
				this.#def.agentOrder,
			);
			latestPolicy = completeDecision ?? latestPolicy;
			if (signal?.aborted) {
				return await this.#abort(agentResults, errors, latestPolicy, options.beadsProjector);
			}
			if (completeDecision && !completeDecision.accepted) {
				errors.push(...formatPolicyErrors(completeDecision));
				await this.#stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
				await this.#stateTracker.appendOrchestratorLog("Pipeline blocked by completion policy");
				await this.#project(options.beadsProjector, {
					type: "blocked",
					shortleashName: this.#def.name,
					status: "failed",
					detail: "completion policy",
				});
				return { status: "failed", agentResults, errors, policy: completeDecision };
			}

			const status = errors.length > 0 ? ("failed" as const) : ("completed" as const);
			await this.#stateTracker.updatePipeline({ status, completedAt: Date.now() });
			await this.#project(options.beadsProjector, {
				type: status === "completed" ? "completed" : "failed",
				shortleashName: this.#def.name,
				status,
				detail: `${errors.length} error(s)`,
			});
			return { status, agentResults, errors, policy: latestPolicy };
		} catch (err) {
			if (signal?.aborted) return await this.#abort(agentResults, errors, latestPolicy, options.beadsProjector);
			const error = err instanceof Error ? err.message : String(err);
			await this.#project(options.beadsProjector, {
				type: "failed",
				shortleashName: this.#def.name,
				status: "failed",
				detail: "fatal runtime error",
			});
			errors.push(error);
			return { status: "failed", agentResults, errors, policy: latestPolicy };
		}
	}

	async #abort(
		agentResults: Map<string, SingleResult[]>,
		errors: string[],
		policy: ShortleashPolicyDecision | undefined,
		beadsProjector?: ShortleashBeadsProjector,
	): Promise<PipelineResult> {
		await this.#stateTracker.updatePipeline({ status: "aborted", completedAt: Date.now() });
		const wave = this.#stateTracker.state.currentWave + 1;
		await this.#stateTracker.appendOrchestratorLog(`Pipeline aborted during wave ${wave}`);
		await this.#project(beadsProjector, {
			type: "aborted",
			shortleashName: this.#def.name,
			status: "aborted",
			detail: `wave ${wave}`,
		});
		return { status: "aborted", agentResults, errors, policy };
	}

	async #project(projector: ShortleashBeadsProjector | undefined, event: ShortleashProjectionEvent): Promise<void> {
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

	async #runGraph(options: GraphRunOptions): Promise<GraphRunResult> {
		const results = new Map<string, SingleResult>();
		const blockedAgents = new Set<string>();
		let failed = false;
		let agentIndex = 0;

		if (options.resume) {
			for (const agentName of this.#def.agents.keys()) {
				const result = loadLatestResult(this.#stateTracker.state.results[agentName]);
				if (result && !resultFailed(result)) results.set(agentName, result);
			}
		}

		for (let waveIdx = 0; waveIdx < this.#waves.length; waveIdx++) {
			const wave = this.#waves[waveIdx];
			if (options.signal?.aborted) return { results, failed, aborted: true };

			await this.#stateTracker.updatePipeline({ currentWave: waveIdx });
			await this.#stateTracker.appendOrchestratorLog(
				`Wave ${waveIdx + 1}/${this.#waves.length}: [${wave.join(", ")}]`,
			);

			const runnable: Array<{ agentName: string; index: number }> = [];
			for (const agentName of wave) {
				if (results.has(agentName)) {
					await this.#stateTracker.updateAgent(agentName, { status: "completed", wave: waveIdx });
					continue;
				}
				if (
					this.#def.failurePolicy === "skip_dependents" &&
					[...(this.#dependencies.get(agentName) ?? [])].some(dependency => blockedAgents.has(dependency))
				) {
					const result = makeDependencyFailureResult(this.#def, agentName, agentIndex++);
					results.set(agentName, result);
					blockedAgents.add(agentName);
					failed = true;
					await this.#stateTracker.updateAgent(agentName, {
						status: "skipped",
						wave: waveIdx,
						error: result.error,
						completedAt: Date.now(),
					});
					await this.#stateTracker.recordResult(agentName, 0, result);
					continue;
				}
				const currentIndex = agentIndex++;
				runnable.push({ agentName, index: currentIndex });
				await this.#stateTracker.updateAgent(agentName, {
					status: "waiting",
					wave: waveIdx,
					error: undefined,
				});
			}
			options.emitProgress(waveIdx);

			const waveResults = await mapWithConcurrency(
				runnable,
				resolveTaskConcurrency(options.settings, runnable.length),
				async ({ agentName, index: currentIndex }) => {
					const agent = this.#def.agents.get(agentName);
					if (!agent) throw new Error(`Unknown Shortleash agent '${agentName}'.`);
					const signalScope = createAbortSignalScope(options.signal, this.#def.agentTimeoutMs);
					try {
						const beforeContext = this.#buildAgentPolicyContext(
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
						await this.#stateTracker.recordPolicyObservations(agentName, 0, "before", before);
						let beforeForAttempt = before;
						const result = await executeShortleashAgent(agent, currentIndex, {
							workspace: options.workspace,
							shortleashName: this.#def.name,
							modelOverride: agent.model ?? this.#def.model,
							signal: signalScope.signal,
							onProgress: (_name, _progress) => options.emitProgress(waveIdx),
							modelRegistry: options.modelRegistry,
							settings: options.settings,
							workspaceIsolation: resolveShortleashIsolation(this.#def, agent),
							inheritHistory: resolveShortleashHistoryInheritance(this.#def, agent),
							parentMessages: options.parentMessages,
							stateTracker: this.#stateTracker,
							onFinalize:
								options.policyRegistry && this.#hasAgentPolicies(agent)
									? async (candidate: SingleResult, attempt: number) => {
											const finalized = await this.#finalizeAgent(
												options.policyRegistry!,
												agent,
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
							id: `shortleash-${this.#def.name}-${agentName}`,
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

	#hasAgentPolicies(agent: ShortleashAgent): boolean {
		return agent.checks.length > 0 || agent.evals.length > 0;
	}

	#buildAgentPolicyContext(
		wave: number,
		agentName: string,
		attempt: number,
		latestResults: ReadonlyMap<string, SingleResult>,
		history: ReadonlyMap<string, readonly SingleResult[]>,
		workspace: string,
	): ShortleashPolicyContext {
		return {
			definition: this.#def,
			cwd: workspace,
			workspace,
			shortleashDir: this.#stateTracker.shortleashDir,
			boundary: "agent",
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
		registry: ShortleashPolicyRegistry,
		agent: ShortleashAgent,
		wave: number,
		attempt: number,
		agentName: string,
		latestResults: ReadonlyMap<string, SingleResult>,
		history: ReadonlyMap<string, readonly SingleResult[]>,
		workspace: string,
		before: ReadonlyMap<string, unknown>,
		candidate: SingleResult,
	): Promise<{ feedback?: string; beforeForNextAttempt: ReadonlyMap<string, unknown> }> {
		const candidateResults = new Map(latestResults);
		candidateResults.set(agentName, candidate);
		const context = this.#buildAgentPolicyContext(wave, agentName, attempt, candidateResults, history, workspace);
		await this.#stateTracker.recordPolicyObservations(agentName, attempt, "before", before);
		const after = await registry.capture(this.#def, context, "after", agent);
		await this.#stateTracker.recordPolicyObservations(agentName, attempt, "after", after);
		const observations: ShortleashPolicyObservations = new Map(
			[...new Set([...before.keys(), ...after.keys()])].map(key => [
				key,
				{ before: before.get(key), after: after.get(key) },
			]),
		);
		const decision = await registry.evaluate(this.#def, context, agent, observations);
		await this.#stateTracker.updatePolicy(decision, { wave, agent: agentName });
		if (decision.accepted) return { beforeForNextAttempt: after };

		const nextContext = this.#buildAgentPolicyContext(
			wave,
			agentName,
			attempt + 1,
			candidateResults,
			history,
			workspace,
		);
		const beforeForNextAttempt = await registry.capture(this.#def, nextContext, "before", agent);
		await this.#stateTracker.recordPolicyObservations(agentName, attempt + 1, "before", beforeForNextAttempt);
		return {
			feedback: formatAgentPolicyFeedback(agentName, decision),
			beforeForNextAttempt,
		};
	}

	async #evaluatePolicy(
		registry: ShortleashPolicyRegistry | undefined,
		boundary: ShortleashPolicyBoundary,
		wave: number | undefined,
		latestResults: ReadonlyMap<string, SingleResult>,
		history: ReadonlyMap<string, readonly SingleResult[]>,
		options: PipelineOptions,
		scopedAgents: readonly string[],
	): Promise<ShortleashPolicyDecision | undefined> {
		if (!registry) return undefined;

		const hasGlobalPolicies = this.#def.checks.length > 0 || this.#def.evals.length > 0;
		const agentNames = [...new Set(scopedAgents)].filter(agentName => {
			const agent = this.#def.agents.get(agentName);
			return agent && (agent.checks.length > 0 || agent.evals.length > 0);
		});
		if (!hasGlobalPolicies && agentNames.length === 0) return undefined;

		const context: ShortleashPolicyContext = {
			definition: this.#def,
			cwd: options.cwd ?? options.workspace,
			params: {},
			workspace: options.workspace,
			shortleashDir: this.#stateTracker.shortleashDir,
			boundary,
			wave,
			latestResults,
			history,
			state: this.#stateTracker.state,
		};
		const decisions: ShortleashPolicyDecision[] = [];
		if (hasGlobalPolicies) decisions.push(await registry.evaluate(this.#def, context));
		for (const agentName of agentNames) {
			const agent = this.#def.agents.get(agentName);
			if (!agent) throw new Error(`Unknown Shortleash agent '${agentName}'.`);
			decisions.push(await registry.evaluate(this.#def, { ...context, agent: agentName }, agent));
		}

		const decision: ShortleashPolicyDecision = {
			boundary,
			accepted: decisions.every(item => item.accepted),
			failures: decisions.flatMap(item => item.failures),
			evaluations: decisions.flatMap(item => item.evaluations),
		};
		await this.#stateTracker.updatePolicy(decision, { wave });
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

	#buildProgressSnapshot(): Record<string, { status: AgentStatus }> {
		const snapshot: Record<string, { status: AgentStatus }> = {};
		for (const [name, agent] of Object.entries(this.#stateTracker.state.agents)) {
			snapshot[name] = { status: agent.status };
		}
		return snapshot;
	}
}

function resultFailed(result: SingleResult): boolean {
	return result.exitCode !== 0 || Boolean(result.error) || Boolean(result.aborted);
}

function loadLatestResult(records: ReadonlyArray<ShortleashResultRecord> | undefined): SingleResult | undefined {
	return records?.at(-1)?.result;
}

function makeDependencyFailureResult(definition: ShortleashDefinition, agentName: string, index: number): SingleResult {
	const error = `Skipped because a dependency failed (${definition.failurePolicy}).`;
	return {
		index,
		id: `shortleash-${definition.name}-${agentName}-skipped`,
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

function formatPolicyErrors(decision: ShortleashPolicyDecision): string[] {
	return decision.failures.map(failure => `${failure.source} ${failure.id}: ${failure.message}`);
}
function formatAgentPolicyFeedback(agentName: string, decision: ShortleashPolicyDecision): string {
	const failures = formatPolicyErrors(decision);
	return [
		`Agent '${agentName}' finalization was rejected by runtime policy.`,
		...failures.map(failure => `- ${failure}`),
		"Correct the work described by these findings, then continue working in this same session.",
	].join("\n");
}

function resolveTaskConcurrency(settings: Settings | undefined, itemCount: number): number {
	if (itemCount === 0) return 1;
	const configured = settings?.get("task.maxConcurrency");
	if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) return itemCount;
	return Math.max(1, Math.trunc(configured));
}
