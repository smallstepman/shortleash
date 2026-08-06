/**
 * Shortleash Extension — multi-agent pipeline orchestration from JSON/YAML definitions.
 * - /shortleash run <file.json|file.yaml> — Execute a swarm pipeline
 * - /shortleash status             — Show current pipeline status
 * - /shortleash reconcile <input>  — Detect Beads projection drift
 *
 * Usage: Add this extension's directory to your extensions config,
 * then use /shortleash in any oh-my-pi session.
 */
import * as fs from "node:fs/promises";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SingleResult } from "@oh-my-pi/pi-coding-agent";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { extractBeadsIssueRecords, runBeadsJson } from "./beads/client";
import { registerBeadsHooks } from "./beads/hooks";
import {
	createSwarmBeadsProjector,
	type SwarmBeadsProjector,
	type SwarmProjectionEvent,
} from "./orchestration/adapters/beads";
import { createHerdrSwarmSession } from "./orchestration/adapters/herdr";
import { createSwarmRunManifest } from "./orchestration/definition/manifest";
import { hasSwarmMetadata, validateSwarmMetadata } from "./orchestration/definition/metadata";
import { formatSwarmPlan, resolveSwarmPlan, type SwarmPlan } from "./orchestration/definition/plan";
import { fingerprintSwarmDefinition, type SwarmDefinition } from "./orchestration/definition/schema";
import { type ClaimedSwarmResult, runClaimedSwarm } from "./orchestration/execution/auto";
import { executeDirectSwarm } from "./orchestration/execution/executor";
import { PipelineController, type PipelineResult } from "./orchestration/execution/pipeline";
import { StateTracker } from "./orchestration/execution/state";
import type {
	SwarmPolicyContext,
	SwarmPolicyDecision,
	SwarmPolicyObservations,
	SwarmPolicyRegistry,
} from "./orchestration/policy/plugins";
import { attachSwarmDashboard } from "./orchestration/presentation/dashboard";
import { renderSwarmProgress } from "./orchestration/presentation/render";

interface DirectSwarmRun {
	sessionId: string;
	definition: SwarmDefinition;
	workspace: string;
	cwd: string;
	stateTracker: StateTracker;
	policyRegistry: SwarmPolicyRegistry;
	beadsProjector?: SwarmBeadsProjector;
	attempt: number;
	before: ReadonlyMap<string, unknown>;
	processing: boolean;
}

