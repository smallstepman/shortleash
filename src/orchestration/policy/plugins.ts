import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import {
	normalizePolicyParams,
	parsePolicyRef,
	type SwarmDefinition,
	type SwarmPolicyParams,
	type SwarmPolicyRef,
} from "../definition/schema";
import type {
	SwarmEvaluationRecord,
	SwarmPolicyBoundary,
	SwarmPolicyDecision,
	SwarmPolicyFailure,
	SwarmPolicyKind,
	SwarmPolicyObservation,
	SwarmPolicyObservations,
} from "./policy-types";

export type {
	SwarmEvaluationRecord,
	SwarmPolicyBoundary,
	SwarmPolicyDecision,
	SwarmPolicyFailure,
	SwarmPolicyKind,
	SwarmPolicyObservation,
	SwarmPolicyObservations,
} from "./policy-types";

import type { SwarmState } from "../execution/state";

type MaybePromise<T> = T | Promise<T>;

export interface SwarmPluginLogger {
	debug(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
}

export interface SwarmPolicyContext {
	definition: SwarmDefinition;
	cwd: string;
	workspace: string;
	swarmDir: string;
	boundary: SwarmPolicyBoundary;
	iteration: number;
	/** Zero-based agent finalization attempt when the policy runs in an agent boundary. */
	attempt?: number;
	wave?: number;
	/** The agent whose scoped policies are being evaluated, when applicable. */
	agent?: string;
	/** Parameters from the specific policy reference being evaluated. */
	params: SwarmPolicyParams;
	/** Before/after state captured for the specific policy reference, when configured. */
	observation?: SwarmPolicyObservation;
	latestResults: ReadonlyMap<string, SingleResult>;
	history: ReadonlyMap<string, readonly SingleResult[]>;
	state: Readonly<SwarmState>;
}

export interface SwarmPolicyCaptureContext extends SwarmPolicyContext {
	phase: "before" | "after";
}

export interface SwarmCheckResult {
	passed: boolean;
	message?: string;
	findings?: readonly unknown[];
	evidenceRefs?: readonly string[];
}

export interface SwarmCheckDefinition {
	id: string;
	description: string;
	boundary?: SwarmPolicyBoundary;
	capture?(context: SwarmPolicyCaptureContext): MaybePromise<unknown>;
	check(context: SwarmPolicyContext): MaybePromise<SwarmCheckResult | boolean>;
}

export interface SwarmEvaluationDefinition {
	id: string;
	version: string;
	description: string;
	boundary?: SwarmPolicyBoundary;
	blocking?: boolean;
	capture?(context: SwarmPolicyCaptureContext): MaybePromise<unknown>;
	evaluate(context: SwarmPolicyContext): MaybePromise<SwarmEvaluationResult>;
}

export interface SwarmEvaluationResult {
	outcome: "pass" | "fail";
	explanation: string;
	findings?: readonly unknown[];
	evidenceRefs?: readonly string[];
}

export interface SwarmPolicyReferences {
	checks: readonly SwarmPolicyRef[];
	evals: readonly SwarmPolicyRef[];
}

export interface SwarmPluginRegistration {
	checks?: readonly SwarmCheckDefinition[];
	evals?: readonly SwarmEvaluationDefinition[];
}

export interface SwarmPluginAPI {
	cwd: string;
	workspace: string;
	definitionPath: string;
	definition: SwarmDefinition;
	logger: SwarmPluginLogger;
	registerCheck(check: SwarmCheckDefinition): void;
	registerEval(evaluation: SwarmEvaluationDefinition): void;
}

export interface SwarmPluginDefinition {
	name: string;
	setup(api: SwarmPluginAPI): MaybePromise<SwarmPluginRegistration | void>;
}

export type SwarmPluginFactory = (api: SwarmPluginAPI) => MaybePromise<SwarmPluginRegistration | void>;
export type SwarmPluginExport = SwarmPluginDefinition | SwarmPluginFactory;

export function defineSwarmPlugin(definition: SwarmPluginDefinition): SwarmPluginDefinition {
	return definition;
}

type RegisteredCheck = { plugin: string; definition: SwarmCheckDefinition; key: string };
type RegisteredEval = { plugin: string; definition: SwarmEvaluationDefinition; key: string };

type PolicyReference = { plugin?: string; id: string; params: SwarmPolicyParams };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeReference(reference: SwarmPolicyRef): PolicyReference {
	const parsed = typeof reference === "string" ? parsePolicyRef(reference) : reference;
	if (typeof parsed === "string") {
		const separator = parsed.indexOf(":");
		const plugin = separator === -1 ? undefined : parsed.slice(0, separator).trim();
		const id = (separator === -1 ? parsed : parsed.slice(separator + 1)).trim();
		return {
			plugin: plugin || undefined,
			id,
			params: {},
		};
	}
	return {
		plugin: parsed.plugin?.trim() || undefined,
		id: parsed.id.trim(),
		params: normalizePolicyParams(parsed.params, `policy '${parsed.id}' parameters`) ?? {},
	};
}

function policyKey(plugin: string, id: string): string {
	return `${plugin}:${id}`;
}

function policyId(item: { id: string }, plugin: string): string {
	return policyKey(plugin, item.id);
}
function observationKey(kind: SwarmPolicyKind, index: number, registeredKey: string): string {
	return `${kind}:${index}:${registeredKey}`;
}

function normalizeFindings(value: readonly unknown[] | undefined): readonly unknown[] {
	return value ?? [];
}

function normalizeEvidence(value: readonly string[] | undefined): readonly string[] {
	return value ?? [];
}

function normalizeCheckResult(value: SwarmCheckResult | boolean): SwarmCheckResult {
	if (typeof value === "boolean") return { passed: value };
	if (!isRecord(value) || typeof value.passed !== "boolean") {
		throw new Error("A swarm check must return a boolean or { passed: boolean }.");
	}
	return {
		passed: value.passed,
		message: typeof value.message === "string" ? value.message : undefined,
		findings: Array.isArray(value.findings) ? value.findings : [],
		evidenceRefs: Array.isArray(value.evidenceRefs)
			? value.evidenceRefs.filter((ref): ref is string => typeof ref === "string")
			: [],
	};
}

function normalizeEvaluationResult(value: SwarmEvaluationResult): SwarmEvaluationResult {
	if (!isRecord(value) || (value.outcome !== "pass" && value.outcome !== "fail")) {
		throw new Error("A swarm evaluation must return an object with outcome 'pass' or 'fail'.");
	}
	if (typeof value.explanation !== "string" || value.explanation.trim().length === 0) {
		throw new Error("A swarm evaluation must return a non-empty explanation.");
	}
	return {
		outcome: value.outcome,
		explanation: value.explanation,
		findings: Array.isArray(value.findings) ? value.findings : [],
		evidenceRefs: Array.isArray(value.evidenceRefs)
			? value.evidenceRefs.filter((ref): ref is string => typeof ref === "string")
			: [],
	};
}

function formatMissingReference(kind: SwarmPolicyKind, reference: SwarmPolicyRef): string {
	const value =
		typeof reference === "string" ? reference : `${reference.plugin ? `${reference.plugin}:` : ""}${reference.id}`;
	return `Unknown swarm ${kind} '${value}'.`;
}

export class SwarmPolicyRegistry {
	#plugins = new Set<string>();
	#checks = new Map<string, RegisteredCheck>();
	#evals = new Map<string, RegisteredEval>();

