/**
 * Herdr-backed swarm execution.
 *
 * The CLI runner and lifecycle calls are intentionally kept behind this module.
 * They follow the public CLI primitives used by pi-herdr 0.2.5:
 * https://github.com/AndrewJacop/pi-herdr
 *
 * This module delegates raw CLI execution to pi-herdr's command runner. The
 * package currently publishes no runtime export, so that source-path import is
 * isolated here rather than leaking into the rest of the extension.
 */
import * as path from "node:path";
import { herdr as runPiHerdr } from "@andrewjacop/pi-herdr/src/herdr";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSource, SingleResult } from "@oh-my-pi/pi-coding-agent";
import { $which, isCompiledBinary } from "@oh-my-pi/pi-utils";
import type { SwarmAgent, SwarmDefinition } from "../definition/schema";
import type { SwarmAgentRunner, SwarmExecutorOptions } from "../execution/executor";
import type { StateTracker } from "../execution/state";
import type { SwarmPluginLogger } from "../policy/plugins";

export interface HerdrCallOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	wait?: boolean;
}

export interface HerdrError {
	code: "HERDR_UNAVAILABLE" | "TIMEOUT" | "NOT_FOUND" | "PANE_GONE" | "VALIDATION_ERROR" | "AGENT_START_FAILED";
	message: string;
	details?: unknown;
}

export type HerdrResult<T> = { ok: true; data: T } | { ok: false; error: HerdrError };

export interface HerdrTab {
	tabId: string;
	workspaceId: string;
}

export interface HerdrPane {
	paneId: string;
	tabId?: string;
	workspaceId?: string;
}

/** Public lifecycle seam used by HerdrSwarmSession and deterministic tests. */
export interface HerdrControl {
	probe(options?: HerdrCallOptions): Promise<void>;
	createTab(
		options: {
			cwd: string;
			label: string;
			focus?: boolean;
		} & HerdrCallOptions,
	): Promise<HerdrTab>;
	listPanes(workspaceId: string, options?: HerdrCallOptions): Promise<HerdrPane[]>;
	runPane(paneId: string, command: string, options?: HerdrCallOptions): Promise<void>;
	splitPane(
		options: {
			anchorPaneId: string;
			direction: "right" | "down";
			cwd: string;
		} & HerdrCallOptions,
	): Promise<string>;
	startAgent(
		options: {
			paneId: string;
			name: string;
			kind: string;
			args?: string[];
		} & HerdrCallOptions,
	): Promise<void>;
	waitAgent(target: string, options?: HerdrCallOptions): Promise<void>;
	promptAgent(target: string, prompt: string, options?: HerdrCallOptions): Promise<void>;
	readAgent(target: string, options?: HerdrCallOptions): Promise<string>;
	closePane(paneId: string, options?: HerdrCallOptions): Promise<void>;
	closeTab(tabId: string, options?: HerdrCallOptions): Promise<void>;
}

interface HerdrCommandOptions extends HerdrCallOptions {
	textOk?: boolean;
}

interface HerdrCommandRunner {
	run<T>(args: string[], options?: HerdrCommandOptions): Promise<HerdrResult<T>>;
}

/**
 * Thin argv-safe Herdr CLI adapter, based on pi-herdr's command runner.
 * No shell interpolation is used for the Herdr command itself.
 */
export class CliHerdrControl implements HerdrControl {
	readonly #agentKinds = new Map<string, string>();
	readonly #pendingAgentOutputs = new Map<string, string>();
	readonly #runner: HerdrCommandRunner;

	constructor(runner: HerdrCommandRunner = new ProcessHerdrCommandRunner()) {
		this.#runner = runner;
	}

