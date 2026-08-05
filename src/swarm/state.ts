/**
 * Filesystem state tracker for swarm pipeline execution.
 *
 * Persists pipeline and per-agent state to `.swarm_<name>/` in the workspace.
 * Supports resumability by loading state from disk.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import { isEnoent } from "@oh-my-pi/pi-utils";
// ============================================================================
// State types
// ============================================================================

export type PipelineStatus = "idle" | "running" | "completed" | "failed" | "aborted";
export type AgentStatus = "pending" | "waiting" | "running" | "completed" | "failed" | "skipped";
export interface AgentToolAction {
	tool: string;
	args: string;
	endMs: number;
}
export interface AgentState {
	name: string;
	status: AgentStatus;
	iteration: number;
	wave: number;
	attempt?: number;
	startedAt?: number;
	completedAt?: number;
	error?: string;
	/** Current native tool name, when the worker is actively executing one. */
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	/** Bounded newest-first history, persisted for the dashboard and recovery. */
	recentTools?: AgentToolAction[];
}
export interface SwarmResultRecord {
	iteration: number;
	attempt: number;
	result: SingleResult;
}
export interface SwarmRunManifest {
	definitionPath?: string;
	definitionHash: string;
	workspace: string;
	ompVersion?: string;
	extensionVersion?: string;
	repositoryRevision?: string;
	models: Record<string, string | undefined>;
	pluginPaths: string[];
	environment: {
		platform: string;
		arch: string;
		bunVersion: string;
		nodeVersion: string;
		cwd: string;
		ci?: string;
	};
}
export interface SwarmPolicyObservationState {
	agent: string;
	iteration: number;
	attempt: number;
	reference: string;
	before?: unknown;
	after?: unknown;
}
export interface SwarmPolicyState {
	boundary: string;
	iteration?: number;
	wave?: number;
	agent?: string;
	accepted: boolean;
	failures: Array<{
		source: string;
		id: string;
		message: string;
		findings: unknown[];
		evidenceRefs: string[];
	}>;
	evaluations: Array<{
		id: string;
		version: string;
		outcome: "pass" | "fail";
		explanation: string;
		findings: unknown[];
		evidenceRefs: string[];
	}>;
	updatedAt: number;
}
export interface SwarmProjectionState {
	targetId: string;
	event: string;
	status: string;
	detail?: string;
	error?: string;
	updatedAt: number;
}
export interface SwarmState {
	version: 2;
	name: string;
	definitionHash: string;
	workspace: string;
	status: PipelineStatus;
	mode: string;
	iteration: number;
	nextIteration: number;
	currentWave: number;
	targetCount: number;
	agents: Record<string, AgentState>;
	results: Record<string, SwarmResultRecord[]>;
	policy?: SwarmPolicyState;
	policyHistory: SwarmPolicyState[];
	policyObservations: Record<string, SwarmPolicyObservationState>;
	projectionHistory: SwarmProjectionState[];
	manifest?: SwarmRunManifest;
	startedAt: number;
	lastResumedAt?: number;
	completedAt?: number;
}

// ============================================================================
// State tracker
// ============================================================================

export interface StateInitOptions {
	definitionHash?: string;
	workspace?: string;
	definitionPath?: string;
	manifest?: SwarmRunManifest;
	resume?: boolean;
	restart?: boolean;
}

export interface RunLockMetadata {
	definitionHash: string;
	workspace: string;
}

export class StateTracker {
	#swarmDir: string;
	#state: SwarmState;
	#persistTail: Promise<void> = Promise.resolve();
	#lockRunId?: string;

	constructor(workspaceDir: string, name: string) {
		this.#swarmDir = path.join(workspaceDir, `.swarm_${name}`);
		this.#state = createInitialState(name, workspaceDir);
	}

	get swarmDir(): string {
		return this.#swarmDir;
	}

	get state(): Readonly<SwarmState> {
		return this.#state;
	}

