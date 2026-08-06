import { buildDependencyGraph, detectCycles } from "../execution/dag";
import { parseSwarm, RAW_AGENT_KEYS, RAW_SWARM_KEYS, type SwarmDefinition, validateSwarmDefinition } from "./schema";

const scalarJsonSchema = {
	type: ["string", "number", "boolean", "null"],
} as const;

const policyParamsJsonSchema = {
	type: "object",
	additionalProperties: scalarJsonSchema,
} as const;

const policyReferenceJsonSchema = {
	oneOf: [
		{ type: "string", minLength: 1 },
		{
			type: "object",
			required: ["id"],
			additionalProperties: false,
			properties: {
				plugin: { type: "string", minLength: 1 },
				id: { type: "string", minLength: 1 },
				params: policyParamsJsonSchema,
			},
		},
	],
} as const;

const isolationJsonSchema = { type: "string", enum: ["none", "worktree"] } as const;
const historyJsonSchema = {
	oneOf: [{ type: "boolean" }, { type: "string", enum: ["parent", "inherit", "none", "isolated"] }],
} as const;

const agentJsonSchema = {
	type: "object",
	required: ["role", "task"],
	additionalProperties: false,
	properties: {
		role: { type: "string", minLength: 1 },
		task: { type: "string", minLength: 1 },
		extra_context: { type: "string" },
		reports_to: { type: "array", items: { type: "string", minLength: 1 } },
		waits_for: { type: "array", items: { type: "string", minLength: 1 } },
		model: { type: "string", minLength: 1 },
		isolation: isolationJsonSchema,
		workspace_isolation: isolationJsonSchema,
		inherit_history: historyJsonSchema,
		history: historyJsonSchema,
		parent_history: historyJsonSchema,
		checks: { type: "array", items: policyReferenceJsonSchema },
		evals: { type: "array", items: policyReferenceJsonSchema },
	},
} as const;

/** JSON Schema for the value stored at `metadata.shortleash`. */
export const SWARM_DEFINITION_JSON_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://omp.sh/schemas/swarm-definition.json",
	title: "OMP Shortleash swarm definition",
	type: "object",
	required: ["name", "workspace"],
	additionalProperties: false,
	properties: {
		name: { type: "string", minLength: 1, pattern: "^[a-zA-Z0-9._-]+$" },
		workspace: { type: "string", minLength: 1 },
		task: { type: "string", minLength: 1 },
		mode: { type: "string", enum: ["pipeline", "parallel", "sequential"] },
		target_count: { type: "integer", minimum: 1 },
		failure_policy: { type: "string", enum: ["fail_fast", "continue", "skip_dependents"] },
		max_concurrency: { type: "integer", minimum: 1 },
		agent_timeout_ms: { type: "integer", minimum: 1 },
		token_budget: { type: "integer", minimum: 1 },
		request_budget: { type: "integer", minimum: 1 },
		model: { type: "string", minLength: 1 },
		isolation: isolationJsonSchema,
		workspace_isolation: isolationJsonSchema,
		inherit_history: historyJsonSchema,
		history: historyJsonSchema,
		parent_history: historyJsonSchema,
		plugins: { type: "array", items: { type: "string", minLength: 1 } },
		checks: { type: "array", items: policyReferenceJsonSchema },
		evals: { type: "array", items: policyReferenceJsonSchema },
		agents: {
			type: "object",
			minProperties: 1,
			propertyNames: { minLength: 1 },
			additionalProperties: agentJsonSchema,
		},
	},
} as const;

/** JSON Schema for Beads metadata carrying an optional Shortleash configuration. */
export const SWARM_METADATA_JSON_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://omp.sh/schemas/beads-metadata.json",
	title: "Beads metadata with optional Shortleash configuration",
	type: "object",
	additionalProperties: true,
	properties: {
		shortleash: SWARM_DEFINITION_JSON_SCHEMA,
	},
} as const;

export function hasSwarmMetadata(value: unknown): boolean {
	try {
		return Object.hasOwn(normalizeMetadataObject(value, "metadata"), "shortleash");
	} catch {
		return false;
	}
}

/** Validate and normalize a Beads metadata object containing `metadata.shortleash`. */
export function validateSwarmMetadata(value: unknown, field = "metadata"): SwarmDefinition {
	const metadata = normalizeMetadataObject(value, field);
	if (!Object.hasOwn(metadata, "shortleash") || !isRecord(metadata.shortleash)) {
		throw new Error(`${field} must contain an object at '${field}.shortleash'`);
	}

	validateRawSwarmConfig(metadata.shortleash, `${field}.shortleash`);
	const definition = parseSwarm(JSON.stringify({ swarm: metadata.shortleash }));
	const semanticErrors = validateSwarmDefinition(definition);
	const cycles = detectCycles(buildDependencyGraph(definition));
	if (cycles) semanticErrors.push(`cycle detected in agent dependencies: [${cycles.join(", ")}]`);
	if (semanticErrors.length > 0) {
		throw new Error(`${field}.shortleash is invalid:\n${semanticErrors.map(error => `  - ${error}`).join("\n")}`);
	}
	return definition;
}

export function normalizeMetadataObject(value: unknown, field = "metadata"): Record<string, unknown> {
	if (isRecord(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed)) return parsed;
		} catch {
			// Fall through to the actionable error below.
		}
		throw new Error(`${field} must be a JSON object`);
	}
	throw new Error(`${field} must be a JSON object`);
}