	async probe(options: HerdrCallOptions = {}): Promise<void> {
		await unwrap(await this.#runner.run(["tab", "list"], options));
	}

	async createTab(
		options: {
			cwd: string;
			label: string;
			focus?: boolean;
		} & HerdrCallOptions,
	): Promise<HerdrTab> {
		const args = ["tab", "create", "--cwd", options.cwd, "--label", options.label];
		if (options.focus === true) args.push("--focus");
		else if (options.focus === false) args.push("--no-focus");
		const data = await unwrap(await this.#runner.run<unknown>(args, options));
		const tabId = extractId(data, ["tab_id", "tabId"], "tab");
		if (!tabId) throw new Error("Herdr tab create returned no tab id.");
		return { tabId, workspaceId: workspaceIdFromTab(tabId) };
	}

	async listPanes(workspaceId: string, options: HerdrCallOptions = {}): Promise<HerdrPane[]> {
		const data = await unwrap(await this.#runner.run<unknown>(["pane", "list", "--workspace", workspaceId], options));
		const record = asRecord(data);
		const rawPanes = Array.isArray(record?.panes) ? record.panes : [];
		return rawPanes.flatMap(value => {
			const pane = asRecord(value);
			const paneId = pickString(pane, "pane_id", "paneId");
			if (!paneId) return [];
			return [
				{
					paneId,
					tabId: pickString(pane, "tab_id", "tabId"),
					workspaceId: pickString(pane, "workspace_id", "workspaceId"),
				},
			];
		});
	}

	async runPane(paneId: string, command: string, options: HerdrCallOptions = {}): Promise<void> {
		await unwrap(await this.#runner.run(["pane", "run", paneId, command], options));
	}

	async splitPane(
		options: {
			anchorPaneId: string;
			direction: "right" | "down";
			cwd: string;
		} & HerdrCallOptions,
	): Promise<string> {
		const data = await unwrap(
			await this.#runner.run<unknown>(
				["pane", "split", "--pane", options.anchorPaneId, "--direction", options.direction, "--cwd", options.cwd],
				options,
			),
		);
		const paneId = extractId(data, ["pane_id", "paneId", "id"], "pane");
		if (!paneId) throw new Error("Herdr pane split returned no pane id.");
		return paneId;
	}

	async startAgent(
		options: {
			paneId: string;
			name: string;
			kind: string;
			args?: string[];
		} & HerdrCallOptions,
	): Promise<void> {
		const args = ["agent", "start", options.name, "--kind", options.kind, "--pane", options.paneId];
		if (options.args && options.args.length > 0) args.push("--", ...options.args);
		await unwrap(await this.#runner.run<unknown>(args, options));
		this.#agentKinds.set(options.paneId, options.kind);
	}

	async waitAgent(target: string, options: HerdrCallOptions = {}): Promise<void> {
		const pending = this.#pendingAgentOutputs.get(target);
		if (pending !== undefined && this.#agentKinds.get(target) === "omp") {
			try {
				await waitForOmpAgentTurn(this, target, pending, options);
			} finally {
				this.#pendingAgentOutputs.delete(target);
			}
			return;
		}
		const timeoutMs = options.timeoutMs ?? 90_000;
		await unwrap(
			await this.#runner.run<unknown>(["agent", "wait", target, "--until", "idle", "--timeout", String(timeoutMs)], {
				...options,
				timeoutMs: timeoutMs + 8_000,
			}),
		);
	}

	async promptAgent(target: string, prompt: string, options: HerdrCallOptions = {}): Promise<void> {
		const timeoutMs = options.timeoutMs ?? 120_000;
		const wait = options.wait !== false;
		if (!wait && this.#agentKinds.get(target) === "omp") {
			const baseline = await this.readAgent(target, {
				signal: options.signal,
				timeoutMs: Math.min(timeoutMs, 10_000),
			});
			this.#pendingAgentOutputs.set(target, baseline);
		}
		const args = ["agent", "prompt", target, prompt];
		if (wait) args.push("--wait", "--timeout", String(timeoutMs));
		try {
			await unwrap(
				await this.#runner.run<unknown>(args, {
					...options,
					timeoutMs: wait ? timeoutMs + 8_000 : Math.min(timeoutMs, 10_000),
				}),
			);
		} catch (error) {
			this.#pendingAgentOutputs.delete(target);
			throw error;
		}
	}

