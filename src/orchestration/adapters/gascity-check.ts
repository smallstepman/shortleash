import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import { type BeadsCommandRunner, extractBeadsData, runBeadsJson } from "../../beads/client";
import type { ShortleashAgent, ShortleashDefinition, ShortleashPolicyRef } from "../definition/schema";
import type { ShortleashState } from "../execution/state";
import {
	loadShortleashPolicyModules,
	type ShortleashPolicyContext,
	type ShortleashPolicyDecision,
	type ShortleashPolicyReferences,
} from "../policy/policies";

export interface GasCityPolicyModuleSnapshot {
	path: string;
	sha256: string;
}

export interface GasCityPolicyBridgeConfig {
	schemaVersion: 1;
	key: string;
	boundary: "agent" | "complete";
	agentName?: string;
	definition: Record<string, unknown>;
	definitionDir: string;
	definitionHash: string;
	cwd: string;
	workspace: string;
	shortleashDir: string;
	policyModules: readonly GasCityPolicyModuleSnapshot[];
	references: ShortleashPolicyReferences;
	historyPath: string;
	allHistoryPaths: Readonly<Record<string, string>>;
	agentHistoryKeys: Readonly<Record<string, string>>;
	resultsDir: string;
}

interface GasCityHistoryEntry {
	attempt: number;
	result: SingleResult;
	before: Readonly<Record<string, unknown>>;
	after: Readonly<Record<string, unknown>>;
	beforeNext: Readonly<Record<string, unknown>>;
	decision: ShortleashPolicyDecision;
	updatedAt: number;
}

interface GasCityHistoryFile {
	results: GasCityHistoryEntry[];
	updatedAt: number;
}

interface GasCityBead {
	id: string;
	title: string;
	description: string;
	status: string;
	metadata: Record<string, unknown>;
	issueType?: string;
}

