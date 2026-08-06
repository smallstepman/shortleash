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
import type { SwarmProjectionEventType } from "../adapters/beads";
import type { SwarmMode } from "../definition/schema";
import type {
	SwarmEvaluationRecord,
	SwarmPolicyBoundary,
	SwarmPolicyDecision,
	SwarmPolicyFailure,
} from "../policy/policy-types";
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
export interface SwarmPolicyState extends SwarmPolicyDecision {
	iteration?: number;
	wave?: number;
	agent?: string;
	updatedAt: number;
}
export interface SwarmProjectionState {
	targetId: string;
	event: SwarmProjectionEventType;
	status: PipelineStatus;
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
	mode: SwarmMode;
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

export interface AgentStateUpdate {
	status?: AgentStatus;
	iteration?: number;
	wave?: number;
	attempt?: number;
	startedAt?: number;
	completedAt?: number;
	error?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	recentTools?: AgentToolAction[];
}

export interface PipelineStateUpdate {
	status?: PipelineStatus;
	iteration?: number;
	nextIteration?: number;
	currentWave?: number;
	completedAt?: number;
	lastResumedAt?: number;
	manifest?: SwarmRunManifest;
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
		agentNames: readonly string[],
		targetCount: number,
		mode: SwarmMode,
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

	async updateAgent(name: string, update: AgentStateUpdate): Promise<void> {
		const agent = this.#state.agents[name];
		if (!agent) throw new Error(`Unknown swarm agent '${name}'.`);
		Object.assign(agent, update);
		await this.#persist();
	}