	async readAgent(target: string, options: HerdrCallOptions = {}): Promise<string> {
		const data = await unwrap(
			await this.#runner.run<unknown>(
				["agent", "read", target, "--source", "recent", "--lines", "80", "--format", "text"],
				{ ...options, textOk: true },
			),
		);
		return extractText(data);
	}

	async closePane(paneId: string, options: HerdrCallOptions = {}): Promise<void> {
		await unwrap(await this.#runner.run(["pane", "close", paneId], options));
	}

	async closeTab(tabId: string, options: HerdrCallOptions = {}): Promise<void> {
		await unwrap(await this.#runner.run(["tab", "close", tabId], options));
	}
}

interface HerdrSwarmSessionOptions {
	client?: HerdrControl;
	definition: SwarmDefinition;
	definitionInput: string;
	workspace: string;
	cwd: string;
	logger?: SwarmPluginLogger;
}

/**
 * Owns one Herdr tab for one swarm run. Agent panes are deliberately created
 * and destroyed per runnable wave so the visible layout mirrors the DAG.
 */
export class HerdrSwarmSession {
	readonly #client: HerdrControl;
	readonly #tabId: string;
	readonly #dashboardPaneId: string;
	readonly #workspace: string;
	readonly #swarmName: string;
	readonly #logger?: SwarmPluginLogger;
	#disposed = false;
	#layoutTail: Promise<void> = Promise.resolve();
	#agentPanes = new Set<string>();

	private constructor(
		client: HerdrControl,
		options: {
			tabId: string;
			dashboardPaneId: string;
			workspace: string;
			swarmName: string;
			logger?: SwarmPluginLogger;
		},
	) {
		this.#client = client;
		this.#tabId = options.tabId;
		this.#dashboardPaneId = options.dashboardPaneId;
		this.#workspace = options.workspace;
		this.#swarmName = options.swarmName;
		this.#logger = options.logger;
	}

	static async open(options: HerdrSwarmSessionOptions): Promise<HerdrSwarmSession | undefined> {
		if (options.definition.agentExecution === "subagents") {
			options.logger?.debug("Using the in-process subagent executor by configuration.", {
				swarm: options.definition.name,
			});
			return undefined;
		}
		if (usesUnsupportedIsolation(options.definition)) {
			options.logger?.warn("Skipping Herdr swarm execution because worktree isolation is configured.", {
				swarm: options.definition.name,
			});
			return undefined;
		}

		const client = options.client ?? new CliHerdrControl();
		let tabId: string | undefined;
		try {
			await client.probe();
			const tab = await client.createTab({
				cwd: options.cwd,
				label: `shortleash: ${options.definition.name}`,
				focus: false,
			});
			tabId = tab.tabId;
			const panes = await waitForTabPane(client, tab.tabId, tab.workspaceId);
			if (!panes) throw new Error(`Herdr tab ${tab.tabId} did not expose an initial pane.`);
			const session = new HerdrSwarmSession(client, {
				tabId: tab.tabId,
				dashboardPaneId: panes.paneId,
				workspace: options.workspace,
				swarmName: options.definition.name,
				logger: options.logger,
			});
			await client.runPane(panes.paneId, buildDashboardCommand(options.definitionInput));
			return session;
		} catch (error) {
			if (tabId) await client.closeTab(tabId).catch(() => {});
			options.logger?.warn("Herdr unavailable; using the in-process swarm executor.", {
				swarm: options.definition.name,
				error: errorMessage(error),
			});
			return undefined;
		}
	}

	get tabId(): string {
		return this.#tabId;
	}

	get dashboardPaneId(): string {
		return this.#dashboardPaneId;
	}

	/** Function-shaped adapter accepted by PipelineController. */
	readonly runAgent: SwarmAgentRunner = async (agent, index, options) => {
		if (this.#disposed) throw new Error(`Shortleash tab '${this.#tabId}' is already closed.`);
		const paneId = await this.#withLayout(() =>
			this.#client.splitPane({
				anchorPaneId: this.#dashboardPaneId,
				direction: "right",
				cwd: this.#workspace,
				signal: options.signal,
			}),
		);
		this.#agentPanes.add(paneId);
		try {
			await startHerdrAgentWithRetry(this.#client, {
				paneId,
				name: buildHerdrAgentName(this.#swarmName, agent.name, index),
				kind: process.env.OMP_SWARM_HERDR_AGENT ?? "omp",
				signal: options.signal,
			});
			await this.#client.waitAgent(paneId, {
				timeoutMs: HERDR_AGENT_BOOT_TIMEOUT_MS,
				signal: options.signal,
			});
			await new Promise<void>(resolve => setTimeout(resolve, HERDR_AGENT_SETTLE_DELAY_MS));
			return await executeHerdrAgent(agent, index, options, this.#client, paneId, this.#swarmName);
		} finally {
			this.#agentPanes.delete(paneId);
			await this.#client.closePane(paneId, { signal: options.signal }).catch(error => {
				this.#logger?.debug("Herdr agent pane cleanup failed.", {
					swarm: this.#swarmName,
					pane: paneId,
					error: errorMessage(error),
				});
			});
		}
	};

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const panes = [...this.#agentPanes];
		this.#agentPanes.clear();
		await Promise.allSettled(panes.map(paneId => this.#client.closePane(paneId)));
		await this.#client.closeTab(this.#tabId).catch(error => {
			this.#logger?.debug("Herdr Shortleash tab cleanup failed.", {
				swarm: this.#swarmName,
				tab: this.#tabId,
				error: errorMessage(error),
			});
		});
	}

	async #withLayout<T>(operation: () => Promise<T>): Promise<T> {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const previous = this.#layoutTail;
		this.#layoutTail = previous.then(() => gate);
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

