/**
 * Shortleash agent execution through oh-my-pi's structured subagent infrastructure.
 *
 * OMP owns agent discovery, session construction, tool policy, and isolation;
 * Shortleash owns graph scheduling, policy evaluation, persistence, and retries.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import type { AgentProgress, ModelRegistry, SingleResult } from "@oh-my-pi/pi-coding-agent";
import { runSubagentFollowUpTurn } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	runStructuredSubagent,
	type StructuredSubagentResult,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ShortleashAgent, ShortleashDefinition, ShortleashIsolationMode } from "../definition/schema";
import type {
	ShortleashPolicyJudge,
	ShortleashPolicyJudgeRequest,
	ShortleashPolicyJudgeResult,
} from "../policy/policies";
import type { StateTracker } from "./state";

export interface ShortleashExecutorOptions {
	workspace: string;
	shortleashName: string;
	modelOverride?: string;
	signal?: AbortSignal;
	onProgress?: (agentName: string, progress: AgentProgress) => void;
	modelRegistry?: ModelRegistry;
	/** Isolate this worker in a host-managed copy-on-write worktree. */
	workspaceIsolation?: ShortleashIsolationMode;
	/** Copy the current parent OMP branch into the worker's session before its task. */
	inheritHistory?: boolean;
	/** Parent branch messages supplied by the interactive extension adapter. */
	parentMessages?: AgentMessage[];
	settings?: Settings;
	stateTracker: StateTracker;
	/** Return corrective feedback when the agent's finalization attempt is rejected. */
	onFinalize?: (result: SingleResult, attempt: number) => Promise<string | undefined>;
	/** Number of corrective turns allowed after a rejected finalization. */
	maxFinalizeAttempts?: number;
}

function isPersistableMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function safeSessionDirectoryName(value: string): string {
	const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
	return sanitized || "agent";
}

async function createChildSessionFile(
	workspace: string,
	sessionDirectory: string,
	messages: readonly AgentMessage[],
): Promise<string> {
	await fs.mkdir(sessionDirectory, { recursive: true });
	const manager = SessionManager.create(workspace, sessionDirectory);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) {
		await manager.close();
		throw new Error("Structured Shortleash execution could not create a durable child session.");
	}
	try {
		for (const message of messages.filter(isPersistableMessage)) {
			manager.appendMessage(structuredClone(message));
		}
		await manager.ensureOnDisk();
		await manager.flush();
		return sessionFile;
	} finally {
		await manager.close();
	}
}

async function createWorkerSettings(
	settings: Settings | undefined,
	workspace: string,
	workspaceIsolation: ShortleashIsolationMode | undefined,
): Promise<Settings> {
	const workerSettings = settings ? await settings.cloneForCwd(workspace) : Settings.isolated();
	if (workspaceIsolation === "worktree") {
		// The native isolation API selects the concrete copy-on-write backend from
		// "auto"; Shortleash's worktree mode remains the user-facing abstraction.
		workerSettings.override("task.isolation.mode", "auto");
		workerSettings.override("task.isolation.merge", "patch");
		workerSettings.override("task.isolation.apply", true);
	}
	return workerSettings;
}

function createChildToolSession(options: {
	workspace: string;
	modelOverride?: string;
	modelRegistry?: ModelRegistry;
	settings: Settings;
	sessionFile: string;
}): ToolSession {
	const artifactsDir = options.sessionFile.slice(0, -".jsonl".length);
	return {
		cwd: options.workspace,
		hasUI: false,
		suppressSpawnAdvisory: true,
		enableLsp: false,
		enableIrc: false,
		enableMCP: false,
		getSessionFile: () => options.sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		getModelString: () => options.modelOverride,
		getActiveModelString: () => options.modelOverride,
		modelRegistry: options.modelRegistry,
		settings: options.settings,
	};
}

function createWorkerToolSession(
	options: ShortleashExecutorOptions,
	settings: Settings,
	sessionFile: string,
): ToolSession {
	return createChildToolSession({
		workspace: options.workspace,
		modelOverride: options.modelOverride,
		modelRegistry: options.modelRegistry,
		settings,
		sessionFile,
	});
}