export default function shortleashExtension(pi: ExtensionAPI): void {
	const directRuns = new Map<string, DirectSwarmRun>();
	if (typeof pi.on === "function") {
		pi.on("agent_end", async (event, ctx) => {
			const run = directRuns.get(ctx.sessionManager.getSessionId());
			if (!run || event.willContinue || run.processing) return;
			run.processing = true;
			try {
				await finalizeDirectSwarm(run, event.messages, ctx, pi, directRuns);
			} catch (error) {
				directRuns.delete(run.sessionId);
				await run.stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() }).catch(() => {});
				await run.stateTracker.releaseRunLock().catch(() => {});
				ctx.ui.notify(
					`Shortleash '${run.definition.name}' direct execution failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			} finally {
				run.processing = false;
			}
		});
	}
	registerBeadsHooks(pi, {
		onClaim: (issueId, ctx, signal) =>
			runClaimedSwarm(issueId, {
				ctx,
				settings: pi.pi.settings,
				signal,
				logger: pi.logger,
				directRunner: async (plan, runOptions) => {
					if (signal.aborted) throw signal.reason;
					await startDirectSwarm(plan, ctx, pi, { resume: false, restart: runOptions.restart }, directRuns);
					return {
						status: "not-started",
						swarmName: plan.definition.name,
						reason: "Direct execution was queued in the current OMP session.",
					} satisfies ClaimedSwarmResult;
				},
			}),
	});

	const getArgumentCompletions = createShortleashArgumentCompletions(pi);
	pi.registerCommand("shortleash", {
		description: "Run a multi-agent swarm pipeline from JSON/YAML definitions",
		// The host's TUI awaits Promise-returning completions, while the extension
		// declaration currently exposes the older synchronous callback type.
		getArgumentCompletions: getArgumentCompletions as unknown as ShortleashArgumentCompletion,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0] ?? "help";

			switch (subcommand) {
				case "run": {
					const definitionPath = parts[1];
					if (!definitionPath) {
						ctx.ui.notify(
							"Usage: /shortleash run <path/to/pipeline.json|yaml|issue-id> [--resume|--restart]",
							"error",
						);
						return;
					}
					try {
						await handleRun(definitionPath, ctx, pi, parseRunOptions(parts.slice(2)), directRuns);
					} catch (err) {
						ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
					}
					return;
				}
				case "plan":
				case "inspect": {
					if (!parts[1]) {
						ctx.ui.notify(`Usage: /shortleash ${subcommand} <path/to/pipeline.json|yaml|issue-id>`, "error");
						return;
					}
					await handlePlan(parts[1], ctx, pi);
					return;
				}
				case "evaluate": {
					if (!parts[1]) {
						ctx.ui.notify("Usage: /shortleash evaluate <path/to/pipeline.json|yaml|issue-id>", "error");
						return;
					}
					await handleEvaluate(parts[1], ctx, pi, parts.includes("--json"));
					return;
				}
				case "status": {
					await handleStatus(parts[1], ctx, parts.includes("--json"));
					return;
				}
				case "reconcile": {
					if (!parts[1]) {
						ctx.ui.notify("Usage: /shortleash reconcile <path/to/pipeline.json|yaml|issue-id>", "error");
						return;
					}
					await handleReconcile(parts[1], ctx, pi, parts.includes("--json"));
					return;
				}
				default:
					ctx.ui.notify(
						[
							"Shortleash — multi-agent pipeline orchestrator",
							"  /shortleash run <path.json|yaml|issue-id> [--resume|--restart]  Run a pipeline",
							"  /shortleash plan <path.json|yaml|issue-id>                       Validate and inspect a pipeline",
							"  /shortleash status <name> [--json]                             Show persisted status",
							"  /shortleash evaluate <path.json|yaml|issue-id> [--json]        Run persisted policy evaluators",
							"  /shortleash reconcile <path.json|yaml|issue-id> [--json]       Detect Beads projection drift",
							"  Dashboard: Esc closes it; c cancels the active run",
						].join("\n"),
						"info",
					);
					return;
			}
		},
	});
}
type ShortleashCompletionItem = {
	value: string;
	label: string;
	description?: string;
};

type ShortleashArgumentCompletion = (prefix: string) => ShortleashCompletionItem[] | null;
type AsyncShortleashArgumentCompletion = (prefix: string) => Promise<ShortleashCompletionItem[] | null>;

const SHORTLEASH_SUBCOMMANDS = ["run", "plan", "inspect", "status", "evaluate", "reconcile", "help"] as const;
const SHORTLEASH_INPUT_SUBCOMMANDS = ["run", "plan", "inspect", "evaluate", "reconcile"] as const;

interface ShortleashBeadCompletion {
	id: string;
	title: string;
	name: string;
}

function createShortleashArgumentCompletions(pi: ExtensionAPI): AsyncShortleashArgumentCompletion {
	const runBeads = (args: readonly string[], signal?: AbortSignal) =>
		runBeadsJson(args, process.cwd(), signal, async (commandArgs, cwd, commandSignal) => {
			const result = await pi.exec("bd", [...commandArgs], { cwd, signal: commandSignal, timeout: 2_000 });
			if (result.code !== 0) {
				const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
				throw new Error(`bd ${commandArgs.join(" ")} failed: ${detail}`);
			}
			return result.stdout;
		});
	let cached: { expiresAt: number; items: ShortleashBeadCompletion[] } | undefined;
	let pending: Promise<ShortleashBeadCompletion[]> | undefined;

	const loadBeads = async (): Promise<ShortleashBeadCompletion[]> => {
		const now = Date.now();
		if (cached && cached.expiresAt > now) return cached.items;
		if (pending) return pending;
		pending = runBeads(["list", "--status", "open"])
			.then(result =>
				extractBeadsIssueRecords(result.data).flatMap(issue => {
					if (issue.status !== "open" || !hasSwarmMetadata(issue.metadata)) return [];
					try {
						const definition = validateSwarmMetadata(issue.metadata);
						return [
							{
								id: issue.id,
								title: issue.title?.trim() || issue.id,
								name: definition.name,
							},
						];
					} catch {
						return [];
					}
				}),
			)
			.then(items => {
				cached = { expiresAt: Date.now() + 2_000, items };
				return items;
			})
			.finally(() => {
				pending = undefined;
			});
		return pending!;
	};

	return async prefix => {
		const subcommandSuggestions = SHORTLEASH_SUBCOMMANDS.filter(command => command.startsWith(prefix)).map(
			command => ({
				label: command,
				value: command,
			}),
		);
		const trimmed = prefix.trim();
		const inputMatch = /^(run|plan|inspect|evaluate|reconcile)\s+(.*)$/.exec(prefix);
		const action = inputMatch?.[1] as (typeof SHORTLEASH_INPUT_SUBCOMMANDS)[number] | undefined;
		const query = inputMatch?.[2].trim().toLowerCase() ?? "";

		if (!action && trimmed.length > 0) return subcommandSuggestions;

		try {
			const items = await loadBeads();
			if (!action) {
				return [
					...subcommandSuggestions,
					...items.map(item => ({
						label: `${item.id} — ${item.title}`,
						value: `run issue://${item.id}`,
						description: `Run Shortleash '${item.name}'`,
					})),
				];
			}
			return items
				.filter(item => {
					const searchable = `${item.id} ${item.title} ${item.name}`.toLowerCase();
					return query.length === 0 || searchable.includes(query);
				})
				.map(item => ({
					label: `${item.id} — ${item.title}`,
					value: `${action} issue://${item.id}`,
					description: `${action[0].toUpperCase()}${action.slice(1)} Shortleash '${item.name}'`,
				}));
		} catch {
			return action ? null : subcommandSuggestions;
		}
	};
}