export async function createHerdrSwarmSession(
	options: HerdrSwarmSessionOptions,
): Promise<HerdrSwarmSession | undefined> {
	return HerdrSwarmSession.open(options);
}

async function executeHerdrAgent(
	agent: SwarmAgent,
	index: number,
	options: SwarmExecutorOptions,
	client: HerdrControl,
	paneId: string,
	swarmName: string,
): Promise<SingleResult> {
	const agentId = `swarm-${swarmName}-${agent.name}-${options.iteration}`;
	const startedAt = Date.now();
	await options.stateTracker.updateAgent(agent.name, {
		status: "running",
		iteration: options.iteration,
		startedAt,
	});
	await options.stateTracker.appendLog(agent.name, `Starting Herdr iteration ${options.iteration} in pane ${paneId}`);

	try {
		let result = await executeHerdrTurn(
			agent,
			index,
			options,
			client,
			paneId,
			agentId,
			buildAgentPrompt(agent, options.parentMessages),
		);
		await recordHerdrResult(options.stateTracker, agent, options.iteration, result, 0);
		const maxFinalizeAttempts = Math.max(0, Math.trunc(options.maxFinalizeAttempts ?? 3));
		let lastFeedback: string | undefined;
		for (let attempt = 0; attempt < maxFinalizeAttempts; attempt++) {
			const feedback = await options.onFinalize?.(result, attempt);
			if (!feedback) return result;
			lastFeedback = feedback;
			await options.stateTracker.updateAgent(agent.name, { status: "running", error: undefined });
			await options.stateTracker.appendLog(
				agent.name,
				`Finalization rejected; continuing in Herdr pane ${paneId} (attempt ${attempt + 1})`,
			);
			result = await executeHerdrTurn(agent, index, options, client, paneId, agentId, feedback);
			await recordHerdrResult(options.stateTracker, agent, options.iteration, result, attempt + 1);
		}
		if (lastFeedback) {
			throw new Error(
				`Agent finalization rejected after ${maxFinalizeAttempts} corrective attempts.\n${lastFeedback}`,
			);
		}
		return result;
	} catch (error) {
		const message = errorMessage(error);
		await options.stateTracker.updateAgent(agent.name, {
			status: "failed",
			completedAt: Date.now(),
			error: message,
		});
		await options.stateTracker.appendLog(agent.name, `Herdr iteration ${options.iteration} error: ${message}`);
		throw error;
	}
}