export interface ShortleashPolicyJudgeOptions {
	workspace: string;
	shortleashDir: string;
	shortleashName: string;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	/** Optional parent branch copied into each judge's durable child session. */
	parentMessages?: AgentMessage[];
	/** Default model selector used when a request does not specify one. */
	model?: string;
	/** Default agent definition used when a request does not specify one. */
	agent?: string;
	signal?: AbortSignal;
}

/**
 * Create a host-backed policy judge that uses the current OMP provider setup
 * without re-entering the current conversation.
 */
export function createShortleashPolicyJudge(options: ShortleashPolicyJudgeOptions): ShortleashPolicyJudge {
	let invocation = 0;
	return async <T = unknown>(request: ShortleashPolicyJudgeRequest): Promise<ShortleashPolicyJudgeResult<T>> => {
		if (request.outputSchema === undefined) {
			throw new Error("Shortleash policy judges require an output schema.");
		}
		const sequence = ++invocation;
		const judgeId = `shortleash-${safeSessionDirectoryName(options.shortleashName)}-policy-judge-${Date.now()}-${sequence}`;
		const sessionDirectory = path.join(
			options.shortleashDir,
			"context",
			"policy-judges",
			safeSessionDirectoryName(judgeId),
		);
		const sessionFile = await createChildSessionFile(
			options.workspace,
			sessionDirectory,
			options.parentMessages ?? [],
		);
		const settings = await createWorkerSettings(options.settings, options.workspace, undefined);
		const model = request.model ?? options.model;
		const session = createChildToolSession({
			workspace: options.workspace,
			modelOverride: model,
			modelRegistry: options.modelRegistry,
			settings,
			sessionFile,
		});
		const execution = await runStructuredSubagent({
			session,
			invocationKind: "eval",
			assignment: request.prompt,
			context:
				"You are a Shortleash policy judge. Review evidence without modifying the workspace and return only the requested structured verdict.",
			agent: request.agent ?? options.agent ?? "reviewer",
			...(model !== undefined ? { model } : {}),
			outputSchema: request.outputSchema,
			schemaMode: request.schemaMode ?? "strict",
			identity: { id: judgeId, label: `Shortleash policy judge ${sequence}` },
			keepAlive: false,
			retainArtifacts: true,
			shareEvalSession: false,
			enableLsp: false,
			enableIrc: false,
			signal: request.signal ?? options.signal,
		});
		const { result, artifactsDir } = execution;
		if (result.exitCode !== 0 || result.error || result.aborted) {
			throw new Error(
				`Shortleash policy judge failed: ${result.error ?? result.abortReason ?? result.stderr ?? `exit code ${result.exitCode}`}`,
			);
		}
		const structuredOutput = result.structuredOutput;
		if (structuredOutput?.status !== "valid" || !Object.hasOwn(structuredOutput, "data")) {
			throw new Error(
				`Shortleash policy judge returned invalid structured output${structuredOutput?.error ? `: ${structuredOutput.error}` : "."}`,
			);
		}

		const evidenceDirectory = path.join(options.shortleashDir, "context", "policy-judges");
		await fs.mkdir(evidenceDirectory, { recursive: true });
		const evidencePath = path.join(evidenceDirectory, `${safeSessionDirectoryName(judgeId)}.json`);
		await fs.writeFile(
			evidencePath,
			JSON.stringify(
				{
					type: "shortleash-policy-judge",
					createdAt: new Date().toISOString(),
					id: result.id,
					agent: result.agent,
					model: result.resolvedModel ?? model,
					request: {
						prompt: request.prompt,
						outputSchema: request.outputSchema,
						schemaMode: request.schemaMode ?? "strict",
					},
					response: {
						data: structuredOutput.data,
						output: result.output,
						structuredOutput,
						artifactsDir,
					},
				},
				null,
				2,
			),
		);

		return {
			data: structuredOutput.data as T,
			result,
			evidenceRef: `shortleash://${path.relative(options.shortleashDir, evidencePath).split(path.sep).join("/")}`,
		};
	};
}

function normalizeShortleashResult(result: SingleResult, agentName: string): SingleResult {
	return result.agent === agentName ? result : { ...result, agent: agentName };
}