const MAX_DIRECT_FINALIZE_ATTEMPTS = 3;

async function startDirectSwarm(
	plan: SwarmPlan,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	runOptions: SwarmRunOptions,
	directRuns: Map<string, DirectSwarmRun>,
): Promise<void> {
	const { definition, workspace, definitionPath, pluginPaths, policyRegistry } = plan;
	const sessionId = ctx.sessionManager.getSessionId();
	if (directRuns.has(sessionId)) {
		throw new Error(`Shortleash '${definition.name}' already has a direct run in this OMP session.`);
	}

	await fs.mkdir(workspace, { recursive: true });
	const stateTracker = new StateTracker(workspace, definition.name);
	const definitionHash = fingerprintSwarmDefinition(definition);
	const manifest = await createSwarmRunManifest(definition, {
		definitionPath,
		definitionHash,
		workspace,
		pluginPaths,
		cwd: ctx.cwd,
	});
	try {
		await stateTracker.acquireRunLock(
			{ definitionHash, workspace },
			{ allowStaleRecovery: runOptions.resume || runOptions.restart },
		);
		await stateTracker.init([], definition.targetCount, definition.mode, {
			definitionHash,
			workspace,
			definitionPath,
			manifest,
			resume: runOptions.resume,
			restart: runOptions.restart,
		});
	} catch (error) {
		await stateTracker.releaseRunLock().catch(() => {});
		throw error;
	}

	const run: DirectSwarmRun = {
		sessionId,
		definition,
		workspace,
		cwd: ctx.cwd,
		stateTracker,
		policyRegistry,
		beadsProjector: plan.source.beadId ? createSwarmBeadsProjector(plan.source.beadId, ctx.cwd) : undefined,
		attempt: nextDirectAttempt(stateTracker.state),
		before: new Map(),
		processing: false,
	};
	directRuns.set(sessionId, run);
	try {
		await projectDirectRun(run, {
			type: "started",
			swarmName: definition.name,
			status: "running",
			detail: runOptions.resume ? "resumed in current OMP session" : "started in current OMP session",
		});
		const history = directHistory(stateTracker.state);
		const latestResults = new Map<string, SingleResult>();
		run.before = await captureDirectPolicies(run, "before", latestResults, history);
		await stateTracker.recordPolicyObservations("current", 0, run.attempt, "before", run.before);
		executeDirectSwarm(definition, {
			sendUserMessage: content => pi.sendUserMessage(content),
		});
		ctx.ui.notify(`Starting shortleash '${definition.name}' directly in the current OMP session.`, "info");
	} catch (error) {
		directRuns.delete(sessionId);
		await stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() }).catch(() => {});
		await stateTracker.releaseRunLock().catch(() => {});
		throw error;
	}
}