async function executeHerdrTurn(
	agent: SwarmAgent,
	index: number,
	options: SwarmExecutorOptions,
	client: HerdrControl,
	paneId: string,
	agentId: string,
	prompt: string,
): Promise<SingleResult> {
	const startedAt = Date.now();
	await client.promptAgent(paneId, prompt, {
		timeoutMs: options.settings ? undefined : 120_000,
		signal: options.signal,
		wait: false,
	});
	await client.waitAgent(paneId, {
		timeoutMs: options.settings ? undefined : 120_000,
		signal: options.signal,
	});
	const output = await client.readAgent(paneId, { signal: options.signal });
	return {
		index,
		id: agentId,
		agent: agent.name,
		agentSource: "project" as AgentSource,
		task: agent.task,
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: Date.now() - startedAt,
		tokens: 0,
		requests: 1,
	};
}

async function recordHerdrResult(
	stateTracker: StateTracker,
	agent: SwarmAgent,
	iteration: number,
	result: SingleResult,
	attempt: number,
): Promise<void> {
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
		`Herdr iteration ${iteration} attempt ${attempt} ${status}${result.error ? `: ${result.error}` : ""}`,
	);
}

function buildAgentPrompt(agent: SwarmAgent, parentMessages?: AgentMessage[]): string {
	const parts = [`You are the '${agent.name}' worker in a swarm.`, `Role: ${agent.role}.`];
	if (agent.extraContext) parts.push(`Additional context:\n${agent.extraContext}`);
	const history = parentMessages?.flatMap(parentMessageText) ?? [];
	if (history.length > 0) {
		parts.push(`Relevant parent session context:\n${history.slice(-8).join("\n")}`);
	}
	parts.push(
		`Work in the assigned swarm workspace and complete this task:\n${agent.task}`,
		"When finished, report what you did and any blockers. Do not modify Beads unless the task explicitly requires it.",
	);
	return parts.join("\n\n");
}

function parentMessageText(message: AgentMessage): string[] {
	const record = asRecord(message);
	if (!record || (record.role !== "user" && record.role !== "assistant" && record.role !== "developer")) return [];
	const text = textContent(record.content);
	return text.trim() ? [`${record.role}: ${text.trim()}`] : [];
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap(block => {
			const record = asRecord(block);
			return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
		})
		.join("\n");
}

function buildDashboardCommand(definitionInput: string): string {
	const script = path.resolve(import.meta.dir, "../../cli.ts");
	// A compiled OMP host's process.execPath is the OMP executable, not Bun. Passing
	// a TypeScript path to it makes OMP treat that path as its input instead
	// of launching the dashboard CLI.
	const executable = isCompiledBinary() ? ($which("bun") ?? "bun") : process.execPath;
	return [executable, script, "dashboard", definitionInput].map(shellQuote).join(" ");
}

const HERDR_AGENT_NAME_MAX_LENGTH = 32;

function buildHerdrAgentName(swarmName: string, agentName: string, index: number): string {
	const suffix = `-${Math.max(0, Math.trunc(index))}`;
	const prefix = `swarm-${normalizeHerdrName(swarmName)}-${normalizeHerdrName(agentName)}`;
	const availablePrefixLength = HERDR_AGENT_NAME_MAX_LENGTH - suffix.length;
	if (availablePrefixLength >= 1) return `${prefix.slice(0, availablePrefixLength)}${suffix}`;
	return `a${suffix.slice(-(HERDR_AGENT_NAME_MAX_LENGTH - 1))}`;
}

function normalizeHerdrName(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^[^a-z]+/, "") || "agent"
	);
}

const HERDR_AGENT_START_RETRIES = 20;
const HERDR_AGENT_START_RETRY_DELAY_MS = 100;
const HERDR_AGENT_BOOT_TIMEOUT_MS = 90_000;
const HERDR_AGENT_SETTLE_DELAY_MS = 1_500;

