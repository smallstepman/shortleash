// ============================================================================
// Raw JSON/YAML shape (snake_case, optional fields)
// ============================================================================

interface RawSwarmAgentConfig {
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
	/** `true`/`false` or `"parent"`/`"none"`; aliases are accepted for CLI ergonomics. */
	inherit_history?: unknown;
	history?: unknown;
	parent_history?: unknown;
	checks?: unknown;
	evals?: unknown;
}

interface RawSwarmConfig {
	[key: string]: unknown;
	name?: unknown;
	workspace?: unknown;
	/** Prompt used when this definition is executed in the current OMP session. */
	task?: unknown;
	mode?: unknown;
	target_count?: unknown;
	failure_policy?: unknown;
	max_concurrency?: unknown;
	agent_timeout_ms?: unknown;
	token_budget?: unknown;
	request_budget?: unknown;
	model?: unknown;
	isolation?: unknown;
	workspace_isolation?: unknown;
	inherit_history?: unknown;
	history?: unknown;
	parent_history?: unknown;
	plugins?: unknown;
	checks?: unknown;
	evals?: unknown;
	agents?: unknown;
}

// ============================================================================
// Normalized types (camelCase, defaults applied)
// ============================================================================

export type SwarmMode = "pipeline" | "parallel" | "sequential";

export type SwarmFailurePolicy = "fail_fast" | "continue" | "skip_dependents";

export type SwarmIsolationMode = "none" | "worktree";

export interface SwarmAgent {
	name: string;
	role: string;
	task: string;
	extraContext?: string;
	reportsTo: readonly string[];
	waitsFor: readonly string[];
	model?: string;
	/** Overrides the global workspace isolation mode for this agent. */
	workspaceIsolation?: SwarmIsolationMode;
	/** Overrides the global parent-history behavior for this agent. */
	inheritHistory?: boolean;
	checks: readonly SwarmPolicyRef[];
	evals: readonly SwarmPolicyRef[];
}

export interface SwarmDefinition {
	name: string;
	workspace: string;
	/** Prompt used when no agents are declared and the current OMP session runs the definition. */
	task?: string;
	/** Default isolation applied to every agent without an override. */
	workspaceIsolation: SwarmIsolationMode;
	/** Whether workers inherit the parent chat history by default. */
	inheritHistory: boolean;
	mode: SwarmMode;
	targetCount: number;
	failurePolicy: SwarmFailurePolicy;
	maxConcurrency?: number;
	agentTimeoutMs?: number;
	tokenBudget?: number;
	requestBudget?: number;
	model?: string;
	agents: ReadonlyMap<string, SwarmAgent>;
	plugins: readonly string[];
	checks: readonly SwarmPolicyRef[];
	evals: readonly SwarmPolicyRef[];
	/** Preserves definition declaration order for implicit pipeline sequencing. */
	agentOrder: readonly string[];
}

// ============================================================================
// Parsing
// ============================================================================

const VALID_MODES = new Set<string>(["pipeline", "parallel", "sequential"]);
const VALID_FAILURE_POLICIES = new Set<SwarmFailurePolicy>(["fail_fast", "continue", "skip_dependents"]);
const VALID_SWARM_NAME = /^[a-zA-Z0-9._-]+$/;
const VALID_POLICY_PARAM_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export const RAW_SWARM_KEYS: ReadonlySet<string> = new Set([
	"name",
	"workspace",
	"task",
	"mode",
	"target_count",
	"failure_policy",
	"max_concurrency",
	"agent_timeout_ms",
	"token_budget",
	"request_budget",
	"model",
	"isolation",
	"workspace_isolation",
	"inherit_history",
	"history",
	"parent_history",
	"plugins",
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
const VALID_ISOLATION_MODES = new Set<SwarmIsolationMode>(["none", "worktree"]);
function parsePositiveInteger(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${field} must be a positive integer`);
	}
	return value;
}

function parseFailurePolicy(value: unknown): SwarmFailurePolicy {
	if (value === undefined) return "skip_dependents";
	if (typeof value !== "string" || !VALID_FAILURE_POLICIES.has(value as SwarmFailurePolicy)) {
		throw new Error(
			`Invalid failure_policy '${String(value)}'. Must be one of: ${[...VALID_FAILURE_POLICIES].join(", ")}`,
		);
	}
	return value as SwarmFailurePolicy;
}
function firstDefined(...values: unknown[]): unknown {
	return values.find(value => value !== undefined);
}

function parseIsolationMode(value: unknown, field: string): SwarmIsolationMode | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !VALID_ISOLATION_MODES.has(value as SwarmIsolationMode)) {
		throw new Error(`${field} must be one of: none, worktree`);
	}
	return value as SwarmIsolationMode;
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

export type SwarmPolicyParam = string | number | boolean | null;
export type SwarmPolicyParams = Readonly<Record<string, SwarmPolicyParam>>;
export type SwarmPolicyRef =
	| string
	| {
			plugin?: string;
			id: string;
			params?: SwarmPolicyParams;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePolicyParamKey(key: string, field: string): void {
	if (!VALID_POLICY_PARAM_KEY.test(key)) {
		throw new Error(`${field} contains invalid parameter key '${key}'`);
	}
}

function isPolicyParam(value: unknown): value is SwarmPolicyParam {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

export function normalizePolicyParams(value: unknown, field: string): SwarmPolicyParams | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${field} must be an object of scalar values`);

	const params: Record<string, SwarmPolicyParam> = {};
	for (const [key, raw] of Object.entries(value)) {
		validatePolicyParamKey(key, field);
		if (!isPolicyParam(raw)) {
			throw new Error(`${field}.${key} must be a string, finite number, boolean, or null`);
		}
		params[key] = typeof raw === "string" ? raw.trim() : raw;
	}
	return params;
}

function parseInlineParamValue(value: string, field: string): SwarmPolicyParam {
	let decoded: string;
	try {
		decoded = decodeURIComponent(value.trim());
	} catch {
		throw new Error(`${field} contains an invalid percent-encoded value`);
	}
	if (decoded === "true") return true;
	if (decoded === "false") return false;
	if (decoded === "null") return null;
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(decoded)) return Number(decoded);
	return decoded;
}