	register(plugin: SwarmPluginRegistration & { name: string }): void {
		const name = plugin.name.trim();
		if (!name) throw new Error("Swarm plugin name must not be empty.");
		if (this.#plugins.has(name)) throw new Error(`Swarm plugin '${name}' was registered more than once.`);
		this.#plugins.add(name);

		for (const check of plugin.checks ?? []) this.#registerItem(this.#checks, name, check, "check");
		for (const evaluation of plugin.evals ?? []) this.#registerItem(this.#evals, name, evaluation, "eval");
	}

	validateDefinition(definition: SwarmDefinition): string[] {
		const errors: string[] = [];
		const validateReferences = (references: SwarmPolicyReferences, scope: string): void => {
			for (const reference of references.checks) {
				if (!this.#resolve(this.#checks, reference)) {
					errors.push(`${scope}${formatMissingReference("check", reference)}`);
				}
			}
			for (const reference of references.evals) {
				if (!this.#resolve(this.#evals, reference)) {
					errors.push(`${scope}${formatMissingReference("eval", reference)}`);
				}
			}
		};

		validateReferences(definition, "");
		for (const [agentName, agent] of definition.agents) {
			validateReferences(agent, `Agent '${agentName}': `);
		}
		return errors;
	}

	async capture(
		definition: SwarmDefinition,
		context: SwarmPolicyContext,
		phase: "before" | "after",
		references: SwarmPolicyReferences = definition,
	): Promise<ReadonlyMap<string, unknown>> {
		const snapshots = new Map<string, unknown>();
		const captureContext = (params: SwarmPolicyParams): SwarmPolicyCaptureContext => ({
			...context,
			params,
			phase,
		});

		for (const [index, reference] of references.checks.entries()) {
			const registered = this.#resolve(this.#checks, reference);
			if (
				!registered?.definition.capture ||
				!this.#applies(registered.definition.boundary, context.boundary, context.agent !== undefined)
			) {
				continue;
			}
			const normalized = normalizeReference(reference);
			snapshots.set(
				observationKey("check", index, registered.key),
				await registered.definition.capture(captureContext(normalized.params)),
			);
		}
		for (const [index, reference] of references.evals.entries()) {
			const registered = this.#resolve(this.#evals, reference);
			if (
				!registered?.definition.capture ||
				!this.#applies(registered.definition.boundary, context.boundary, context.agent !== undefined)
			) {
				continue;
			}
			const normalized = normalizeReference(reference);
			snapshots.set(
				observationKey("eval", index, registered.key),
				await registered.definition.capture(captureContext(normalized.params)),
			);
		}
		return snapshots;
	}

	async evaluate(
		definition: SwarmDefinition,
		context: SwarmPolicyContext,
		references: SwarmPolicyReferences = definition,
		observations: SwarmPolicyObservations = new Map(),
	): Promise<SwarmPolicyDecision> {
		const failures: SwarmPolicyFailure[] = [];
		const evaluations: SwarmEvaluationRecord[] = [];
		const scoped = context.agent !== undefined;
		const referenceContext = (
			kind: SwarmPolicyKind,
			index: number,
			reference: SwarmPolicyRef,
			registeredKey: string,
		): SwarmPolicyContext => {
			const normalized = normalizeReference(reference);
			return {
				...context,
				params: normalized.params,
				observation: observations.get(observationKey(kind, index, registeredKey)),
			};
		};

		for (const [index, reference] of references.checks.entries()) {
			const registered = this.#resolve(this.#checks, reference);
			if (!registered || !this.#applies(registered.definition.boundary, context.boundary, scoped)) continue;
			await this.#runCheck(
				"check",
				registered.key,
				registered.definition.description,
				registered.definition.check,
				referenceContext("check", index, reference, registered.key),
				failures,
			);
		}

		for (const [index, reference] of references.evals.entries()) {
			const registered = this.#resolve(this.#evals, reference);
			if (!registered || !this.#applies(registered.definition.boundary, context.boundary, scoped)) continue;

			try {
				const result = normalizeEvaluationResult(
					await registered.definition.evaluate(referenceContext("eval", index, reference, registered.key)),
				);
				const record: SwarmEvaluationRecord = {
					id: registered.key,
					version: registered.definition.version,
					outcome: result.outcome,
					explanation: result.explanation,
					findings: normalizeFindings(result.findings),
					evidenceRefs: normalizeEvidence(result.evidenceRefs),
				};
				evaluations.push(record);
				if (result.outcome === "fail" && registered.definition.blocking !== false) {
					failures.push({
						source: "eval",
						id: registered.key,
						message: result.explanation,
						findings: record.findings,
						evidenceRefs: record.evidenceRefs,
					});
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const record: SwarmEvaluationRecord = {
					id: registered.key,
					version: registered.definition.version,
					outcome: "fail",
					explanation: message,
					findings: [],
					evidenceRefs: [],
				};
				evaluations.push(record);
				if (registered.definition.blocking !== false) {
					failures.push({
						source: "eval",
						id: registered.key,
						message,
						findings: [],
						evidenceRefs: [],
					});
				}
			}
		}

		return {
			boundary: context.boundary,
			accepted: failures.length === 0,
			failures,
			evaluations,
		};
	}

	#registerItem<T extends { id: string }>(
		map: Map<string, { plugin: string; definition: T; key: string }>,
		plugin: string,
		item: T,
		kind: SwarmPolicyKind,
	): void {
		if (!item.id.trim()) throw new Error(`Swarm ${kind} in plugin '${plugin}' has an empty id.`);
		const key = policyId(item, plugin);
		if (map.has(key)) throw new Error(`Swarm ${kind} '${key}' was registered more than once.`);
		map.set(key, { plugin, definition: item, key });
	}

	#resolve<T extends { id: string }>(
		map: Map<string, { plugin: string; definition: T; key: string }>,
		reference: SwarmPolicyRef,
	): { plugin: string; definition: T; key: string } | undefined {
		const normalized = normalizeReference(reference);
		if (!normalized.id) return undefined;
		if (normalized.plugin) return map.get(policyKey(normalized.plugin, normalized.id));

		let match: { plugin: string; definition: T; key: string } | undefined;
		for (const candidate of map.values()) {
			if (candidate.definition.id !== normalized.id) continue;
			if (match) throw new Error(`Ambiguous swarm policy id '${normalized.id}'. Use plugin:id.`);
			match = candidate;
		}
		return match;
	}

	#applies(boundary: SwarmPolicyBoundary | undefined, current: SwarmPolicyBoundary, scoped: boolean): boolean {
		return (boundary ?? (scoped ? "agent" : "complete")) === current;
	}

