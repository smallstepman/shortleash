/**
 * Swarm agent execution via oh-my-pi's subagent infrastructure.
 *
 * Wraps `runSubprocess` to spawn individual swarm agents with full tool access.
 * Each agent runs in the swarm workspace with its task instructions as the user prompt.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import type {
	AgentDefinition,
	AgentProgress,
	AgentSource,
	ModelRegistry,
	Settings,
	SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	applyEligibleNestedPatches,
	mergeIsolatedChanges,
	prepareIsolationContext,
	runIsolatedSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { parseIsolationMode } from "@oh-my-pi/pi-coding-agent/task/worktree";
import type { SwarmAgent, SwarmDefinition, SwarmIsolationMode } from "./schema";
import type { StateTracker } from "./state";

export interface SwarmExecutorOptions {
	workspace: string;
	swarmName: string;
	iteration: number;
	modelOverride?: string;
	signal?: AbortSignal;
	onProgress?: (agentName: string, progress: AgentProgress) => void;
	modelRegistry?: ModelRegistry;
	/** Isolate this worker in a host-managed copy-on-write worktree. */
	workspaceIsolation?: SwarmIsolationMode;
	/** Copy the current parent OMP branch into the worker's session before its task. */
	inheritHistory?: boolean;
	/** Parent branch messages supplied by the interactive extension adapter. */
	parentMessages?: AgentMessage[];
	settings?: Settings;
	stateTracker: StateTracker;
	/** Return corrective feedback when the agent's finalization attempt is rejected. */
	onFinalize?: (result: SingleResult, attempt: number) => Promise<string | undefined>;
	/** Number of same-session follow-up turns allowed after a rejected finalization. */
	maxFinalizeAttempts?: number;
}
export type SwarmAgentRunner = (
	agent: SwarmAgent,
	index: number,
	options: SwarmExecutorOptions,
) => Promise<SingleResult>;

const isolationMergeTails = new Map<string, Promise<void>>();

async function withIsolationMergeLock<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
	const previous = isolationMergeTails.get(repoRoot) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const queued = previous.then(() => gate);
	isolationMergeTails.set(repoRoot, queued);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (isolationMergeTails.get(repoRoot) === queued) isolationMergeTails.delete(repoRoot);
	}
}
function isPersistableMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

async function materializeParentHistory(
	workspace: string,
	artifactsDir: string,
	messages: readonly AgentMessage[],
): Promise<string | undefined> {
	const persistableMessages = messages.filter(isPersistableMessage);
	if (persistableMessages.length === 0) return undefined;
	await fs.mkdir(artifactsDir, { recursive: true });
	const manager = SessionManager.create(workspace, artifactsDir);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) {
		await manager.close();
		throw new Error("Parent history inheritance could not create a durable child session.");
	}
	try {
		for (const message of persistableMessages) {
			manager.appendMessage(structuredClone(message));
		}
		await manager.ensureOnDisk();
		await manager.flush();
		return sessionFile;
	} finally {
		await manager.close();
	}
}

function makeIsolationFailureResult(
	agent: AgentDefinition,
	index: number,
	id: string,
	task: string,
	error: unknown,
): SingleResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: 1,
		output: "",
		stderr: message,
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		error: message,
	};
}