	async acquireRunLock(metadata: RunLockMetadata, options: { allowStaleRecovery?: boolean } = {}): Promise<void> {
		await fs.mkdir(this.#swarmDir, { recursive: true });
		const lockPath = path.join(this.#swarmDir, "run.lock");
		const runId = `${this.#state.name}-${Date.now()}-${Bun.hash(`${process.pid}:${Math.random()}`).toString(36)}`;
		const lock = {
			runId,
			pid: process.pid,
			startedAt: Date.now(),
			...metadata,
		};

		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const handle = await fs.open(lockPath, "wx");
				try {
					await handle.write(JSON.stringify(lock, null, 2));
					await handle.sync();
				} finally {
					await handle.close();
				}
				this.#lockRunId = runId;
				return;
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
				let existing: RunLock | undefined;
				try {
					existing = await readLock(lockPath);
				} catch (error) {
					if (error instanceof CorruptRunLockError) {
						throw new Error(
							`${error.message} Verify that no swarm process is active, then remove the lock before retrying.`,
							{ cause: error },
						);
					}
					throw error;
				}
				if (existing && isProcessAlive(existing.pid)) {
					throw new Error(
						`Swarm '${this.#state.name}' is already running (pid ${existing.pid}, started ${new Date(existing.startedAt).toISOString()}).`,
					);
				}
				if (!options.allowStaleRecovery) {
					throw new Error(
						`Swarm '${this.#state.name}' has a stale run lock at ${lockPath}. Rerun with --resume or --restart to recover it.`,
					);
				}
				await fs.unlink(lockPath).catch(unlinkError => {
					if (!isEnoent(unlinkError)) throw unlinkError;
				});
			}
		}
		throw new Error(`Could not acquire swarm lock at ${lockPath}; another process changed it.`);
	}