async function finalizeDirectSwarm(
	run: DirectSwarmRun,
	messages: AgentMessage[],
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	directRuns: Map<string, DirectSwarmRun>,
): Promise<void> {
	const result = directResult(run, messages);
	const iteration = 0;
	const attempt = run.attempt;
	await run.stateTracker.recordResult("current", iteration, attempt, result);
	const latestResults = new Map<string, SingleResult>([["current", result]]);
	const history = directHistory(run.stateTracker.state);
	const after = await captureDirectPolicies(run, "after", latestResults, history);
	await run.stateTracker.recordPolicyObservations("current", iteration, attempt, "after", after);
	const observations: SwarmPolicyObservations = new Map(
		[...new Set([...run.before.keys(), ...after.keys()])].map(key => [
			key,
			{ before: run.before.get(key), after: after.get(key) },
		]),
	);
	const agentDecision = await run.policyRegistry.evaluate(
		run.definition,
		directPolicyContext(run, "agent", latestResults, history, "current"),
		run.definition,
		observations,
	);
	const completeDecision = await run.policyRegistry.evaluate(
		run.definition,
		directPolicyContext(run, "complete", latestResults, history),
		run.definition,
		observations,
	);
	const decision = combineDirectDecisions(agentDecision, completeDecision);
	await run.stateTracker.updatePolicy(decision, { iteration, agent: "current" });

	if (decision.accepted) {
		directRuns.delete(run.sessionId);
		await run.stateTracker.updatePipeline({
			status: "completed",
			nextIteration: run.definition.targetCount,
			iteration,
			completedAt: Date.now(),
		});
		await projectDirectRun(run, {
			type: "completed",
			swarmName: run.definition.name,
			status: "completed",
			detail: "direct current-session execution accepted",
		});
		await run.stateTracker.releaseRunLock();
		ctx.ui.notify(`Shortleash '${run.definition.name}' completed in the current OMP session.`, "info");
		return;
	}

	if (attempt >= MAX_DIRECT_FINALIZE_ATTEMPTS) {
		directRuns.delete(run.sessionId);
		await run.stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
		await projectDirectRun(run, {
			type: "blocked",
			swarmName: run.definition.name,
			status: "failed",
			detail: `direct policy rejected after ${attempt} corrective attempts`,
		});
		await run.stateTracker.releaseRunLock();
		ctx.ui.notify(
			`Shortleash '${run.definition.name}' was blocked by direct-session policy after ${attempt} corrective attempts.`,
			"error",
		);
		return;
	}

	run.attempt = attempt + 1;
	run.before = await captureDirectPolicies(run, "before", latestResults, history);
	await run.stateTracker.recordPolicyObservations("current", iteration, run.attempt, "before", run.before);
	pi.sendUserMessage(formatDirectPolicyFeedback(decision), { deliverAs: "followUp" });
}