	async updatePipeline(update: PipelineStateUpdate): Promise<void> {
		Object.assign(this.#state, update);
		await this.#persist();
	}

	async recordResult(agentName: string, iteration: number, attempt: number, result: SingleResult): Promise<void> {
		if (!this.#state.agents[agentName]) throw new Error(`Unknown swarm agent '${agentName}'.`);
		assertNonNegativeInteger(iteration, "iteration");
		assertNonNegativeInteger(attempt, "attempt");
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
		policy: SwarmPolicyDecision,
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
		event: SwarmProjectionEventType,
		status: PipelineStatus,
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
	mode: SwarmMode;
	targetCount: number;
	agentNames: readonly string[];
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

	const targetCount = positiveInteger(value.targetCount) ?? 1;
	const iteration = nonNegativeInteger(value.iteration) ?? 0;
	const status = isPipelineStatus(value.status) ? value.status : "failed";
	const rawAgents = isRecord(value.agents) ? value.agents : {};
	const agents: Record<string, AgentState> = {};
	for (const [name, raw] of Object.entries(rawAgents)) {
		const agent = normalizeAgentState(name, raw);
		if (agent) agents[name] = agent;
	}

	const rawResults = isRecord(value.results) ? value.results : {};
	const results: Record<string, SwarmResultRecord[]> = {};
	for (const [name, raw] of Object.entries(rawResults)) {
		if (!Array.isArray(raw)) continue;
		results[name] = raw.flatMap(record => {
			if (!isRecord(record)) return [];
			const recordIteration = nonNegativeInteger(record.iteration);
			const attempt = nonNegativeInteger(record.attempt);
			if (recordIteration === undefined || attempt === undefined || !isSingleResult(record.result)) return [];
			return [{ iteration: recordIteration, attempt, result: record.result }];
		});
	}

	const policy = normalizePolicyState(value.policy);
	const policyHistory = Array.isArray(value.policyHistory)
		? value.policyHistory.flatMap(entry => {
				const normalized = normalizePolicyState(entry);
				return normalized ? [normalized] : [];
			})
		: policy
			? [policy]
			: [];

	const policyObservations: Record<string, SwarmPolicyObservationState> = {};
	if (isRecord(value.policyObservations)) {
		for (const [key, raw] of Object.entries(value.policyObservations)) {
			const observation = normalizePolicyObservation(raw);
			if (observation) policyObservations[key] = observation;
		}
	}

	const projectionHistory: SwarmProjectionState[] = Array.isArray(value.projectionHistory)
		? value.projectionHistory.flatMap(entry => {
				const normalized = normalizeProjectionState(entry);
				return normalized ? [normalized] : [];
			})
		: [];

	return {
		version: 2,
		name: nonEmptyString(value.name) ?? fallbackName,
		definitionHash: nonEmptyString(value.definitionHash) ?? "legacy",
		workspace: typeof value.workspace === "string" ? value.workspace : "",
		status,
		mode: isSwarmMode(value.mode) ? value.mode : "sequential",
		iteration,
		nextIteration: nonNegativeInteger(value.nextIteration) ?? (status === "completed" ? targetCount : iteration),
		currentWave: nonNegativeInteger(value.currentWave) ?? 0,
		targetCount,
		agents,
		results,
		policy,
		policyHistory,
		policyObservations,
		projectionHistory,
		manifest: normalizeManifest(value.manifest),
		startedAt: finiteNumber(value.startedAt) ?? Date.now(),
		lastResumedAt: finiteNumber(value.lastResumedAt),
		completedAt: finiteNumber(value.completedAt),
	};
}
function normalizeAgentState(name: string, value: unknown): AgentState | undefined {
	if (!isRecord(value)) return undefined;
	const recentTools = Array.isArray(value.recentTools)
		? value.recentTools.flatMap(entry => {
				if (!isRecord(entry)) return [];
				const tool = nonEmptyString(entry.tool);
				const args = typeof entry.args === "string" ? entry.args : undefined;
				const endMs = finiteNumber(entry.endMs);
				return tool && args !== undefined && endMs !== undefined ? [{ tool, args, endMs }] : [];
			})
		: undefined;
	return {
		name,
		status: isAgentStatus(value.status) ? value.status : "pending",
		iteration: nonNegativeInteger(value.iteration) ?? 0,
		wave: nonNegativeInteger(value.wave) ?? 0,
		attempt: nonNegativeInteger(value.attempt) ?? 0,
		startedAt: finiteNumber(value.startedAt),
		completedAt: finiteNumber(value.completedAt),
		error: optionalString(value.error),
		currentTool: optionalString(value.currentTool),
		currentToolArgs: optionalString(value.currentToolArgs),
		lastIntent: optionalString(value.lastIntent),
		recentTools,
	};
}

function isSingleResult(value: unknown): value is SingleResult {
	return (
		isRecord(value) &&
		nonNegativeInteger(value.index) !== undefined &&
		nonEmptyString(value.id) !== undefined &&
		nonEmptyString(value.agent) !== undefined &&
		isAgentSource(value.agentSource) &&
		typeof value.task === "string" &&
		typeof value.exitCode === "number" &&
		typeof value.output === "string" &&
		typeof value.stderr === "string" &&
		typeof value.truncated === "boolean" &&
		finiteNumber(value.durationMs) !== undefined &&
		finiteNumber(value.tokens) !== undefined &&
		finiteNumber(value.requests) !== undefined
	);
}

function normalizePolicyState(value: unknown): SwarmPolicyState | undefined {
	if (!isRecord(value)) return undefined;
	const decision = normalizePolicyDecision(value);
	const updatedAt = finiteNumber(value.updatedAt);
	if (!decision || updatedAt === undefined) return undefined;
	return {
		...decision,
		iteration: nonNegativeInteger(value.iteration),
		wave: nonNegativeInteger(value.wave),
		agent: optionalString(value.agent),
		updatedAt,
	};
}

function normalizePolicyDecision(value: Record<string, unknown>): SwarmPolicyDecision | undefined {
	if (!isPolicyBoundary(value.boundary) || typeof value.accepted !== "boolean") return undefined;
	if (!Array.isArray(value.failures) || !Array.isArray(value.evaluations)) return undefined;
	const failures = value.failures.flatMap(entry => {
		const failure = normalizePolicyFailure(entry);
		return failure ? [failure] : [];
	});
	const evaluations = value.evaluations.flatMap(entry => {
		const evaluation = normalizeEvaluationRecord(entry);
		return evaluation ? [evaluation] : [];
	});
	return { boundary: value.boundary, accepted: value.accepted, failures, evaluations };
}

function normalizePolicyFailure(value: unknown): SwarmPolicyFailure | undefined {
	if (!isRecord(value) || !isPolicyKind(value.source)) return undefined;
	const id = nonEmptyString(value.id);
	const message = nonEmptyString(value.message);
	if (!id || !message) return undefined;
	return {
		source: value.source,
		id,
		message,
		findings: Array.isArray(value.findings) ? value.findings : [],
		evidenceRefs: normalizeStringArray(value.evidenceRefs),
	};
}

function normalizeEvaluationRecord(value: unknown): SwarmEvaluationRecord | undefined {
	if (!isRecord(value)) return undefined;
	const id = nonEmptyString(value.id);
	const version = nonEmptyString(value.version);
	const explanation = typeof value.explanation === "string" ? value.explanation : undefined;
	if (!id || !version || explanation === undefined || !isPolicyOutcome(value.outcome)) return undefined;
	return {
		id,
		version,
		outcome: value.outcome,
		explanation,
		findings: Array.isArray(value.findings) ? value.findings : [],
		evidenceRefs: normalizeStringArray(value.evidenceRefs),
	};
}

function normalizePolicyObservation(value: unknown): SwarmPolicyObservationState | undefined {
	if (!isRecord(value)) return undefined;
	const agent = nonEmptyString(value.agent);
	const iteration = nonNegativeInteger(value.iteration);
	const attempt = nonNegativeInteger(value.attempt);
	const reference = nonEmptyString(value.reference);
	if (!agent || iteration === undefined || attempt === undefined || !reference) return undefined;
	return {
		agent,
		iteration,
		attempt,
		reference,
		before: value.before,
		after: value.after,
	};
}

function normalizeProjectionState(value: unknown): SwarmProjectionState | undefined {
	if (!isRecord(value)) return undefined;
	const targetId = nonEmptyString(value.targetId);
	const updatedAt = finiteNumber(value.updatedAt);
	if (!targetId || !isProjectionEventType(value.event) || !isPipelineStatus(value.status) || updatedAt === undefined) {
		return undefined;
	}
	return {
		targetId,
		event: value.event,
		status: value.status,
		detail: optionalString(value.detail),
		error: optionalString(value.error),
		updatedAt,
	};
}

function normalizeManifest(value: unknown): SwarmRunManifest | undefined {
	if (!isRecord(value) || !isRecord(value.environment)) return undefined;
	const environment = value.environment;
	const requiredEnvironment = ["platform", "arch", "bunVersion", "nodeVersion", "cwd"] as const;
	if (requiredEnvironment.some(key => typeof environment[key] !== "string")) return undefined;
	const models: Record<string, string | undefined> = {};
	if (isRecord(value.models)) {
		for (const [key, model] of Object.entries(value.models)) {
			if (model === undefined || typeof model === "string") models[key] = model;
		}
	}
	return {
		definitionPath: optionalString(value.definitionPath),
		definitionHash: nonEmptyString(value.definitionHash) ?? "legacy",
		workspace: typeof value.workspace === "string" ? value.workspace : "",
		ompVersion: optionalString(value.ompVersion),
		extensionVersion: optionalString(value.extensionVersion),
		repositoryRevision: optionalString(value.repositoryRevision),
		models,
		pluginPaths: normalizeStringArray(value.pluginPaths),
		environment: {
			platform: environment.platform as string,
			arch: environment.arch as string,
			bunVersion: environment.bunVersion as string,
			nodeVersion: environment.nodeVersion as string,
			cwd: environment.cwd as string,
			ci: optionalString(environment.ci),
		},
	};
}

function assertResumeCompatible(
	state: SwarmState,
	agentNames: readonly string[],
	targetCount: number,
	mode: SwarmMode,
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
	const runId = isRecord(value) ? nonEmptyString(value.runId) : undefined;
	const pid = isRecord(value) ? positiveInteger(value.pid) : undefined;
	const startedAt = isRecord(value) ? finiteNumber(value.startedAt) : undefined;
	const definitionHash = isRecord(value) ? nonEmptyString(value.definitionHash) : undefined;
	const workspace = isRecord(value) && typeof value.workspace === "string" ? value.workspace : undefined;
	if (runId && pid !== undefined && startedAt !== undefined && definitionHash && workspace !== undefined) {
		return { runId, pid, startedAt, definitionHash, workspace };
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
function isSwarmMode(value: unknown): value is SwarmMode {
	return value === "pipeline" || value === "parallel" || value === "sequential";
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
function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalString(value: unknown): string | undefined {
	return nonEmptyString(value);
}
function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(entry => {
		const normalized = nonEmptyString(entry);
		return normalized ? [normalized] : [];
	});
}

function isAgentSource(value: unknown): value is "bundled" | "user" | "project" {
	return value === "bundled" || value === "user" || value === "project";
}

function isPolicyBoundary(value: unknown): value is SwarmPolicyBoundary {
	return value === "agent" || value === "wave" || value === "iteration" || value === "complete";
}

function isPolicyKind(value: unknown): value is SwarmPolicyFailure["source"] {
	return value === "check" || value === "eval";
}

function isPolicyOutcome(value: unknown): value is SwarmEvaluationRecord["outcome"] {
	return value === "pass" || value === "fail";
}

function isProjectionEventType(value: unknown): value is SwarmProjectionEventType {
	return (
		value === "started" || value === "blocked" || value === "failed" || value === "aborted" || value === "completed"
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
function assertNonNegativeInteger(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative integer`);
	}
}
