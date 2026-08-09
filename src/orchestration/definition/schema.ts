// ============================================================================
// Raw JSON shape (snake_case, optional fields)
// ============================================================================

interface RawShortleashAgentConfig {
	[key: string]: unknown;
	role?: unknown;
	task?: unknown;
	extra_context?: unknown;
	reports_to?: unknown;
	waits_for?: unknown;
	model?: unknown;
	/** Preferred key; `workspace_isolation` is accepted as an explicit alias. */
	isolation?: unknown;
	workspace_isolation?: unknown;
	/** `true`/`false` or `"parent"`/`"none"`; aliases are accepted for configuration ergonomics. */
	inherit_history?: unknown;
	history?: unknown;
	parent_history?: unknown;
	checks?: unknown;
	evals?: unknown;
}

interface RawShortleashConfig {
	[key: string]: unknown;
	name?: unknown;
	workspace?: unknown;
	/** Prompt used when this definition is executed in the current OMP session. */
	task?: unknown;
	failure_policy?: unknown;
	agent_timeout_ms?: unknown;
	model?: unknown;
	isolation?: unknown;
	workspace_isolation?: unknown;
	inherit_history?: unknown;
	history?: unknown;
	parent_history?: unknown;
	checks?: unknown;
	evals?: unknown;
	agents?: unknown;
}

// ============================================================================
// Normalized types (camelCase, defaults applied)
// ============================================================================

export type ShortleashFailurePolicy = "fail_fast" | "continue" | "skip_dependents";

export type ShortleashIsolationMode = "none" | "worktree";

export interface ShortleashAgent {
	name: string;
	role: string;
	task: string;
	extraContext?: string;
	reportsTo: readonly string[];
	waitsFor: readonly string[];
	model?: string;
	/** Overrides the global workspace isolation mode for this agent. */
	workspaceIsolation?: ShortleashIsolationMode;
	/** Overrides the global parent-history behavior for this agent. */
	inheritHistory?: boolean;
	checks: readonly ShortleashPolicyRef[];
	evals: readonly ShortleashPolicyRef[];
}

export interface ShortleashDefinition {
	name: string;
	workspace: string;
	/** Prompt used when no agents are declared and the current OMP session runs the definition. */
	task?: string;
	/** Default isolation applied to every agent without an override. */
	workspaceIsolation: ShortleashIsolationMode;
	/** Whether workers inherit the parent chat history by default. */
	inheritHistory: boolean;
	failurePolicy: ShortleashFailurePolicy;
	agentTimeoutMs?: number;
	model?: string;
	agents: ReadonlyMap<string, ShortleashAgent>;
	checks: readonly ShortleashPolicyRef[];
	evals: readonly ShortleashPolicyRef[];
	/** Preserves definition declaration order for stable presentation and serialization. */
	agentOrder: readonly string[];
}

// ============================================================================
// Parsing
// ============================================================================