async function runWorker(
	baseOptions: Parameters<typeof runSubprocess>[0],
	agent: AgentDefinition,
	index: number,
	id: string,
	task: string,
	workspaceIsolation: SwarmIsolationMode | undefined,
): Promise<SingleResult> {
	if (workspaceIsolation !== "worktree") return runSubprocess(baseOptions);

	const context = await prepareIsolationContext(baseOptions.cwd);
	const result = await runIsolatedSubprocess({
		baseOptions,
		context,
		preferredBackend: parseIsolationMode("worktree"),
		agentId: id,
		mergeMode: "patch",
		artifactsDir: baseOptions.artifactsDir ?? path.join(baseOptions.cwd, ".swarm-context"),
		description: baseOptions.description,
		buildFailureResult: error => makeIsolationFailureResult(agent, index, id, task, error),
	});
	if (result.exitCode !== 0 || result.error || result.aborted) return result;

	const mergeOutcome = await withIsolationMergeLock(context.repoRoot, () =>
		mergeIsolatedChanges({
			result,
			repoRoot: context.repoRoot,
			mergeMode: "patch",
		}),
	);
	let mergeSummary = mergeOutcome.summary;
	if (mergeOutcome.changesApplied !== false) {
		mergeSummary += await applyEligibleNestedPatches({
			result,
			repoRoot: context.repoRoot,
			mergeMode: "patch",
			changesApplied: mergeOutcome.changesApplied,
			mergedBranchForNestedPatches: mergeOutcome.mergedBranchForNestedPatches,
		});
	}
	if (!mergeSummary) return result;

	const output = result.output ? `${result.output}\n${mergeSummary}` : mergeSummary;
	if (mergeOutcome.changesApplied === false) {
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
 * Execute a single swarm agent as an oh-my-pi subagent.
 *
 * The agent receives:
 * - System prompt: built from role + extra_context
 * - User prompt (task): the full task instructions from the YAML
 * - Working directory: the swarm workspace
 * - Full tool access (bash, python, read, write, edit, grep, find, fetch, web_search, browser)
 */
export async function executeSwarmAgent(
	agent: SwarmAgent,
	index: number,
	options: SwarmExecutorOptions,
): Promise<SingleResult> {
	const { workspace, swarmName, iteration, modelOverride, signal, modelRegistry, settings, stateTracker } = options;

	const agentId = `swarm-${swarmName}-${agent.name}-${iteration}`;
	const artifactsDir = path.join(stateTracker.swarmDir, "context");

	const agentDef: AgentDefinition = {
		name: agent.name,
		description: `Swarm agent: ${agent.role}`,
		systemPrompt: buildSystemPrompt(agent),
		source: "project" as AgentSource,
	};
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
		iteration,
		startedAt: Date.now(),
	});
	await stateTracker.appendLog(agent.name, `Starting iteration ${iteration}`);

	try {
		const recordResult = async (result: SingleResult, attempt: number): Promise<void> => {
			const status = result.exitCode === 0 ? ("completed" as const) : ("failed" as const);
			await stateTracker.updateAgent(agent.name, {
				status,
				attempt,
				completedAt: Date.now(),
				error: result.error,
			});
			await stateTracker.recordResult(agent.name, iteration, attempt, result);
			await stateTracker.appendLog(
				agent.name,
				`Iteration ${iteration} attempt ${attempt} ${status}${result.error ? `: ${result.error}` : ""}`,
			);
		};

		if (options.inheritHistory && options.parentMessages === undefined) {
			throw new Error("Parent history inheritance requires an interactive OMP session.");
		}
		const sessionFile =
			options.inheritHistory && options.parentMessages
				? await materializeParentHistory(workspace, artifactsDir, options.parentMessages)
				: undefined;
		const baseOptions = {
			cwd: workspace,
			agent: agentDef,
			task: agent.task,
			index,
			id: agentId,
			modelOverride,
			signal,
			onProgress: handleProgress,
			modelRegistry,
			settings,
			enableLsp: false,
			keepAlive: true,
			sessionFile,
			artifactsDir,
		} satisfies Parameters<typeof runSubprocess>[0];
		let result = await runWorker(baseOptions, agentDef, index, agentId, agent.task, options.workspaceIsolation);
		await recordResult(result, 0);
		const maxFinalizeAttempts = Math.max(0, Math.trunc(options.maxFinalizeAttempts ?? 3));
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
			result = await runSubagentFollowUpTurn({
				id: agentId,
				agent: agentDef,
				message: feedback,
				index,
				signal,
				onProgress: handleProgress,
				artifactsDir,
			});
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
		await stateTracker.appendLog(agent.name, `Iteration ${iteration} error: ${error}`);
		throw err;
	}
}

function buildSystemPrompt(agent: SwarmAgent): string {
	const parts = [`You are a ${agent.role}.`];
	if (agent.extraContext) {
		parts.push(agent.extraContext);
	}
	return parts.join("\n\n");
}

export interface SwarmDirectMessageSender {
	sendUserMessage(content: string): void;
}

/** Build the prompt that keeps a no-agent definition in the current OMP session. */
export function buildDirectSwarmPrompt(definition: SwarmDefinition): string {
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
export function executeDirectSwarm(definition: SwarmDefinition, sender: SwarmDirectMessageSender): void {
	if (definition.agents.size > 0) {
		throw new Error("Direct Shortleash execution requires a definition without agents.");
	}
	sender.sendUserMessage(buildDirectSwarmPrompt(definition));
}

function formatPolicyReference(reference: unknown): string {
	if (typeof reference === "string") return reference;
	if (reference && typeof reference === "object" && "id" in reference) {
		const value = reference as { plugin?: unknown; id: unknown };
		return `${typeof value.plugin === "string" ? `${value.plugin}:` : ""}${String(value.id)}`;
	}
	return String(reference);
}
