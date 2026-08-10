import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import {
	normalizePolicyParams,
	type ShortleashDefinition,
	type ShortleashPolicyParams,
	type ShortleashPolicyRef,
} from "../definition/schema";
import type {
	ShortleashEvaluationRecord,
	ShortleashPolicyBoundary,
	ShortleashPolicyDecision,
	ShortleashPolicyFailure,
	ShortleashPolicyKind,
	ShortleashPolicyObservation,
	ShortleashPolicyObservations,
} from "./policy-types";

export type {
	ShortleashEvaluationRecord,
	ShortleashPolicyBoundary,
	ShortleashPolicyDecision,
	ShortleashPolicyFailure,
	ShortleashPolicyKind,
	ShortleashPolicyObservation,
	ShortleashPolicyObservations,
} from "./policy-types";

import type { ShortleashState } from "../execution/state";

type MaybePromise<T> = T | Promise<T>;

export interface ShortleashPolicyJudgeRequest {
	prompt: string;
	outputSchema: unknown;
	agent?: string;
	model?: string;
	schemaMode?: "permissive" | "strict";
	signal?: AbortSignal;
}

export interface ShortleashPolicyJudgeResult<T = unknown> {
	data: T;
	result: SingleResult;
	evidenceRef: string;
}

export type ShortleashPolicyJudge = <T = unknown>(
	request: ShortleashPolicyJudgeRequest,
) => Promise<ShortleashPolicyJudgeResult<T>>;

export interface ShortleashPolicyContext {
	definition: ShortleashDefinition;
	cwd: string;
	workspace: string;
	shortleashDir: string;
	boundary: ShortleashPolicyBoundary;
	/** Zero-based agent finalization attempt when the policy runs in an agent boundary. */
	attempt?: number;
	wave?: number;
	/** The agent whose scoped policies are being evaluated, when applicable. */
	agent?: string;
	/** Parameters from the specific policy reference being evaluated. */
	params: ShortleashPolicyParams;
	/** Before/after state captured for the specific policy reference, when configured. */
	observation?: ShortleashPolicyObservation;
	latestResults: ReadonlyMap<string, SingleResult>;
	history: ReadonlyMap<string, readonly SingleResult[]>;
	state: Readonly<ShortleashState>;
	/** Host-provided abort signal for long-running policy work. */
	signal?: AbortSignal;
	/** Optional host-backed structured subagent capability for LLM judgments. */
	judge?: ShortleashPolicyJudge;
}

export interface ShortleashPolicyCaptureContext extends ShortleashPolicyContext {
	phase: "before" | "after";
}

export interface ShortleashCheckResult {
	passed: boolean;
	message?: string;
	findings?: readonly unknown[];
	evidenceRefs?: readonly string[];
}

/** The default export shape for a check module listed in `checks`. */
export interface ShortleashCheckModule {
	description: string;
	boundary?: ShortleashPolicyBoundary;
	capture?(context: ShortleashPolicyCaptureContext): MaybePromise<unknown>;
	check(context: ShortleashPolicyContext): MaybePromise<ShortleashCheckResult | boolean>;
}

export interface ShortleashEvaluationResult {
	outcome: "pass" | "fail";
	explanation: string;
	findings?: readonly unknown[];
	evidenceRefs?: readonly string[];
}

/** The default export shape for an evaluator module listed in `evals`. */
export interface ShortleashEvaluationModule {
	version: string;
	description: string;
	boundary?: ShortleashPolicyBoundary;
	blocking?: boolean;
	capture?(context: ShortleashPolicyCaptureContext): MaybePromise<unknown>;
	evaluate(context: ShortleashPolicyContext): MaybePromise<ShortleashEvaluationResult>;
}

export type ShortleashPolicyModule = ShortleashCheckModule | ShortleashEvaluationModule;

export interface ShortleashPolicyReferences {
	checks: readonly ShortleashPolicyRef[];
	evals: readonly ShortleashPolicyRef[];
}

type RegisteredCheck = {
	modulePath: string;
	definition: ShortleashCheckModule;
	key: string;
};
type RegisteredEval = {
	modulePath: string;
	definition: ShortleashEvaluationModule;
	key: string;
};
type PolicyReference = { path: string; params: ShortleashPolicyParams };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeReference(reference: ShortleashPolicyRef): PolicyReference {
	if (typeof reference === "string") return { path: reference.trim(), params: {} };
	return {
		path: reference.path.trim(),
		params: normalizePolicyParams(reference.params, `policy '${reference.path}' parameters`) ?? {},
	};
}

function resolveReferencePath(reference: ShortleashPolicyRef, definitionDir: string): string {
	return path.resolve(definitionDir, normalizeReference(reference).path);
}

function policyKey(modulePath: string, definitionDir: string): string {
	const relative = path.relative(definitionDir, modulePath).split(path.sep).join("/");
	if (relative.startsWith("../") || relative === "..") return relative;
	return relative.startsWith("./") ? relative : `./${relative}`;
}

function observationKey(kind: ShortleashPolicyKind, index: number, registeredKey: string): string {
	return `${kind}:${index}:${registeredKey}`;
}

function normalizeFindings(value: readonly unknown[] | undefined): readonly unknown[] {
	return value ?? [];
}

function normalizeEvidence(value: readonly string[] | undefined): readonly string[] {
	return value ?? [];
}