export function parsePolicyRef(value: string, field = "policy reference"): SwarmPolicyRef {
	const text = value.trim();
	if (text.length === 0) throw new Error(`${field} must not be empty`);

	const segments = text.split("::");
	const head = segments.shift()!;
	if (segments.length === 0) return text;
	const separator = head.indexOf(":");
	if (separator !== -1 && head.indexOf(":", separator + 1) !== -1) {
		throw new Error(`${field} must contain at most one plugin separator`);
	}
	const plugin = separator === -1 ? undefined : head.slice(0, separator).trim();
	const id = (separator === -1 ? head : head.slice(separator + 1)).trim();
	if (plugin !== undefined && plugin.length === 0) throw new Error(`${field} plugin must not be empty`);
	if (id.length === 0) throw new Error(`${field} id must not be empty`);

	const params: Record<string, SwarmPolicyParam> = {};
	for (const [index, segment] of segments.entries()) {
		const equals = segment.indexOf("=");
		if (equals <= 0) throw new Error(`${field} parameter ${index + 1} must use key=value`);
		const key = segment.slice(0, equals).trim();
		validatePolicyParamKey(key, `${field} parameter ${index + 1}`);
		if (Object.hasOwn(params, key)) throw new Error(`${field} contains duplicate parameter '${key}'`);
		params[key] = parseInlineParamValue(segment.slice(equals + 1), `${field} parameter ${index + 1}`);
	}

	return {
		...(plugin !== undefined ? { plugin } : {}),
		id,
		params,
	};
}

function parsePolicyRefs(value: unknown, field: string): SwarmPolicyRef[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);

	return value.map((entry, index) => {
		if (typeof entry === "string") return parsePolicyRef(entry, `${field}[${index}]`);
		if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim().length === 0) {
			throw new Error(`${field}[${index}] must be a string or an object with an id`);
		}
		if (entry.plugin !== undefined && (typeof entry.plugin !== "string" || entry.plugin.trim().length === 0)) {
			throw new Error(`${field}[${index}].plugin must be a non-empty string when provided`);
		}
		const params = normalizePolicyParams(entry.params, `${field}[${index}].params`);
		return {
			...(typeof entry.plugin === "string" ? { plugin: entry.plugin.trim() } : {}),
			id: entry.id.trim(),
			...(params === undefined ? {} : { params }),
		};
	});
}

function parsePluginPaths(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || entry.trim().length === 0)) {
		throw new Error("swarm.plugins must be an array of non-empty strings");
	}
	return value.map(entry => entry.trim());
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
export function validateSwarmInput(value: unknown, field = "swarm"): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	rejectRemovedPolicyFields(value, field);
	assertKnownKeys(value, RAW_SWARM_KEYS, field);
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