	async #runCheck(
		source: "check",
		id: string,
		description: string,
		check: (context: SwarmPolicyContext) => MaybePromise<SwarmCheckResult | boolean>,
		context: SwarmPolicyContext,
		failures: SwarmPolicyFailure[],
	): Promise<void> {
		try {
			const result = normalizeCheckResult(await check(context));
			if (!result.passed) {
				failures.push({
					source,
					id,
					message: result.message ?? description,
					findings: normalizeFindings(result.findings),
					evidenceRefs: normalizeEvidence(result.evidenceRefs),
				});
			}
		} catch (error) {
			failures.push({
				source,
				id,
				message: error instanceof Error ? error.message : String(error),
				findings: [],
				evidenceRefs: [],
			});
		}
	}
}

export interface SwarmPluginDiscoveryOptions {
	cwd: string;
	definitionDir?: string;
	configuredPaths?: readonly string[];
	includeInstalledPlugins?: boolean;
}

export interface SwarmPluginDiscoveryResult {
	paths: string[];
	errors: string[];
}

const MODULE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs"]);
const INDEX_NAMES = ["index.ts", "index.js", "index.mjs", "index.cjs"];

function isModulePath(value: string): boolean {
	return MODULE_EXTENSIONS.has(path.extname(value)) && !value.endsWith(".d.ts");
}