function validateRawSwarmConfig(value: Record<string, unknown>, field: string): void {
	assertKnownKeys(value, RAW_SWARM_KEYS, field);
	assertString(value.name, `${field}.name`, { required: true, pattern: /^[a-zA-Z0-9._-]+$/ });
	assertString(value.workspace, `${field}.workspace`, { required: true });
	assertString(value.task, `${field}.task`);
	assertOptionalPositiveInteger(value.target_count, `${field}.target_count`);
	assertOptionalEnum(value.failure_policy, `${field}.failure_policy`, ["fail_fast", "continue", "skip_dependents"]);
	assertOptionalPositiveInteger(value.max_concurrency, `${field}.max_concurrency`);
	assertOptionalPositiveInteger(value.agent_timeout_ms, `${field}.agent_timeout_ms`);
	assertOptionalPositiveInteger(value.token_budget, `${field}.token_budget`);
	assertOptionalPositiveInteger(value.request_budget, `${field}.request_budget`);
	assertString(value.model, `${field}.model`);
	assertOptionalIsolation(value.isolation, `${field}.isolation`);
	assertOptionalIsolation(value.workspace_isolation, `${field}.workspace_isolation`);
	assertOptionalHistory(value.inherit_history, `${field}.inherit_history`);
	assertOptionalHistory(value.history, `${field}.history`);
	assertOptionalHistory(value.parent_history, `${field}.parent_history`);
	assertStringArray(value.plugins, `${field}.plugins`);
	assertPolicyRefArray(value.checks, `${field}.checks`);
	assertPolicyRefArray(value.evals, `${field}.evals`);

	if (value.agents !== undefined) {
		if (!isRecord(value.agents) || Object.keys(value.agents).length === 0) {
			throw new Error(`${field}.agents must contain at least one agent when provided`);
		}
		for (const [name, rawAgent] of Object.entries(value.agents)) {
			if (name.trim().length === 0) throw new Error(`${field}.agents must not contain an empty agent name`);
			if (!isRecord(rawAgent)) throw new Error(`${field}.agents.${name} must be an object`);
			validateRawAgentConfig(rawAgent, `${field}.agents.${name}`);
		}
	}
}

function validateRawAgentConfig(value: Record<string, unknown>, field: string): void {
	assertKnownKeys(value, RAW_AGENT_KEYS, field);
	assertString(value.role, `${field}.role`, { required: true });
	assertString(value.task, `${field}.task`, { required: true });
	assertString(value.extra_context, `${field}.extra_context`);
	assertStringArray(value.reports_to, `${field}.reports_to`);
	assertStringArray(value.waits_for, `${field}.waits_for`);
	assertString(value.model, `${field}.model`);
	assertOptionalIsolation(value.isolation, `${field}.isolation`);
	assertOptionalIsolation(value.workspace_isolation, `${field}.workspace_isolation`);
	assertOptionalHistory(value.inherit_history, `${field}.inherit_history`);
	assertOptionalHistory(value.history, `${field}.history`);
	assertOptionalHistory(value.parent_history, `${field}.parent_history`);
	assertPolicyRefArray(value.checks, `${field}.checks`);
	assertPolicyRefArray(value.evals, `${field}.evals`);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${field}.${key} is not allowed`);
	}
}

function assertString(value: unknown, field: string, options: { required?: boolean; pattern?: RegExp } = {}): void {
	if (value === undefined && !options.required) return;
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
	if (options.pattern && !options.pattern.test(value)) throw new Error(`${field} has an invalid format`);
}

function assertStringArray(value: unknown, field: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || entry.trim().length === 0)) {
		throw new Error(`${field} must be an array of non-empty strings`);
	}
}

function assertOptionalPositiveInteger(value: unknown, field: string): void {
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${field} must be a positive integer`);
	}
}

function assertOptionalEnum(value: unknown, field: string, allowed: readonly string[]): void {
	if (value === undefined) return;
	if (typeof value !== "string" || !allowed.includes(value)) {
		throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
	}
}

function assertOptionalIsolation(value: unknown, field: string): void {
	assertOptionalEnum(value, field, ["none", "worktree"]);
}

function assertOptionalHistory(value: unknown, field: string): void {
	if (value === undefined) return;
	if (typeof value === "boolean") return;
	assertOptionalEnum(value, field, ["parent", "inherit", "none", "isolated"]);
}

function assertPolicyRefArray(value: unknown, field: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
	for (const [index, entry] of value.entries()) {
		const entryField = `${field}[${index}]`;
		if (typeof entry === "string") {
			if (entry.trim().length === 0) throw new Error(`${entryField} must not be empty`);
			continue;
		}
		if (!isRecord(entry)) throw new Error(`${entryField} must be a string or an object with an id`);
		assertKnownKeys(entry, new Set(["plugin", "id", "params"]), entryField);
		assertString(entry.id, `${entryField}.id`, { required: true });
		assertString(entry.plugin, `${entryField}.plugin`);
		if (entry.params !== undefined) {
			if (!isRecord(entry.params)) throw new Error(`${entryField}.params must be an object of scalar values`);
			for (const [key, parameter] of Object.entries(entry.params)) {
				if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
					throw new Error(`${entryField}.params contains invalid parameter key '${key}'`);
				}
				if (!isJsonScalar(parameter)) {
					throw new Error(`${entryField}.params.${key} must be a string, finite number, boolean, or null`);
				}
			}
		}
	}
}

function isJsonScalar(value: unknown): boolean {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