function normalizeCheckResult(value: ShortleashCheckResult | boolean): ShortleashCheckResult {
	if (typeof value === "boolean") return { passed: value };
	if (!isRecord(value) || typeof value.passed !== "boolean") {
		throw new Error("A Shortleash check must return a boolean or { passed: boolean }.");
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

function normalizeEvaluationResult(value: ShortleashEvaluationResult): ShortleashEvaluationResult {
	if (!isRecord(value) || (value.outcome !== "pass" && value.outcome !== "fail")) {
		throw new Error("A Shortleash evaluation must return an object with outcome 'pass' or 'fail'.");
	}
	if (typeof value.explanation !== "string" || value.explanation.trim().length === 0) {
		throw new Error("A Shortleash evaluation must return a non-empty explanation.");
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

function formatMissingReference(kind: ShortleashPolicyKind, reference: ShortleashPolicyRef): string {
	const value = typeof reference === "string" ? reference : reference.path;
	return `Unknown Shortleash ${kind} module '${value}'.`;
}

function isCheckModule(value: unknown): value is ShortleashCheckModule {
	return (
		isRecord(value) &&
		typeof value.description === "string" &&
		value.description.trim().length > 0 &&
		typeof value.check === "function" &&
		value.evaluate === undefined
	);
}

function isEvaluationModule(value: unknown): value is ShortleashEvaluationModule {
	return (
		isRecord(value) &&
		typeof value.version === "string" &&
		value.version.trim().length > 0 &&
		typeof value.description === "string" &&
		value.description.trim().length > 0 &&
		typeof value.evaluate === "function" &&
		value.check === undefined
	);
}

function formatModuleShapeError(): string {
	return "Module must default-export a Shortleash check ({ description, check }) or evaluator ({ version, description, evaluate }).";
}

export class ShortleashPolicyRegistry {
	#definitionDir: string;
	#checks = new Map<string, RegisteredCheck>();
	#evals = new Map<string, RegisteredEval>();

	constructor(definitionDir = process.cwd()) {
		this.#definitionDir = path.resolve(definitionDir);
	}

	register(modulePath: string, module: ShortleashPolicyModule): void {
		const resolvedPath = path.resolve(modulePath);
		const key = policyKey(resolvedPath, this.#definitionDir);
		if (isCheckModule(module)) {
			if (this.#checks.has(resolvedPath) || this.#evals.has(resolvedPath)) {
				throw new Error(`Shortleash policy module '${key}' was loaded more than once.`);
			}
			this.#checks.set(resolvedPath, { modulePath: resolvedPath, definition: module, key });
			return;
		}
		if (isEvaluationModule(module)) {
			if (this.#checks.has(resolvedPath) || this.#evals.has(resolvedPath)) {
				throw new Error(`Shortleash policy module '${key}' was loaded more than once.`);
			}
			this.#evals.set(resolvedPath, { modulePath: resolvedPath, definition: module, key });
			return;
		}
		throw new Error(formatModuleShapeError());
	}

	validateDefinition(definition: ShortleashDefinition): string[] {
		const errors: string[] = [];
		const validateReferences = (references: ShortleashPolicyReferences, scope: string): void => {
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
		definition: ShortleashDefinition,
		context: ShortleashPolicyContext,
		phase: "before" | "after",
		references: ShortleashPolicyReferences = definition,
	): Promise<ReadonlyMap<string, unknown>> {
		const snapshots = new Map<string, unknown>();
		const captureContext = (params: ShortleashPolicyParams): ShortleashPolicyCaptureContext => ({
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
		definition: ShortleashDefinition,
		context: ShortleashPolicyContext,
		references: ShortleashPolicyReferences = definition,
		observations: ShortleashPolicyObservations = new Map(),
	): Promise<ShortleashPolicyDecision> {
		const failures: ShortleashPolicyFailure[] = [];
		const evaluations: ShortleashEvaluationRecord[] = [];
		const scoped = context.agent !== undefined;
		const referenceContext = (
			kind: ShortleashPolicyKind,
			index: number,
			reference: ShortleashPolicyRef,
			registeredKey: string,
		): ShortleashPolicyContext => {
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
				const record: ShortleashEvaluationRecord = {
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
				const record: ShortleashEvaluationRecord = {
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

	#resolve<T extends RegisteredCheck | RegisteredEval>(
		map: Map<string, T>,
		reference: ShortleashPolicyRef,
	): T | undefined {
		return map.get(resolveReferencePath(reference, this.#definitionDir));
	}

	#applies(
		boundary: ShortleashPolicyBoundary | undefined,
		current: ShortleashPolicyBoundary,
		scoped: boolean,
	): boolean {
		return (boundary ?? (scoped ? "agent" : "complete")) === current;
	}

	async #runCheck(
		source: "check",
		id: string,
		description: string,
		check: (context: ShortleashPolicyContext) => MaybePromise<ShortleashCheckResult | boolean>,
		context: ShortleashPolicyContext,
		failures: ShortleashPolicyFailure[],
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

export interface LoadShortleashPolicyModulesOptions {
	paths: readonly string[];
	definitionDir: string;
}

export interface LoadShortleashPolicyModulesResult {
	registry: ShortleashPolicyRegistry;
	errors: string[];
}

/** Load the exact `.ts` policy modules referenced by a definition. */
export async function loadShortleashPolicyModules(
	options: LoadShortleashPolicyModulesOptions,
): Promise<LoadShortleashPolicyModulesResult> {
	const registry = new ShortleashPolicyRegistry(options.definitionDir);
	const errors: string[] = [];
	for (const configuredPath of options.paths) {
		const modulePath = path.resolve(options.definitionDir, configuredPath);
		try {
			if (path.extname(modulePath) !== ".ts") {
				throw new Error("policy module paths must point to .ts files");
			}
			const loaded = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
			const candidate = loaded.default;
			if (!isCheckModule(candidate) && !isEvaluationModule(candidate)) {
				throw new Error(formatModuleShapeError());
			}
			registry.register(modulePath, candidate);
		} catch (error) {
			errors.push(`${modulePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { registry, errors };
}