export function parseSwarm(content: string): SwarmDefinition {
	const raw = parseStructuredDocument(content);
	if (!isRecord(raw) || !isRecord(raw.swarm)) {
		throw new Error("Swarm definition must have a top-level 'swarm' key");
	}
	validateSwarmInput(raw.swarm);
	const swarm = raw.swarm as RawSwarmConfig;
	rejectRemovedPolicyFields(swarm, "swarm");

	const name = parseRequiredString(swarm.name, "swarm.name");
	if (!VALID_SWARM_NAME.test(name)) {
		throw new Error("swarm.name may only contain letters, numbers, dot, underscore, and dash");
	}
	const workspace = parseRequiredString(swarm.workspace, "swarm.workspace");
	const task = parseOptionalString(swarm.task, "swarm.task");
	const rawAgents = swarm.agents;
	if (rawAgents !== undefined && (!isRecord(rawAgents) || Object.keys(rawAgents).length === 0)) {
		throw new Error("swarm.agents must contain at least one agent when provided");
	}

	const modeValue = swarm.mode ?? "sequential";
	if (typeof modeValue !== "string" || !VALID_MODES.has(modeValue)) {
		throw new Error(`Invalid mode '${String(modeValue)}'. Must be one of: ${[...VALID_MODES].join(", ")}`);
	}
	const mode = modeValue as SwarmMode;
	const workspaceIsolation =
		parseIsolationMode(firstDefined(swarm.isolation, swarm.workspace_isolation), "swarm.isolation") ?? "none";
	const inheritHistory =
		parseHistoryInheritance(
			firstDefined(swarm.inherit_history, swarm.history, swarm.parent_history),
			"swarm.inherit_history",
		) ?? false;
	const targetCount = parsePositiveInteger(swarm.target_count ?? 1, "swarm.target_count")!;
	const failurePolicy = parseFailurePolicy(swarm.failure_policy);
	const maxConcurrency = parsePositiveInteger(swarm.max_concurrency, "swarm.max_concurrency");
	const agentTimeoutMs = parsePositiveInteger(swarm.agent_timeout_ms, "swarm.agent_timeout_ms");
	const tokenBudget = parsePositiveInteger(swarm.token_budget, "swarm.token_budget");
	const requestBudget = parsePositiveInteger(swarm.request_budget, "swarm.request_budget");
	const model = parseOptionalString(swarm.model, "swarm.model");
	const checks = parsePolicyRefs(swarm.checks, "swarm.checks");
	const evals = parsePolicyRefs(swarm.evals, "swarm.evals");

	const agentOrder: string[] = [];
	const agents = new Map<string, SwarmAgent>();
	const agentEntries = isRecord(rawAgents) ? Object.entries(rawAgents) : [];

	for (const [agentName, rawConfig] of agentEntries) {
		if (!isRecord(rawConfig)) {
			throw new Error(`Agent '${agentName}' must be an object`);
		}
		const config = rawConfig as RawSwarmAgentConfig;
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
		mode,
		targetCount,
		failurePolicy,
		maxConcurrency,
		agentTimeoutMs,
		tokenBudget,
		requestBudget,
		model,
		agents,
		plugins: parsePluginPaths(swarm.plugins),
		checks,
		evals,
		agentOrder,
	};
}

/** Resolve an agent's effective workspace isolation mode. */
export function resolveSwarmIsolation(definition: SwarmDefinition, agent: SwarmAgent): SwarmIsolationMode {
	return agent.workspaceIsolation ?? definition.workspaceIsolation;
}

/** Resolve whether an agent receives the parent chat history. */
export function resolveSwarmHistoryInheritance(definition: SwarmDefinition, agent: SwarmAgent): boolean {
	return agent.inheritHistory ?? definition.inheritHistory;
}

function parseStructuredDocument(content: string): unknown {
	if (content.trim().length === 0) {
		throw new Error("Swarm definition must not be empty");
	}

	try {
		return JSON.parse(content);
	} catch {
		try {
			return Bun.YAML.parse(content);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Swarm definition must be valid JSON or YAML: ${message}`);
		}
	}
}

// ============================================================================
// Validation (semantic — references, constraints)
// ============================================================================

export function validateSwarmDefinition(def: SwarmDefinition): string[] {
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

	if (def.targetCount < 1) {
		errors.push("target_count must be at least 1");
	}
	if (def.mode !== "pipeline" && def.targetCount !== 1) {
		errors.push("target_count is only supported in pipeline mode");
	}
	if (def.agents.size === 0 && def.targetCount !== 1) {
		errors.push("direct current-session definitions support exactly one target_count");
	}

	return errors;
}
/**
 * Convert the normalized definition into a stable, JSON-safe representation.
 * The declaration order is retained because it affects implicit pipeline edges.
 */
export function serializeSwarmDefinition(definition: SwarmDefinition): Record<string, unknown> {
	return {
		name: definition.name,
		workspace: definition.workspace,
		task: definition.task,
		workspaceIsolation: definition.workspaceIsolation,
		inheritHistory: definition.inheritHistory,
		mode: definition.mode,
		targetCount: definition.targetCount,
		failurePolicy: definition.failurePolicy,
		maxConcurrency: definition.maxConcurrency,
		agentTimeoutMs: definition.agentTimeoutMs,
		tokenBudget: definition.tokenBudget,
		requestBudget: definition.requestBudget,
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
		plugins: definition.plugins,
		checks: definition.checks,
		evals: definition.evals,
		agentOrder: definition.agentOrder,
	};
}

/** Return a stable hash used to decide whether persisted state can be resumed. */
export function fingerprintSwarmDefinition(definition: SwarmDefinition): string {
	const serialized = JSON.stringify(serializeSwarmDefinition(definition));
	return new Bun.CryptoHasher("sha256").update(serialized).digest("hex");
}