function applyStructuredMergeResult(execution: StructuredSubagentResult, agentName: string): SingleResult {
	const { result: rawResult, mergeSummary, changesApplied } = execution;
	const result = normalizeShortleashResult(rawResult, agentName);
	if (!mergeSummary) return result;
	const output = result.output ? `${result.output}\n${mergeSummary}` : mergeSummary;
	if (changesApplied === false) {
		const error = result.error ?? "Isolation merge failed; changes were not applied.";
		return {
			...result,
			exitCode: 1,
			output,
			stderr: result.stderr ? `${result.stderr}\n${mergeSummary}` : mergeSummary,
			error,
		};
	}
	return { ...result, output };
}

/**
 * Execute a single Shortleash agent through OMP's structured subagent API.
 *
 * Shortleash still owns graph scheduling, policy evaluation, persistence, and
 * corrective feedback. OMP owns agent discovery, session construction, tool
 * policy, output finalization, and optional workspace isolation.
 */
export async function executeShortleashAgent(
	agent: ShortleashAgent,
	index: number,
	options: ShortleashExecutorOptions,
): Promise<SingleResult> {
	const { workspace, shortleashName, modelOverride, signal, settings, stateTracker } = options;
	const agentId = `shortleash-${shortleashName}-${agent.name}`;
	const sessionDirectory = path.join(stateTracker.shortleashDir, "context", safeSessionDirectoryName(agentId));

	const handleProgress = (progress: AgentProgress): void => {
		void stateTracker.updateAgent(agent.name, {
			currentTool: progress.currentTool,
			currentToolArgs: progress.currentToolArgs,
			recentTools: progress.recentTools.slice(0, 5).map(tool => ({ ...tool })),
			lastIntent: progress.lastIntent,
		});
		options.onProgress?.(agent.name, progress);
	};

	await stateTracker.updateAgent(agent.name, {
		status: "running",
		startedAt: Date.now(),
	});
	await stateTracker.appendLog(agent.name, "Starting agent");

	try {
		if (options.inheritHistory && options.parentMessages === undefined) {
			throw new Error("Parent history inheritance requires an interactive OMP session.");
		}
		const sessionFile = await createChildSessionFile(
			workspace,
			sessionDirectory,
			options.inheritHistory ? (options.parentMessages ?? []) : [],
		);
		const workerSettings = await createWorkerSettings(settings, workspace, options.workspaceIsolation);
		const workerSession = createWorkerToolSession(options, workerSettings, sessionFile);
		const isolation =
			options.workspaceIsolation === "worktree"
				? { requested: true, merge: "patch" as const, apply: true }
				: undefined;
		const initialExecution = await runStructuredSubagent({
			session: workerSession,
			invocationKind: "task",
			assignment: agent.task,
			context: buildAgentContext(agent),
			agent: agent.agent,
			model: modelOverride,
			identity: { id: agentId, label: agent.name },
			index,
			isolation,
			retainArtifacts: true,
			keepAlive: true,
			enableLsp: false,
			enableIrc: false,
			signal,
			onProgress: handleProgress,
		});

		const recordResult = async (result: SingleResult, attempt: number): Promise<void> => {
			const status = result.exitCode === 0 ? ("completed" as const) : ("failed" as const);
			await stateTracker.updateAgent(agent.name, {
				status,
				attempt,
				completedAt: Date.now(),
				error: result.error,
			});
			await stateTracker.recordResult(agent.name, attempt, result);
			await stateTracker.appendLog(
				agent.name,
				`Attempt ${attempt} ${status}${result.error ? `: ${result.error}` : ""}`,
			);
		};

		let result = applyStructuredMergeResult(initialExecution, agent.name);
		await recordResult(result, 0);
		const maxFinalizeAttempts = Math.max(0, Math.trunc(options.maxFinalizeAttempts ?? 3));
		const followUpSchema =
			initialExecution.policy.schema.source === "none"
				? {}
				: {
						outputSchema: initialExecution.policy.schema.schema,
						outputSchemaMode: initialExecution.policy.schema.mode,
						outputSchemaSource: initialExecution.policy.schema.source,
					};
		const retrySchema =
			initialExecution.policy.schema.source !== "caller"
				? {}
				: {
						outputSchema: initialExecution.policy.schema.schema,
						schemaMode: initialExecution.policy.schema.mode,
					};
		let lastFeedback: string | undefined;
		for (let attempt = 0; attempt < maxFinalizeAttempts; attempt++) {
			const feedback = await options.onFinalize?.(result, attempt);
			if (!feedback) return result;
			lastFeedback = feedback;

			await stateTracker.updateAgent(agent.name, {
				status: "running",
				error: undefined,
			});
			await stateTracker.appendLog(
				agent.name,
				`Finalization rejected; continuing with corrective feedback (attempt ${attempt + 1})`,
			);
			if (options.workspaceIsolation === "worktree") {
				// OMP intentionally parks isolated sessions after each turn. Reopen
				// the same child journal in a fresh isolated turn so corrections
				// retain the full transcript and still merge their patch.
				const retryExecution = await runStructuredSubagent({
					session: workerSession,
					invocationKind: "task",
					assignment: feedback,
					context: buildAgentContext(agent),
					agent: agent.agent,
					model: modelOverride,
					identity: { id: `${agentId}-retry-${attempt + 1}`, label: agent.name },
					index,
					isolation,
					...retrySchema,
					retainArtifacts: true,
					keepAlive: false,
					enableLsp: false,
					enableIrc: false,
					signal,
					onProgress: handleProgress,
				});
				result = applyStructuredMergeResult(retryExecution, agent.name);
			} else {
				const followUpResult = await runSubagentFollowUpTurn({
					id: agentId,
					agent: initialExecution.policy.effectiveAgent,
					message: feedback,
					index,
					signal,
					onProgress: handleProgress,
					artifactsDir: initialExecution.artifactsDir,
					...followUpSchema,
				});
				result = normalizeShortleashResult(followUpResult, agent.name);
			}
			await recordResult(result, attempt + 1);
		}

		if (lastFeedback) {
			throw new Error(
				`Agent finalization rejected after ${maxFinalizeAttempts} corrective attempts.\n${lastFeedback}`,
			);
		}
		return result;
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		await stateTracker.updateAgent(agent.name, {
			status: "failed",
			completedAt: Date.now(),
			error,
		});
		await stateTracker.appendLog(agent.name, `Agent error: ${error}`);
		throw err;
	}
}