async function startHerdrAgentWithRetry(
	client: HerdrControl,
	options: Parameters<HerdrControl["startAgent"]>[0],
): Promise<void> {
	for (let attempt = 0; attempt < HERDR_AGENT_START_RETRIES; attempt++) {
		try {
			await client.startAgent(options);
			return;
		} catch (error) {
			if (!isHerdrPaneNotReadyError(error) || attempt === HERDR_AGENT_START_RETRIES - 1) throw error;
			await new Promise<void>(resolve => setTimeout(resolve, HERDR_AGENT_START_RETRY_DELAY_MS));
		}
	}
	throw new Error("Herdr agent start retry loop exhausted.");
}

function isHerdrPaneNotReadyError(error: unknown): boolean {
	return /not an available shell|not ready/i.test(errorMessage(error));
}

async function waitForTabPane(
	client: HerdrControl,
	tabId: string,
	workspaceId: string,
): Promise<HerdrPane | undefined> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const panes = await client.listPanes(workspaceId);
		const pane = panes.find(candidate => candidate.tabId === tabId);
		if (pane) return pane;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 100);
		await promise;
	}
	return undefined;
}

function usesUnsupportedIsolation(definition: SwarmDefinition): boolean {
	return (
		definition.workspaceIsolation === "worktree" ||
		[...definition.agents.values()].some(agent => agent.workspaceIsolation === "worktree")
	);
}

function workspaceIdFromTab(tabId: string): string {
	return tabId.split(":", 1)[0] ?? tabId;
}

function extractId(value: unknown, keys: string[], wrapperKey?: string): string | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const source = wrapperKey && asRecord(record[wrapperKey]) ? asRecord(record[wrapperKey])! : record;
	return keys.map(key => source[key]).find((candidate): candidate is string => typeof candidate === "string");
}

function pickString(value: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
	if (!value) return undefined;
	return keys.map(key => value[key]).find((candidate): candidate is string => typeof candidate === "string");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	const record = asRecord(value);
	if (!record) return "";
	for (const key of ["text", "output", "content"]) {
		if (typeof record[key] === "string") return record[key] as string;
	}
	return "";
}

function unwrap<T>(result: HerdrResult<T>): T {
	if (result.ok) return result.data;
	throw new Error(`Herdr ${result.error.code}: ${result.error.message}`);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function waitForOmpAgentTurn(
	client: HerdrControl,
	target: string,
	baseline: string,
	options: HerdrCallOptions,
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 120_000;
	const deadline = Date.now() + timeoutMs;
	let outputChanged = false;
	let runningObserved = false;
	let stableSince = 0;
	while (Date.now() < deadline) {
		const remainingMs = deadline - Date.now();
		const output = await client.readAgent(target, {
			signal: options.signal,
			timeoutMs: Math.min(5_000, remainingMs),
		});
		outputChanged ||= output !== baseline;
		const running = isOmpRunning(output);
		if (outputChanged && running) {
			runningObserved = true;
			stableSince = 0;
		} else if (outputChanged && !running) {
			if (runningObserved) return;
			if (stableSince === 0) stableSince = Date.now();
			if (Date.now() - stableSince >= 1_500) return;
		}
		await sleep(Math.min(250, Math.max(1, remainingMs)));
	}
	throw new Error(`Herdr agent ${target} did not finish within ${timeoutMs}ms.`);
}

function isOmpRunning(output: string): boolean {
	return /⟦esc⟧|(?:^|\n).*?\bRunning\b.*?(?:\n|$)/.test(output);
}

async function sleep(milliseconds: number): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

class ProcessHerdrCommandRunner implements HerdrCommandRunner {
	run<T>(args: string[], options: HerdrCommandOptions = {}): Promise<HerdrResult<T>> {
		return runPiHerdr<T>(args, {
			timeoutMs: options.timeoutMs,
			signal: options.signal,
			textOk: options.textOk,
		});
	}
}