async function resolveModuleEntry(entry: string, baseDir: string, required: boolean): Promise<string[]> {
	const resolved = path.resolve(baseDir, entry);
	let stats: Stats;
	try {
		stats = await fs.stat(resolved);
	} catch {
		if (required) throw new Error(`Swarm plugin path does not exist: ${resolved}`);
		return [];
	}

	if (stats.isFile()) {
		if (!isModulePath(resolved))
			throw new Error(`Swarm plugin path is not a TypeScript/JavaScript module: ${resolved}`);
		return [resolved];
	}
	if (!stats.isDirectory()) return [];

	for (const indexName of INDEX_NAMES) {
		const indexPath = path.join(resolved, indexName);
		try {
			const indexStats = await fs.stat(indexPath);
			if (indexStats.isFile()) return [indexPath];
		} catch {
			// Try the next conventional index name.
		}
	}

	const entries = await fs.readdir(resolved, { withFileTypes: true });
	const modules: string[] = [];
	for (const child of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (child.isFile() && isModulePath(child.name)) {
			modules.push(path.join(resolved, child.name));
		} else if (child.isDirectory()) {
			for (const indexName of INDEX_NAMES) {
				const indexPath = path.join(resolved, child.name, indexName);
				try {
					const indexStats = await fs.stat(indexPath);
					if (indexStats.isFile()) {
						modules.push(indexPath);
						break;
					}
				} catch {
					// Try the next conventional index name.
				}
			}
		}
	}
	if (required && modules.length === 0) throw new Error(`No swarm plugin modules found in: ${resolved}`);
	return modules;
}

function manifestEntries(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
	return [];
}

async function discoverInstalledPluginPaths(cwd: string): Promise<string[]> {
	// The coding-agent loader is optional for library consumers; defer it until installed-plugin discovery is requested.
	const { getEnabledPlugins } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/loader");
	const paths: string[] = [];
	for (const plugin of await getEnabledPlugins(cwd)) {
		const manifest = plugin.manifest as typeof plugin.manifest & {
			swarm?: string | string[];
			features?: Record<string, { swarm?: string | string[]; default?: boolean }>;
		};
		const entries = manifestEntries(manifest.swarm);
		if (manifest.features && plugin.enabledFeatures) {
			const enabled = new Set(plugin.enabledFeatures);
			for (const featureName of enabled) entries.push(...manifestEntries(manifest.features[featureName]?.swarm));
		} else if (manifest.features && plugin.enabledFeatures === null) {
			for (const feature of Object.values(manifest.features)) {
				if (feature.default) entries.push(...manifestEntries(feature.swarm));
			}
		}
		if (entries.length === 0) {
			const conventional = path.join(plugin.path, "swarm");
			try {
				if ((await fs.stat(conventional)).isDirectory()) entries.push("swarm");
			} catch {
				// No conventional swarm entry.
			}
		}
		for (const entry of entries) paths.push(...(await resolveModuleEntry(entry, plugin.path, true)));
	}
	return paths;
}