async function captureDirectPolicies(
	run: DirectSwarmRun,
	phase: "before" | "after",
	latestResults: ReadonlyMap<string, SingleResult>,
	history: ReadonlyMap<string, readonly SingleResult[]>,
): Promise<ReadonlyMap<string, unknown>> {
	const snapshots = new Map<string, unknown>();
	for (const context of [
		directPolicyContext(run, "agent", latestResults, history, "current"),
		directPolicyContext(run, "complete", latestResults, history),
	]) {
		const captured = await run.policyRegistry.capture(run.definition, context, phase, run.definition);
		for (const [key, value] of captured) snapshots.set(key, value);
	}
	return snapshots;
}

function directPolicyContext(
	run: DirectSwarmRun,
	boundary: "agent" | "complete",
	latestResults: ReadonlyMap<string, SingleResult>,
	history: ReadonlyMap<string, readonly SingleResult[]>,
	agent?: string,
): SwarmPolicyContext {
	const context: SwarmPolicyContext = {
		definition: run.definition,
		cwd: run.cwd,
		workspace: run.workspace,
		swarmDir: run.stateTracker.swarmDir,
		boundary,
		iteration: 0,
		attempt: run.attempt,
		params: {},
		latestResults,
		history,
		state: run.stateTracker.state,
	};
	if (agent !== undefined) context.agent = agent;
	return context;
}

function directHistory(
	state: Readonly<{ results: Record<string, { result: SingleResult }[]> }>,
): Map<string, readonly SingleResult[]> {
	return new Map(
		Object.entries(state.results).map(([agent, records]) => [agent, records.map(record => record.result)]),
	);
}

function nextDirectAttempt(state: Readonly<{ results: Record<string, { attempt: number }[]> }>): number {
	return Math.max(-1, ...(state.results.current ?? []).map(record => record.attempt)) + 1;
}

async function projectDirectRun(run: DirectSwarmRun, event: SwarmProjectionEvent): Promise<void> {
	if (!run.beadsProjector) return;
	try {
		await run.beadsProjector.project(event);
		await run.stateTracker.recordProjection(run.beadsProjector.targetId, event.type, event.status, event.detail);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await run.stateTracker.recordProjection(
			run.beadsProjector.targetId,
			event.type,
			event.status,
			event.detail,
			message,
		);
		await run.stateTracker.appendOrchestratorLog(`Beads projection failed: ${message}`);
	}
}

function combineDirectDecisions(agent: SwarmPolicyDecision, complete: SwarmPolicyDecision): SwarmPolicyDecision {
	const hasCompletePolicies = complete.failures.length > 0 || complete.evaluations.length > 0;
	return {
		boundary: hasCompletePolicies ? "complete" : agent.boundary,
		accepted: agent.accepted && complete.accepted,
		failures: [...agent.failures, ...complete.failures],
		evaluations: [...agent.evaluations, ...complete.evaluations],
	};
}

function directResult(run: DirectSwarmRun, messages: AgentMessage[]): SingleResult {
	const assistant = [...messages].reverse().find(message => message.role === "assistant");
	return {
		index: 0,
		id: `shortleash-${run.definition.name}-current-${run.attempt}`,
		agent: "current",
		agentSource: "project",
		task: run.definition.task ?? `Execute Shortleash '${run.definition.name}' directly.`,
		exitCode: 0,
		output: assistant ? agentMessageText(assistant) : "",
		stderr: "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
	};
}