const VALID_FAILURE_POLICIES = new Set<ShortleashFailurePolicy>(["fail_fast", "continue", "skip_dependents"]);
const VALID_SHORTLEASH_NAME = /^[a-zA-Z0-9._-]+$/;
const VALID_POLICY_PARAM_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export const RAW_SHORTLEASH_KEYS: ReadonlySet<string> = new Set([
	"name",
	"workspace",
	"task",
	"failure_policy",
	"agent_timeout_ms",
	"model",
	"isolation",
	"workspace_isolation",
	"inherit_history",
	"history",
	"parent_history",
	"checks",
	"evals",
	"agents",
]);
export const RAW_AGENT_KEYS: ReadonlySet<string> = new Set([
	"role",
	"task",
	"extra_context",
	"reports_to",
	"waits_for",
	"model",
	"isolation",
	"workspace_isolation",
	"inherit_history",
	"history",
	"parent_history",
	"checks",
	"evals",
]);
const VALID_SHORTLEASH_ISOLATION_MODES = new Set<ShortleashIsolationMode>(["none", "worktree"]);
function parsePositiveInteger(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${field} must be a positive integer`);
	}
	return value;
}

function parseFailurePolicy(value: unknown): ShortleashFailurePolicy {
	if (value === undefined) return "skip_dependents";
	if (typeof value !== "string" || !VALID_FAILURE_POLICIES.has(value as ShortleashFailurePolicy)) {
		throw new Error(
			`Invalid failure_policy '${String(value)}'. Must be one of: ${[...VALID_FAILURE_POLICIES].join(", ")}`,
		);
	}
	return value as ShortleashFailurePolicy;
}

function firstDefined(...values: unknown[]): unknown {
	return values.find(value => value !== undefined);
}

function parseIsolationMode(value: unknown, field: string): ShortleashIsolationMode | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !VALID_SHORTLEASH_ISOLATION_MODES.has(value as ShortleashIsolationMode)) {
		throw new Error(`${field} must be one of: none, worktree`);
	}
	return value as ShortleashIsolationMode;
}

function parseHistoryInheritance(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value === "parent" || value === "inherit") return true;
		if (value === "none" || value === "isolated") return false;
	}
	throw new Error(`${field} must be a boolean or one of: parent, none`);
}

export type ShortleashPolicyParam = string | number | boolean | null;
export type ShortleashPolicyParams = Readonly<Record<string, ShortleashPolicyParam>>;
export interface ShortleashPolicyRefObject {
	path: string;
	params?: ShortleashPolicyParams;
}
export type ShortleashPolicyRef = string | ShortleashPolicyRefObject;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePolicyParamKey(key: string, field: string): void {
	if (!VALID_POLICY_PARAM_KEY.test(key)) {
		throw new Error(`${field} contains invalid parameter key '${key}'`);
	}
}

function isPolicyParam(value: unknown): value is ShortleashPolicyParam {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

export function normalizePolicyParams(value: unknown, field: string): ShortleashPolicyParams | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${field} must be an object of scalar values`);

	const params: Record<string, ShortleashPolicyParam> = {};
	for (const [key, raw] of Object.entries(value)) {
		validatePolicyParamKey(key, field);
		if (!isPolicyParam(raw)) {
			throw new Error(`${field}.${key} must be a string, finite number, boolean, or null`);
		}
		params[key] = typeof raw === "string" ? raw.trim() : raw;
	}
	return params;
}

export function parseShortleashPolicyPath(value: string, field = "policy path"): string {
	const text = value.trim();
	if (text.length === 0) throw new Error(`${field} must not be empty`);
	if (!text.endsWith(".ts")) throw new Error(`${field} must point to a .ts file`);
	return text;
}

function parsePolicyRefs(value: unknown, field: string): ShortleashPolicyRef[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);

	return value.map((entry, index) => {
		if (typeof entry === "string") return parseShortleashPolicyPath(entry, `${field}[${index}]`);
		if (!isRecord(entry) || typeof entry.path !== "string") {
			throw new Error(`${field}[${index}] must be a .ts path or an object with a path`);
		}
		assertKnownKeys(entry, new Set(["path", "params"]), `${field}[${index}]`);
		const policyPath = parseShortleashPolicyPath(entry.path, `${field}[${index}].path`);
		const params = normalizePolicyParams(entry.params, `${field}[${index}].params`);
		return {
			path: policyPath,
			...(params === undefined ? {} : { params }),
		};
	});
}
function rejectRemovedPolicyFields(value: Record<string, unknown>, field: string): void {
	if (Object.hasOwn(value, "rules") || Object.hasOwn(value, "must")) {
		throw new Error(`${field} uses removed policy fields; use checks instead`);
	}
}
function parseOptionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string when provided`);
	}
	return value.trim();
}

function parseRequiredString(value: unknown, field: string): string {
	const parsed = parseOptionalString(value, field);
	if (parsed === undefined) throw new Error(`${field} is required and must be a string`);
	return parsed;
}

function parseStringArray(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || entry.trim().length === 0)) {
		throw new Error(`${field} must be an array of non-empty strings`);
	}
	return value.map(entry => entry.trim());
}
/** Validate the untrusted raw definition shape before normalization. */
export function validateShortleashInput(value: unknown, field = "swarm"): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	rejectRemovedPolicyFields(value, field);
	assertKnownKeys(value, RAW_SHORTLEASH_KEYS, field);
	if (value.agents === undefined) return;
	if (!isRecord(value.agents) || Object.keys(value.agents).length === 0) {
		throw new Error(`${field}.agents must contain at least one agent when provided`);
	}
	for (const [name, agent] of Object.entries(value.agents)) {
		if (name.trim().length === 0) throw new Error(`${field}.agents must not contain an empty agent name`);
		if (!isRecord(agent)) throw new Error(`${field}.agents.${name} must be an object`);
		rejectRemovedPolicyFields(agent, `${field}.agents.${name}`);
		assertKnownKeys(agent, RAW_AGENT_KEYS, `${field}.agents.${name}`);
	}
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${field}.${key} is not allowed`);
	}
}