export async function discoverSwarmPluginPaths(
	options: SwarmPluginDiscoveryOptions,
): Promise<SwarmPluginDiscoveryResult> {
	const paths: string[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	const add = (value: string) => {
		const resolved = path.resolve(value);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			paths.push(resolved);
		}
	};

	const roots = new Set<string>([
		path.resolve(options.cwd, ".omp/swarm"),
		path.resolve(options.cwd, ".swarm/plugins"),
	]);
	if (options.definitionDir) {
		roots.add(path.resolve(options.definitionDir, ".omp/swarm"));
		roots.add(path.resolve(options.definitionDir, ".swarm/plugins"));
	}
	for (const root of roots) {
		try {
			for (const modulePath of await resolveModuleEntry(root, options.cwd, false)) add(modulePath);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}

	if (options.includeInstalledPlugins !== false) {
		try {
			for (const modulePath of await discoverInstalledPluginPaths(options.cwd)) add(modulePath);
		} catch (error) {
			errors.push(
				`Installed swarm plugin discovery failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const configuredBase = options.definitionDir ?? options.cwd;
	for (const configuredPath of options.configuredPaths ?? []) {
		try {
			for (const modulePath of await resolveModuleEntry(configuredPath, configuredBase, true)) add(modulePath);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}

	return { paths, errors };
}

export interface LoadSwarmPluginsOptions {
	paths: readonly string[];
	cwd: string;
	workspace: string;
	definitionPath: string;
	definition: SwarmDefinition;
	logger?: SwarmPluginLogger;
}

export interface LoadSwarmPluginsResult {
	registry: SwarmPolicyRegistry;
	errors: string[];
}

const defaultLogger: SwarmPluginLogger = {
	debug: (message, context) => console.debug(message, context),
	info: (message, context) => console.info(message, context),
	warn: (message, context) => console.warn(message, context),
	error: (message, context) => console.error(message, context),
};

function pluginNameFromPath(modulePath: string): string {
	const basename = path.basename(modulePath, path.extname(modulePath));
	return basename === "index" ? path.basename(path.dirname(modulePath)) : basename;
}

function isPluginDefinition(value: unknown): value is SwarmPluginDefinition {
	return isRecord(value) && typeof value.name === "string" && typeof value.setup === "function";
}

function isPluginFactory(value: unknown): value is SwarmPluginFactory {
	return typeof value === "function";
}

function appendRegistration(target: SwarmPluginRegistration, source: SwarmPluginRegistration | void): void {
	if (!source) return;
	target.checks = [...(target.checks ?? []), ...(source.checks ?? [])];
	target.evals = [...(target.evals ?? []), ...(source.evals ?? [])];
}

export async function loadSwarmPlugins(options: LoadSwarmPluginsOptions): Promise<LoadSwarmPluginsResult> {
	const registry = new SwarmPolicyRegistry();
	const errors: string[] = [];
	const logger = options.logger ?? defaultLogger;

	for (const modulePath of options.paths) {
		try {
			const moduleUrl = pathToFileURL(modulePath).href;
			const loaded = (await import(moduleUrl)) as Record<string, unknown>;
			const candidate = loaded.default ?? loaded.swarmPlugin ?? loaded.plugin;
			if (!isPluginDefinition(candidate) && !isPluginFactory(candidate)) {
				throw new Error("Module must default-export defineSwarmPlugin(...) or a swarm plugin factory.");
			}

			const pluginName = isPluginDefinition(candidate) ? candidate.name : pluginNameFromPath(modulePath);
			const registrations: {
				checks: SwarmCheckDefinition[];
				evals: SwarmEvaluationDefinition[];
			} = { checks: [], evals: [] };
			const api: SwarmPluginAPI = {
				cwd: options.cwd,
				workspace: options.workspace,
				definitionPath: options.definitionPath,
				definition: options.definition,
				logger,
				registerCheck: check => registrations.checks.push(check),
				registerEval: evaluation => registrations.evals.push(evaluation),
			};

			const returned = isPluginDefinition(candidate) ? await candidate.setup(api) : await candidate(api);
			appendRegistration(registrations, returned);
			registry.register({ name: pluginName, ...registrations });
		} catch (error) {
			errors.push(`${modulePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { registry, errors };
}