function buildAgentContext(agent: ShortleashAgent): string {
	const parts = [`You are a ${agent.role}.`];
	if (agent.extraContext) {
		parts.push(agent.extraContext);
	}
	return parts.join("\n\n");
}

export interface ShortleashDirectMessageSender {
	sendUserMessage(content: string): void;
}

/** Build the prompt that keeps a no-agent definition in the current OMP session. */
export function buildDirectShortleashPrompt(definition: ShortleashDefinition): string {
	const task =
		definition.task ??
		`Continue the current objective in the '${definition.name}' Shortleash definition and leave the workspace ready for validation.`;
	const policyRefs = [
		...definition.checks.map(reference => `check:${formatPolicyReference(reference)}`),
		...definition.evals.map(reference => `eval:${formatPolicyReference(reference)}`),
	];
	return [
		`Execute Shortleash '${definition.name}' directly in this current OMP session.`,
		`Work in ${definition.workspace}. Do not spawn a subagent for this definition.`,
		task,
		...(policyRefs.length > 0
			? [`Runtime policy references (the extension evaluates these outside your response): ${policyRefs.join(", ")}`]
			: []),
		"Report the changes, evidence, and any blockers when the work is complete.",
	].join("\n\n");
}

/** Queue direct execution through the host session instead of the subagent runner. */
export function executeDirectShortleash(definition: ShortleashDefinition, sender: ShortleashDirectMessageSender): void {
	if (definition.agents.size > 0) {
		throw new Error("Direct Shortleash execution requires a definition without agents.");
	}
	sender.sendUserMessage(buildDirectShortleashPrompt(definition));
}

function formatPolicyReference(reference: unknown): string {
	if (typeof reference === "string") return reference;
	if (reference && typeof reference === "object" && "path" in reference) {
		return String(reference.path);
	}
	return String(reference);
}