export function parseShortleash(content: string): ShortleashDefinition {
	if (content.trim().length === 0) {
		throw new Error("Shortleash definition must not be empty");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Shortleash definition must be valid JSON: ${message}`);
	}
	if (!isRecord(raw) || !isRecord(raw.swarm)) {
		throw new Error("Shortleash definition must have a top-level 'swarm' key");
	}
	validateShortleashInput(raw.swarm);
	const config = raw.swarm as RawShortleashConfig;
	rejectRemovedPolicyFields(config, "swarm");

	const name = parseRequiredString(config.name, "swarm.name");
	if (!VALID_SHORTLEASH_NAME.test(name)) {
		throw new Error("swarm.name may only contain letters, numbers, dot, underscore, and dash");
	}
	const workspace = parseRequiredString(config.workspace, "swarm.workspace");
	const task = parseOptionalString(config.task, "swarm.task");
	const rawAgents = config.agents;
	if (rawAgents !== undefined && (!isRecord(rawAgents) || Object.keys(rawAgents).length === 0)) {
		throw new Error("swarm.agents must contain at least one agent when provided");
	}

	const workspaceIsolation =
		parseIsolationMode(firstDefined(config.isolation, config.workspace_isolation), "swarm.isolation") ?? "none";
	const inheritHistory =
		parseHistoryInheritance(
			firstDefined(config.inherit_history, config.history, config.parent_history),
			"swarm.inherit_history",
		) ?? false;
	const failurePolicy = parseFailurePolicy(config.failure_policy);
	const agentTimeoutMs = parsePositiveInteger(config.agent_timeout_ms, "swarm.agent_timeout_ms");
	const model = parseOptionalString(config.model, "swarm.model");
	const checks = parsePolicyRefs(config.checks, "swarm.checks");
	const evals = parsePolicyRefs(config.evals, "swarm.evals");

	const agentOrder: string[] = [];
	const agents = new Map<string, ShortleashAgent>();
	const agentEntries = isRecord(rawAgents) ? Object.entries(rawAgents) : [];

	for (const [agentName, rawConfig] of agentEntries) {
		if (!isRecord(rawConfig)) {
			throw new Error(`Agent '${agentName}' must be an object`);
		}
		const config = rawConfig as RawShortleashAgentConfig;
		rejectRemovedPolicyFields(config, `swarm.agents.${agentName}`);
		const role = parseRequiredString(config.role, `Agent '${agentName}': 'role'`);
		const agentTask = parseRequiredString(config.task, `Agent '${agentName}': 'task'`);

		agentOrder.push(agentName);
		agents.set(agentName, {
			name: agentName,
			role,
			task: agentTask,
			extraContext: parseOptionalString(config.extra_context, `swarm.agents.${agentName}.extra_context`),
			reportsTo: parseStringArray(config.reports_to, `swarm.agents.${agentName}.reports_to`),
			model: parseOptionalString(config.model, `swarm.agents.${agentName}.model`),
			workspaceIsolation: parseIsolationMode(
				firstDefined(config.isolation, config.workspace_isolation),
				`swarm.agents.${agentName}.isolation`,
			),
			inheritHistory: parseHistoryInheritance(
				firstDefined(config.inherit_history, config.history, config.parent_history),
				`swarm.agents.${agentName}.inherit_history`,
			),
			waitsFor: parseStringArray(config.waits_for, `swarm.agents.${agentName}.waits_for`),
			checks: [...checks, ...parsePolicyRefs(config.checks, `swarm.agents.${agentName}.checks`)],
			evals: [...evals, ...parsePolicyRefs(config.evals, `swarm.agents.${agentName}.evals`)],
		});
	}

	return {
		name,
		workspace,
		task,
		workspaceIsolation,
		inheritHistory,
		failurePolicy,
		agentTimeoutMs,
		model,
		agents,
		checks,
		evals,
		agentOrder,
	};
}

/** Resolve an agent's effective workspace isolation mode. */
export function resolveShortleashIsolation(
	definition: ShortleashDefinition,
	agent: ShortleashAgent,
): ShortleashIsolationMode {
	return agent.workspaceIsolation ?? definition.workspaceIsolation;
}

/** Resolve whether an agent receives the parent chat history. */
export function resolveShortleashHistoryInheritance(definition: ShortleashDefinition, agent: ShortleashAgent): boolean {
	return agent.inheritHistory ?? definition.inheritHistory;
}

// ============================================================================
// Validation (semantic — references, constraints)
// ============================================================================

export function validateShortleashDefinition(def: ShortleashDefinition): string[] {
	const errors: string[] = [];
	const agentNames = new Set(def.agents.keys());

	if (def.model !== undefined && def.model.length === 0) {
		errors.push("swarm.model must not be empty when provided");
	}
	for (const [name, agent] of def.agents) {
		for (const dep of agent.waitsFor) {
			if (!agentNames.has(dep)) {
				errors.push(`Agent '${name}' waits_for unknown agent '${dep}'`);
			}
			if (dep === name) {
				errors.push(`Agent '${name}' cannot wait for itself`);
			}
		}
		for (const target of agent.reportsTo) {
			if (!agentNames.has(target)) {
				errors.push(`Agent '${name}' reports_to unknown agent '${target}'`);
			}
			if (target === name) {
				errors.push(`Agent '${name}' cannot report to itself`);
			}
		}
		if (agent.model !== undefined && agent.model.length === 0) {
			errors.push(`Agent '${name}' model must not be empty when provided`);
		}
	}

	return errors;
}
/**
 * Convert the normalized definition into a stable, JSON-safe representation.
 * Declaration order remains available for stable presentation and serialization.
 */
export function serializeShortleashDefinition(definition: ShortleashDefinition): Record<string, unknown> {
	return {
		name: definition.name,
		workspace: definition.workspace,
		task: definition.task,
		workspaceIsolation: definition.workspaceIsolation,
		inheritHistory: definition.inheritHistory,
		failurePolicy: definition.failurePolicy,
		agentTimeoutMs: definition.agentTimeoutMs,
		model: definition.model,
		agents: definition.agentOrder.map(name => {
			const agent = definition.agents.get(name)!;
			return {
				name: agent.name,
				role: agent.role,
				task: agent.task,
				extraContext: agent.extraContext,
				reportsTo: agent.reportsTo,
				waitsFor: agent.waitsFor,
				model: agent.model,
				workspaceIsolation: agent.workspaceIsolation,
				inheritHistory: agent.inheritHistory,
				checks: agent.checks,
				evals: agent.evals,
			};
		}),
		checks: definition.checks,
		evals: definition.evals,
		agentOrder: definition.agentOrder,
	};
}

/** Return a stable hash used to decide whether persisted state can be resumed. */
export function fingerprintShortleashDefinition(definition: ShortleashDefinition): string {
	const serialized = JSON.stringify(serializeShortleashDefinition(definition));
	return new Bun.CryptoHasher("sha256").update(serialized).digest("hex");
}