function agentMessageText(message: AgentMessage): string {
	const content = isRecord(message) ? message.content : undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (!isRecord(block)) return "";
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function formatDirectPolicyFeedback(decision: SwarmPolicyDecision): string {
	const failures = decision.failures.map(failure => `- ${failure.source} ${failure.id}: ${failure.message}`);
	return [
		"The Shortleash runtime rejected the current-session finalization.",
		"Continue in this same OMP session and resolve every reported policy failure before finishing again.",
		...failures,
	].join("\n");
}

// ============================================================================
// /shortleash run
// ============================================================================

interface SwarmRunOptions {
	resume: boolean;
	restart: boolean;
}

function parseRunOptions(args: string[]): SwarmRunOptions {
	const resume = args.includes("--resume");
	const restart = args.includes("--restart");
	if (resume && restart) throw new Error("--resume and --restart cannot be used together.");
	const unknown = args.filter(arg => arg !== "--resume" && arg !== "--restart");
	if (unknown.length > 0) throw new Error(`Unknown shortleash run option '${unknown[0]}'.`);
	return { resume, restart };
}

async function handleRun(
	input: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	runOptions: SwarmRunOptions,
	directRuns: Map<string, DirectSwarmRun>,
): Promise<void> {
	let plan: SwarmPlan;
	try {
		plan = await resolveSwarmPlan(input, ctx.cwd, { logger: pi.logger });
	} catch (err) {
		ctx.ui.notify(
			`Cannot prepare shortleash '${input}': ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
		return;
	}
	const { definition: def, workspace, waves, definitionPath, pluginPaths, policyRegistry } = plan;
	if (def.agents.size === 0) {
		try {
			await startDirectSwarm(plan, ctx, pi, runOptions, directRuns);
		} catch (error) {
			ctx.ui.notify(
				`Cannot start direct shortleash '${def.name}': ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		return;
	}
	await fs.mkdir(workspace, { recursive: true });
	const beadsProjector = plan.source.beadId ? createSwarmBeadsProjector(plan.source.beadId, ctx.cwd) : undefined;
	const stateTracker = new StateTracker(workspace, def.name);
	const definitionHash = fingerprintSwarmDefinition(def);
	const manifest = await createSwarmRunManifest(def, {
		definitionPath,
		definitionHash,
		workspace,
		pluginPaths,
		cwd: ctx.cwd,
	});
	try {
		await stateTracker.acquireRunLock(
			{ definitionHash, workspace },
			{ allowStaleRecovery: runOptions.resume || runOptions.restart },
		);
		await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode, {
			definitionHash,
			workspace,
			definitionPath,
			manifest,
			resume: runOptions.resume,
			restart: runOptions.restart,
		});
	} catch (err) {
		await stateTracker.releaseRunLock().catch(() => {});
		ctx.ui.notify(
			`Cannot start shortleash '${def.name}': ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
		return;
	}

	// 7. Log start
	const agentList = [...def.agents.keys()].join(", ");
	const waveDesc = waves.map((w, i) => `wave ${i + 1}: [${w.join(", ")}]`).join("; ");
	pi.logger.debug("Shortleash starting", {
		name: def.name,
		mode: def.mode,
		agents: agentList,
		waves: waveDesc,
		workspace,
	});

	ctx.ui.notify(
		`Starting shortleash '${def.name}': ${def.agents.size} agents, ${waves.length} waves, ${def.targetCount} iteration(s)`,
		"info",
	);

	// 8. Attach the compact below-editor widget and the interactive dashboard.
	const runAbortController = new AbortController();
	const dashboard = attachSwarmDashboard(ctx, def, stateTracker, () => {
		runAbortController.abort(new Error("Cancelled from the Shortleash dashboard."));
	});

	// 9. Run declared agents through configured backend; Herdr falls back in-process when unavailable.
	const controller = new PipelineController(def, waves, stateTracker);
	let result: PipelineResult;
	let herdrSession: Awaited<ReturnType<typeof createHerdrSwarmSession>>;
	const parentMessages = ctx.sessionManager
		.getBranch()
		.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
	try {
		herdrSession =
			def.agentExecution === "herdr"
				? await createHerdrSwarmSession({
						definition: def,
						definitionInput: definitionPath,
						workspace,
						cwd: ctx.cwd,
						logger: pi.logger,
					})
				: undefined;
		result = await controller.run({
			workspace,
			cwd: ctx.cwd,
			signal: runAbortController.signal,
			resume: runOptions.resume,
			onProgress: () => dashboard.update(),
			modelRegistry: ctx.modelRegistry,
			settings: pi.pi.settings,
			parentMessages,
			policyRegistry,
			beadsProjector,
			agentRunner: herdrSession?.runAgent,
		});
	} finally {
		await dashboard.dispose();
		await herdrSession?.dispose();
		await stateTracker.releaseRunLock();
	}
	const elapsed = stateTracker.state.completedAt
		? formatDuration(stateTracker.state.completedAt - stateTracker.state.startedAt)
		: "unknown";

	const summaryParts = [
		`Shortleash '${def.name}' ${result.status}`,
		`${result.iterations}/${def.targetCount} iterations`,
		`elapsed: ${elapsed}`,
	];

	if (result.errors.length > 0) {
		summaryParts.push(`${result.errors.length} error(s)`);
	}

	const summaryType = result.status === "completed" ? "info" : "error";
	ctx.ui.notify(summaryParts.join(" | "), summaryType);

	// Log errors
	if (result.errors.length > 0) {
		pi.logger.warn("Shortleash completed with errors", { errors: result.errors });
	}

	// 11. Send summary to the conversation so the LLM knows what happened
	const summaryMessage = buildSummaryMessage(def, result, stateTracker, workspace);
	pi.sendMessage(
		{
			customType: "swarm-result",
			content: [{ type: "text", text: summaryMessage }],
			display: true,
			details: {
				swarmName: def.name,
				status: result.status,
				iterations: result.iterations,
				errorCount: result.errors.length,
			},
		},
		{ triggerTurn: false },
	);
}

// ============================================================================
// /shortleash plan, status, evaluate, and reconcile
// ============================================================================

async function handlePlan(input: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	try {
		const plan = await resolveSwarmPlan(input, ctx.cwd, { logger: pi.logger });
		ctx.ui.notify(formatSwarmPlan(plan).join("\n"), "info");
	} catch (err) {
		ctx.ui.notify(
			`Cannot inspect shortleash '${input}': ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

async function handleStatus(name: string | undefined, ctx: ExtensionCommandContext, json: boolean): Promise<void> {
	if (!name) {
		ctx.ui.notify("Usage: /shortleash status <name>  (reads .swarm_<name>/state/pipeline.json from cwd)", "info");
		return;
	}

	const stateTracker = new StateTracker(ctx.cwd, name);
	try {
		const state = await stateTracker.load();
		if (!state) {
			ctx.ui.notify(`No state found for shortleash '${name}' in ${ctx.cwd}`, "error");
			return;
		}
		ctx.ui.notify(json ? JSON.stringify(state, null, 2) : renderSwarmProgress(state).join("\n"), "info");
	} catch (err) {
		ctx.ui.notify(
			`Cannot read shortleash state '${name}': ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

async function handleEvaluate(
	input: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	json: boolean,
): Promise<void> {
	try {
		const plan = await resolveSwarmPlan(input, ctx.cwd, { logger: pi.logger });
		const definitionHash = fingerprintSwarmDefinition(plan.definition);
		const stateTracker = new StateTracker(plan.workspace, plan.definition.name);
		await stateTracker.acquireRunLock({ definitionHash, workspace: plan.workspace });
		try {
			const state = await stateTracker.load();
			if (!state) {
				ctx.ui.notify(`No state found for shortleash '${plan.definition.name}' in ${plan.workspace}`, "error");
				return;
			}
			assertDefinitionHash(state.definitionHash, definitionHash, plan.definition.name);
			const latestResults = new Map<string, SingleResult>();
			const history = new Map<string, readonly SingleResult[]>();
			for (const [agentName, records] of Object.entries(state.results)) {
				const results = records.map(record => record.result);
				history.set(agentName, results);
				const latest = results.at(-1);
				if (latest) latestResults.set(agentName, latest);
			}
			const iteration = Math.max(0, state.nextIteration - 1);
			const decision = await plan.policyRegistry.evaluate(plan.definition, {
				definition: plan.definition,
				cwd: ctx.cwd,
				workspace: plan.workspace,
				swarmDir: stateTracker.swarmDir,
				boundary: "complete",
				iteration,
				params: {},
				latestResults,
				history,
				state,
			});
			await stateTracker.updatePolicy(decision, { iteration });
			const message = json
				? JSON.stringify(decision, null, 2)
				: [
						`Evaluation: ${decision.accepted ? "accepted" : "blocked"}`,
						...decision.evaluations.map(
							evaluation =>
								`  ${evaluation.id}@${evaluation.version}: ${evaluation.outcome} — ${evaluation.explanation}`,
						),
						...decision.failures.map(failure => `  ${failure.source} ${failure.id}: ${failure.message}`),
					].join("\n");
			ctx.ui.notify(message, decision.accepted ? "info" : "warning");
		} finally {
			await stateTracker.releaseRunLock();
		}
	} catch (err) {
		ctx.ui.notify(
			`Cannot evaluate shortleash '${input}': ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

async function handleReconcile(
	input: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	json: boolean,
): Promise<void> {
	try {
		const plan = await resolveSwarmPlan(input, ctx.cwd, { logger: pi.logger });
		if (!plan.source.beadId) {
			ctx.ui.notify("Reconciliation requires a Beads issue ID or issue:// reference.", "error");
			return;
		}
		const definitionHash = fingerprintSwarmDefinition(plan.definition);
		const stateTracker = new StateTracker(plan.workspace, plan.definition.name);
		const state = await stateTracker.load();
		if (!state) {
			ctx.ui.notify(`No state found for shortleash '${plan.definition.name}' in ${plan.workspace}`, "error");
			return;
		}
		assertDefinitionHash(state.definitionHash, definitionHash, plan.definition.name);
		const reconciliation = await createSwarmBeadsProjector(plan.source.beadId, ctx.cwd).reconcile(state.status);
		const message = json
			? JSON.stringify(reconciliation, null, 2)
			: [
					`Bead: ${reconciliation.beadId}`,
					`Authoritative status: ${reconciliation.authoritativeStatus}`,
					`Bead status: ${reconciliation.beadStatus ?? "unknown"}`,
					`Drift: ${reconciliation.drift ? "yes" : "no"}`,
					...(reconciliation.reason ? [`Reason: ${reconciliation.reason}`] : []),
				].join("\n");
		ctx.ui.notify(message, reconciliation.drift ? "warning" : "info");
	} catch (err) {
		ctx.ui.notify(
			`Cannot reconcile shortleash '${input}': ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

// ============================================================================
// Helpers

// ============================================================================
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertDefinitionHash(actual: string, expected: string, name: string): void {
	if (actual !== "unknown" && actual !== "legacy" && actual !== expected) {
		throw new Error(`Persisted state for shortleash '${name}' was created from a different definition.`);
	}
}

function buildSummaryMessage(
	def: SwarmDefinition,
	result: Pick<PipelineResult, "status" | "iterations" | "errors">,
	stateTracker: StateTracker,
	workspace: string,
): string {
	const lines: string[] = [];
	lines.push(`## Shortleash Pipeline: ${def.name}`);
	lines.push("");
	lines.push(`- **Status**: ${result.status}`);
	lines.push(`- **Mode**: ${def.mode}`);
	lines.push(`- **Iterations**: ${result.iterations}/${def.targetCount}`);
	lines.push(`- **Workspace**: ${workspace}`);
	lines.push(`- **State dir**: ${stateTracker.swarmDir}`);
	lines.push("");

	lines.push("### Agent Results");
	lines.push("");
	for (const [name, agent] of Object.entries(stateTracker.state.agents)) {
		const duration =
			agent.startedAt && agent.completedAt ? formatDuration(agent.completedAt - agent.startedAt) : "n/a";
		lines.push(`- **${name}**: ${agent.status} (${duration})${agent.error ? ` — ${agent.error}` : ""}`);
	}

	if (result.errors.length > 0) {
		lines.push("");
		lines.push("### Errors");
		lines.push("");
		for (const error of result.errors) {
			lines.push(`- ${error}`);
		}
	}

	return lines.join("\n");
}