export async function runGasCityPolicyCheck(configPath: string, beadsRun?: BeadsCommandRunner): Promise<number> {
	try {
		const config = await readConfig(configPath);
		const definition = definitionFromSnapshot(config.definition);
		await verifyPolicyModules(config.policyModules);
		const loaded = await loadShortleashPolicyModules({
			paths: config.policyModules.map(module => module.path),
			definitionDir: config.definitionDir,
		});
		if (loaded.errors.length > 0) {
			throw new Error(
				`Shortleash policy module load errors:\n${loaded.errors.map(error => `  - ${error}`).join("\n")}`,
			);
		}

		const histories = await readHistories(config.allHistoryPaths);
		const current = await readCurrentResult(config, definition, beadsRun);
		const history = historyMap(config, definition, histories);
		const latestResults = latestResultMap(history);
		if (config.boundary === "agent" && config.agentName) {
			latestResults.set(config.agentName, current);
			history.set(config.agentName, [...(history.get(config.agentName) ?? []), current]);
		}

		const context: ShortleashPolicyContext = {
			definition,
			cwd: config.cwd,
			workspace: config.workspace,
			shortleashDir: config.shortleashDir,
			boundary: config.boundary,
			attempt: currentAttempt(),
			params: {},
			latestResults,
			history,
			state: buildPolicyState(config, definition, histories),
		};
		if (config.agentName) context.agent = config.agentName;

		const previous = histories.get(config.key)?.results.at(-1);
		const before = previous?.beforeNext ?? {};
		const after = await loaded.registry.capture(definition, context, "after", config.references);
		const observations = new Map<string, { before: unknown; after: unknown }>();
		for (const key of new Set([...Object.keys(before), ...after.keys()])) {
			observations.set(key, { before: before[key], after: after.get(key) });
		}
		const decision = await loaded.registry.evaluate(definition, context, config.references, observations);
		const beforeNext: ReadonlyMap<string, unknown> = decision.accepted
			? new Map()
			: await loaded.registry.capture(definition, context, "before", config.references);
		const entry: GasCityHistoryEntry = {
			attempt: currentAttempt(),
			result: current,
			before,
			after: Object.fromEntries(after),
			beforeNext: Object.fromEntries(beforeNext),
			decision,
			updatedAt: Date.now(),
		};
		const persisted = histories.get(config.key) ?? { results: [], updatedAt: Date.now() };
		persisted.results = [...persisted.results, entry];
		persisted.updatedAt = Date.now();
		await writeJsonAtomically(config.historyPath, persisted);
		await fs.mkdir(path.join(config.resultsDir, config.key), { recursive: true });
		const artifactPath = path.join(config.resultsDir, config.key, `attempt-${currentAttempt()}.json`);
		await writeJsonAtomically(artifactPath, {
			configKey: config.key,
			attempt: currentAttempt(),
			bead: current,
			decision,
			observations: Object.fromEntries(observations),
			updatedAt: Date.now(),
		});

		const output = JSON.stringify({
			shortleash: "gascity-policy",
			accepted: decision.accepted,
			boundary: decision.boundary,
			failures: decision.failures,
			evaluations: decision.evaluations,
			artifact: artifactPath,
		});
		console.log(output);
		if (decision.accepted) return 0;
		console.error(formatPolicyFeedback(decision));
		return 1;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Shortleash Gas City policy bridge failed: ${message}`);
		return 1;
	}
}

if (import.meta.main) {
	const configPath = parseConfigPath(process.argv.slice(2));
	const exitCode = await runGasCityPolicyCheck(configPath);
	process.exitCode = exitCode;
}

async function readConfig(configPath: string): Promise<GasCityPolicyBridgeConfig> {
	const value: unknown = JSON.parse(await fs.readFile(configPath, "utf8"));
	if (!isRecord(value) || value.schemaVersion !== 1) {
		throw new Error(`Unsupported Gas City policy bridge config '${configPath}'.`);
	}
	return value as unknown as GasCityPolicyBridgeConfig;
}

function parseConfigPath(args: readonly string[]): string {
	const index = args.indexOf("--config");
	if (index < 0 || !args[index + 1]) throw new Error("Usage: gascity-check --config <path>");
	return path.resolve(args[index + 1]);
}

async function verifyPolicyModules(modules: readonly GasCityPolicyModuleSnapshot[]): Promise<void> {
	for (const module of modules) {
		const digest = createHash("sha256")
			.update(await fs.readFile(module.path))
			.digest("hex");
		if (digest !== module.sha256) {
			throw new Error(`Policy module hash changed: ${module.path}`);
		}
	}
}

function definitionFromSnapshot(snapshot: Record<string, unknown>): ShortleashDefinition {
	const rawAgents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
	const agents = new Map<string, ShortleashAgent>();
	for (const rawAgent of rawAgents) {
		if (!isRecord(rawAgent) || typeof rawAgent.name !== "string") {
			throw new Error("Gas City policy bridge definition contains an invalid agent snapshot.");
		}
		agents.set(rawAgent.name, {
			name: rawAgent.name,
			agent: optionalString(rawAgent.agent),
			role: requiredString(rawAgent.role, `agent '${rawAgent.name}' role`),
			task: requiredString(rawAgent.task, `agent '${rawAgent.name}' task`),
			extraContext: optionalString(rawAgent.extraContext),
			reportsTo: stringArray(rawAgent.reportsTo),
			waitsFor: stringArray(rawAgent.waitsFor),
			model: optionalString(rawAgent.model),
			workspaceIsolation: optionalIsolation(rawAgent.workspaceIsolation),
			inheritHistory: typeof rawAgent.inheritHistory === "boolean" ? rawAgent.inheritHistory : undefined,
			checks: policyRefs(rawAgent.checks),
			evals: policyRefs(rawAgent.evals),
		});
	}
	return {
		name: requiredString(snapshot.name, "definition name"),
		workspace: requiredString(snapshot.workspace, "definition workspace"),
		task: optionalString(snapshot.task),
		workspaceIsolation: optionalIsolation(snapshot.workspaceIsolation) ?? "none",
		inheritHistory: typeof snapshot.inheritHistory === "boolean" ? snapshot.inheritHistory : false,
		failurePolicy:
			snapshot.failurePolicy === "fail_fast" ||
			snapshot.failurePolicy === "continue" ||
			snapshot.failurePolicy === "skip_dependents"
				? snapshot.failurePolicy
				: "skip_dependents",
		agentTimeoutMs: typeof snapshot.agentTimeoutMs === "number" ? snapshot.agentTimeoutMs : undefined,
		model: optionalString(snapshot.model),
		agents,
		checks: policyRefs(snapshot.checks),
		evals: policyRefs(snapshot.evals),
		agentOrder: stringArray(snapshot.agentOrder),
	};
}

function buildPolicyState(
	config: GasCityPolicyBridgeConfig,
	definition: ShortleashDefinition,
	histories: ReadonlyMap<string, GasCityHistoryFile>,
): ShortleashState {
	const agents: ShortleashState["agents"] = {};
	const results: ShortleashState["results"] = {};
	for (const agentName of definition.agentOrder) {
		const historyKey = config.agentHistoryKeys[agentName];
		const entries = historyKey ? (histories.get(historyKey)?.results ?? []) : [];
		results[agentName] = entries.map(entry => ({ attempt: entry.attempt, result: entry.result }));
		agents[agentName] = {
			name: agentName,
			status: entries.length > 0 ? "completed" : "pending",
			wave: 0,
			attempt: entries.at(-1)?.attempt,
		};
	}
	return {
		version: 4,
		name: definition.name,
		definitionHash: config.definitionHash,
		workspace: config.workspace,
		status: "running",
		currentWave: 0,
		agents,
		results,
		policyHistory: [],
		policyObservations: {},
		projectionHistory: [],
		startedAt: Date.now(),
	};
}

async function readCurrentResult(
	config: GasCityPolicyBridgeConfig,
	definition: ShortleashDefinition,
	beadsRun?: BeadsCommandRunner,
): Promise<SingleResult> {
	const beadId = process.env.GC_BEAD_ID?.trim();
	if (!beadId) throw new Error("Gas City did not provide GC_BEAD_ID to the policy bridge.");
	const bead = await readBead(beadId, config.cwd, beadsRun);
	const attempt = currentAttempt();
	const agentName = config.agentName ?? "complete";
	const agent = definition.agents.get(agentName);
	const output = beadOutput(bead);
	const outcome = stringValue(bead.metadata["gc.outcome"]);
	const failed = outcome === "fail" || outcome === "hard_fail" || bead.status === "failed";
	return {
		index: attempt,
		id: `gascity-${config.key}-${bead.id}-${attempt}`,
		agent: agentName,
		agentSource: "project",
		task: agent?.task ?? definition.task ?? `Evaluate Shortleash '${definition.name}' completion.`,
		exitCode: failed ? 1 : 0,
		output,
		stderr: failed ? `Gas City bead ${bead.id} reported a failed outcome.` : "",
		truncated: false,
		durationMs: numberValue(bead.metadata["gc.duration_ms"]) ?? 0,
		tokens: numberValue(bead.metadata["gc.tokens"]) ?? 0,
		requests: numberValue(bead.metadata["gc.requests"]) ?? 0,
		error: failed ? `Gas City bead ${bead.id} reported a failed outcome.` : undefined,
	};
}

async function readBead(id: string, cwd: string, beadsRun?: BeadsCommandRunner): Promise<GasCityBead> {
	const result = await runBeadsJson(["show", id], cwd, undefined, beadsRun);
	const data = extractBeadsData(result.data);
	const candidates = Array.isArray(data) ? data : [data];
	const candidate = candidates.find(value => isRecord(value) && value.id === id);
	if (!isRecord(candidate)) throw new Error(`bd show returned no Gas City bead '${id}'.`);
	return {
		id,
		title: stringValue(candidate.title) ?? id,
		description: stringValue(candidate.description) ?? "",
		status: stringValue(candidate.status) ?? "open",
		metadata: metadataObject(candidate.metadata),
		issueType: stringValue(candidate.issue_type) ?? stringValue(candidate.type),
	};
}

function beadOutput(bead: GasCityBead): string {
	const value = bead.metadata["gc.output_json"] ?? bead.metadata.output_json;
	if (typeof value === "string") return value;
	if (value !== undefined) return JSON.stringify(value);
	return [bead.title, bead.description].filter(Boolean).join("\n\n");
}

async function readHistories(paths: Readonly<Record<string, string>>): Promise<Map<string, GasCityHistoryFile>> {
	const histories = new Map<string, GasCityHistoryFile>();
	for (const [key, filePath] of Object.entries(paths)) {
		try {
			const value: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
			if (isRecord(value) && Array.isArray(value.results)) {
				histories.set(key, value as unknown as GasCityHistoryFile);
			}
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
	}
	return histories;
}

function historyMap(
	config: GasCityPolicyBridgeConfig,
	definition: ShortleashDefinition,
	histories: ReadonlyMap<string, GasCityHistoryFile>,
): Map<string, readonly SingleResult[]> {
	const history = new Map<string, readonly SingleResult[]>();
	for (const agentName of definition.agentOrder) {
		const historyKey = config.agentHistoryKeys[agentName];
		const entries = historyKey ? (histories.get(historyKey)?.results ?? []) : [];
		history.set(
			agentName,
			entries.map(entry => entry.result),
		);
	}
	return history;
}

function latestResultMap(history: ReadonlyMap<string, readonly SingleResult[]>): Map<string, SingleResult> {
	return new Map(
		[...history.entries()].flatMap(([agentName, results]) => {
			const latest = results.at(-1);
			return latest ? [[agentName, latest] as const] : [];
		}),
	);
}

function currentAttempt(): number {
	const value = Number.parseInt(process.env.GC_ITERATION ?? "1", 10);
	return Number.isFinite(value) && value > 0 ? value - 1 : 0;
}

function formatPolicyFeedback(decision: ShortleashPolicyDecision): string {
	const failures = decision.failures.map(failure => `- ${failure.source} ${failure.id}: ${failure.message}`);
	const evaluations = decision.evaluations
		.filter(evaluation => evaluation.outcome === "fail")
		.map(evaluation => `- eval ${evaluation.id}@${evaluation.version}: ${evaluation.explanation}`);
	return [
		"Shortleash policy rejected this Gas City attempt.",
		"Continue in the same worker session and resolve every finding before finishing again.",
		...failures,
		...evaluations,
	].join("\n");
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await fs.rename(temporaryPath, filePath);
}

function metadataObject(value: unknown): Record<string, unknown> {
	if (isRecord(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function policyRefs(value: unknown): ShortleashPolicyRef[] {
	if (!Array.isArray(value)) return [];
	return value.filter((reference): reference is ShortleashPolicyRef => {
		if (typeof reference === "string") return reference.length > 0;
		return isRecord(reference) && typeof reference.path === "string";
	});
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new Error(`Missing ${field} in Gas City policy bridge config.`);
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalIsolation(value: unknown): "none" | "worktree" | undefined {
	return value === "none" || value === "worktree" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}