	async releaseRunLock(): Promise<void> {
		const runId = this.#lockRunId;
		if (!runId) return;
		this.#lockRunId = undefined;
		const lockPath = path.join(this.#swarmDir, "run.lock");
		try {
			const existing = await readLock(lockPath);
			if (existing?.runId === runId) await fs.unlink(lockPath);
		} catch (error) {
			if (error instanceof CorruptRunLockError || isEnoent(error)) return;
			throw error;
		}
	}

	async init(
		agentNames: string[],
		targetCount: number,
		mode: string,
		options: StateInitOptions = {},
	): Promise<{ resumed: boolean }> {
		await fs.mkdir(path.join(this.#swarmDir, "state"), { recursive: true });
		await fs.mkdir(path.join(this.#swarmDir, "logs"), { recursive: true });
		await fs.mkdir(path.join(this.#swarmDir, "context"), { recursive: true });

		const existing = await this.load();
		if (existing) {
			if (!options.resume && !options.restart) {
				throw new Error(
					`Swarm '${existing.name}' already has persisted state (${existing.status}). Use --resume to continue it or --restart to run it again.`,
				);
			}
			if (options.resume) {
				if (existing.status === "completed") {
					throw new Error(`Swarm '${existing.name}' is already completed. Use --restart to run it again.`);
				}
				assertResumeCompatible(existing, agentNames, targetCount, mode, options);
				this.#state = existing;
				this.#state.status = "running";
				this.#state.completedAt = undefined;
				this.#state.lastResumedAt = Date.now();
				if (options.manifest) this.#state.manifest = options.manifest;
				await this.#persist();
				return { resumed: true };
			}
		} else if (options.resume) {
			throw new Error(`Cannot resume swarm '${this.#state.name}': no persisted state was found.`);
		}

		this.#state = createInitialState(this.#state.name, options.workspace ?? path.dirname(this.#swarmDir), {
			definitionHash: options.definitionHash,
			workspace: options.workspace,
			definitionPath: options.definitionPath,
			manifest: options.manifest,
			mode,
			targetCount,
			agentNames,
		});
		await this.#persist();
		return { resumed: false };
	}

	async updateAgent(name: string, update: Partial<AgentState>): Promise<void> {
		const agent = this.#state.agents[name];
		if (!agent) return;
		Object.assign(agent, update);
		await this.#persist();
	}

	async updatePipeline(update: Partial<SwarmState>): Promise<void> {
		Object.assign(this.#state, update);
		await this.#persist();
	}

	async recordResult(agentName: string, iteration: number, attempt: number, result: SingleResult): Promise<void> {
		const records = this.#state.results[agentName] ?? [];
		const record = { iteration, attempt, result: durableSnapshot(result) as SingleResult };
		const existingIndex = records.findIndex(item => item.iteration === iteration && item.attempt === attempt);
		if (existingIndex === -1) records.push(record);
		else records[existingIndex] = record;
		records.sort((left, right) => left.iteration - right.iteration || left.attempt - right.attempt);
		this.#state.results[agentName] = records;
		await this.#persist();
	}

	async updatePolicy(
		policy: {
			boundary: string;
			accepted: boolean;
			failures: ReadonlyArray<{
				source: string;
				id: string;
				message: string;
				findings: readonly unknown[];
				evidenceRefs: readonly string[];
			}>;
			evaluations: ReadonlyArray<{
				id: string;
				version: string;
				outcome: "pass" | "fail";
				explanation: string;
				findings: readonly unknown[];
				evidenceRefs: readonly string[];
			}>;
		},
		location: { iteration?: number; wave?: number; agent?: string } = {},
	): Promise<void> {
		const snapshot: SwarmPolicyState = {
			boundary: policy.boundary,
			...location,
			accepted: policy.accepted,
			failures: policy.failures.map(failure => ({
				source: failure.source,
				id: failure.id,
				message: failure.message,
				findings: durableSnapshot(failure.findings) as unknown[],
				evidenceRefs: [...failure.evidenceRefs],
			})),
			evaluations: policy.evaluations.map(evaluation => ({
				id: evaluation.id,
				version: evaluation.version,
				outcome: evaluation.outcome,
				explanation: evaluation.explanation,
				findings: durableSnapshot(evaluation.findings) as unknown[],
				evidenceRefs: [...evaluation.evidenceRefs],
			})),
			updatedAt: Date.now(),
		};
		this.#state.policy = snapshot;
		this.#state.policyHistory.push(snapshot);
		await this.#persist();
	}
	async recordProjection(
		targetId: string,
		event: string,
		status: string,
		detail?: string,
		error?: string,
	): Promise<void> {
		this.#state.projectionHistory.push({
			targetId,
			event,
			status,
			...(detail ? { detail } : {}),
			...(error ? { error } : {}),
			updatedAt: Date.now(),
		});
		await this.#persist();
	}

	async recordPolicyObservations(
		agent: string,
		iteration: number,
		attempt: number,
		phase: "before" | "after",
		observations: ReadonlyMap<string, unknown>,
	): Promise<void> {
		if (observations.size === 0) return;
		for (const [reference, snapshot] of observations) {
			const key = policyObservationKey(agent, iteration, attempt, reference);
			let record = this.#state.policyObservations[key];
			if (!record) {
				record = {
					agent,
					iteration,
					attempt,
					reference,
				};
				this.#state.policyObservations[key] = record;
			}
			record[phase] = durableSnapshot(snapshot);
		}
		await this.#persist();
	}

	async appendLog(agentName: string, message: string): Promise<void> {
		const logPath = path.join(this.#swarmDir, "logs", `${agentName}.log`);
		const timestamp = new Date().toISOString();
		await fs.appendFile(logPath, `[${timestamp}] ${message}\n`);
	}

	async appendOrchestratorLog(message: string): Promise<void> {
		const logPath = path.join(this.#swarmDir, "logs", "orchestrator.log");
		const timestamp = new Date().toISOString();
		await fs.appendFile(logPath, `[${timestamp}] ${message}\n`);
	}

	async load(): Promise<SwarmState | null> {
		const statePath = path.join(this.#swarmDir, "state", "pipeline.json");
		let content: string;
		try {
			content = await Bun.file(statePath).text();
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (error) {
			throw new Error(
				`Swarm state at ${statePath} is corrupt: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.#state = normalizeState(parsed, this.#state.name);
		return this.#state;
	}

	async #persist(): Promise<void> {
		const write = this.#persistTail.then(async () => {
			const statePath = path.join(this.#swarmDir, "state", "pipeline.json");
			const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
			const content = JSON.stringify(this.#state, null, 2);
			try {
				const handle = await fs.open(temporaryPath, "w");
				try {
					await handle.write(content);
					await handle.sync();
				} finally {
					await handle.close();
				}
				await fs.rename(temporaryPath, statePath);
				await syncDirectory(path.dirname(statePath));
			} catch (error) {
				await fs.unlink(temporaryPath).catch(unlinkError => {
					if (!isEnoent(unlinkError)) throw unlinkError;
				});
				throw error;
			}
		});
		this.#persistTail = write.then(
			() => undefined,
			() => undefined,
		);
		await write;
	}
}

interface StateInitValues {
	definitionHash?: string;
	workspace?: string;
	definitionPath?: string;
	manifest?: SwarmRunManifest;
	mode: string;
	targetCount: number;
	agentNames: string[];
}
interface RunLock extends RunLockMetadata {
	runId: string;
	pid: number;
	startedAt: number;
}

class CorruptRunLockError extends Error {
	constructor(lockPath: string, detail: string) {
		super(`Swarm run lock at ${lockPath} is corrupt: ${detail}`);
		this.name = "CorruptRunLockError";
	}
}

function createInitialState(name: string, workspace: string, values?: Partial<StateInitValues>): SwarmState {
	const agentNames = values?.agentNames ?? [];
	const now = Date.now();
	const agents: Record<string, AgentState> = {};
	const results: Record<string, SwarmResultRecord[]> = {};
	for (const agentName of agentNames) {
		agents[agentName] = {
			name: agentName,
			status: "pending",
			iteration: 0,
			wave: 0,
			attempt: 0,
		};
		results[agentName] = [];
	}
	return {
		version: 2,
		name,
		definitionHash: values?.definitionHash ?? "unknown",
		workspace: values?.workspace ?? workspace,
		status: "running",
		mode: values?.mode ?? "sequential",
		iteration: 0,
		nextIteration: 0,
		currentWave: 0,
		targetCount: values?.targetCount ?? 1,
		agents,
		results,
		policyHistory: [],
		policyObservations: {},
		projectionHistory: [],
		manifest: values?.manifest,
		startedAt: now,
	};
}

function normalizeState(value: unknown, fallbackName: string): SwarmState {
	if (!isRecord(value)) throw new Error("Swarm state must contain a JSON object.");
	const targetCount = typeof value.targetCount === "number" ? value.targetCount : 1;
	const iteration = typeof value.iteration === "number" ? value.iteration : 0;
	const status = isPipelineStatus(value.status) ? value.status : "failed";
	const rawAgents = isRecord(value.agents) ? value.agents : {};
	const agents: Record<string, AgentState> = {};
	for (const [name, raw] of Object.entries(rawAgents)) {
		if (!isRecord(raw)) continue;
		agents[name] = {
			name,
			status: isAgentStatus(raw.status) ? raw.status : "pending",
			iteration: typeof raw.iteration === "number" ? raw.iteration : 0,
			wave: typeof raw.wave === "number" ? raw.wave : 0,
			attempt: typeof raw.attempt === "number" ? raw.attempt : 0,
			startedAt: typeof raw.startedAt === "number" ? raw.startedAt : undefined,
			completedAt: typeof raw.completedAt === "number" ? raw.completedAt : undefined,
			error: typeof raw.error === "string" ? raw.error : undefined,
			currentTool: typeof raw.currentTool === "string" ? raw.currentTool : undefined,
			currentToolArgs: typeof raw.currentToolArgs === "string" ? raw.currentToolArgs : undefined,
			lastIntent: typeof raw.lastIntent === "string" ? raw.lastIntent : undefined,
			recentTools: Array.isArray(raw.recentTools) ? (raw.recentTools as AgentToolAction[]) : undefined,
		};
	}
	const rawResults = isRecord(value.results) ? value.results : {};
	const results: Record<string, SwarmResultRecord[]> = {};
	for (const [name, raw] of Object.entries(rawResults)) {
		if (!Array.isArray(raw)) continue;
		results[name] = raw.filter(
			(record): record is SwarmResultRecord =>
				isRecord(record) &&
				typeof record.iteration === "number" &&
				typeof record.attempt === "number" &&
				isRecord(record.result),
		) as SwarmResultRecord[];
	}
	const policy = isRecord(value.policy) ? (value.policy as unknown as SwarmPolicyState) : undefined;
	const policyHistory = Array.isArray(value.policyHistory)
		? (value.policyHistory.filter(isRecord) as unknown as SwarmPolicyState[])
		: policy
			? [policy]
			: [];
	return {
		version: 2,
		name: typeof value.name === "string" ? value.name : fallbackName,
		definitionHash: typeof value.definitionHash === "string" ? value.definitionHash : "legacy",
		workspace: typeof value.workspace === "string" ? value.workspace : "",
		status,
		mode: typeof value.mode === "string" ? value.mode : "sequential",
		iteration,
		nextIteration:
			typeof value.nextIteration === "number"
				? value.nextIteration
				: status === "completed"
					? targetCount
					: iteration,
		currentWave: typeof value.currentWave === "number" ? value.currentWave : 0,
		targetCount,
		agents,
		results,
		policy,
		policyHistory,
		policyObservations: isRecord(value.policyObservations)
			? (value.policyObservations as unknown as Record<string, SwarmPolicyObservationState>)
			: {},
		projectionHistory: Array.isArray(value.projectionHistory)
			? (value.projectionHistory.filter(isRecord) as unknown as SwarmProjectionState[])
			: [],
		startedAt: typeof value.startedAt === "number" ? value.startedAt : Date.now(),
		lastResumedAt: typeof value.lastResumedAt === "number" ? value.lastResumedAt : undefined,
		completedAt: typeof value.completedAt === "number" ? value.completedAt : undefined,
	};
}

function assertResumeCompatible(
	state: SwarmState,
	agentNames: readonly string[],
	targetCount: number,
	mode: string,
	options: StateInitOptions,
): void {
	if (options.definitionHash && state.definitionHash !== "unknown" && state.definitionHash !== "legacy") {
		if (state.definitionHash !== options.definitionHash) {
			throw new Error(
				`Cannot resume swarm '${state.name}': definition hash changed (${state.definitionHash.slice(0, 12)} != ${options.definitionHash.slice(0, 12)}).`,
			);
		}
	}
	if (options.workspace && state.workspace && path.resolve(state.workspace) !== path.resolve(options.workspace)) {
		throw new Error(`Cannot resume swarm '${state.name}': workspace changed.`);
	}
	if (state.mode !== mode || state.targetCount !== targetCount) {
		throw new Error(`Cannot resume swarm '${state.name}': mode or target_count changed.`);
	}
	const existingNames = Object.keys(state.agents).sort();
	const requestedNames = [...agentNames].sort();
	if (JSON.stringify(existingNames) !== JSON.stringify(requestedNames)) {
		throw new Error(`Cannot resume swarm '${state.name}': agent set changed.`);
	}
}

async function readLock(lockPath: string): Promise<RunLock | undefined> {
	let value: unknown;
	try {
		value = await Bun.file(lockPath).json();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw new CorruptRunLockError(lockPath, error instanceof Error ? error.message : String(error));
	}
	if (
		isRecord(value) &&
		typeof value.runId === "string" &&
		typeof value.pid === "number" &&
		typeof value.startedAt === "number" &&
		typeof value.definitionHash === "string" &&
		typeof value.workspace === "string"
	) {
		return value as unknown as RunLock;
	}
	throw new CorruptRunLockError(lockPath, "expected runId, pid, startedAt, definitionHash, and workspace");
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		handle = await fs.open(directory, "r");
		await handle.sync();
	} catch (error) {
		const code = errorCode(error);
		if (code !== "EINVAL" && code !== "EISDIR" && code !== "ENOTSUP") throw error;
	} finally {
		await handle?.close();
	}
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPipelineStatus(value: unknown): value is PipelineStatus {
	return value === "idle" || value === "running" || value === "completed" || value === "failed" || value === "aborted";
}

function isAgentStatus(value: unknown): value is AgentStatus {
	return (
		value === "pending" ||
		value === "waiting" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "skipped"
	);
}

function policyObservationKey(agent: string, iteration: number, attempt: number, reference: string): string {
	return `${agent}/iteration-${iteration}/attempt-${attempt}/${reference}`;
}

function durableSnapshot(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : JSON.parse(serialized);
	} catch {
		return String(value);
	}
}
