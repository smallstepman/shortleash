import type { ShortleashDefinition } from "../definition/schema";
import type { ShortleashPolicyContext, ShortleashPolicyReferences, ShortleashPolicyRegistry } from "./policies";
import type {
	ShortleashPolicyDecision,
	ShortleashPolicyObservation,
	ShortleashPolicyObservations,
} from "./policy-types";

/** Policy inputs for one boundary evaluated during a single agent attempt. */
export interface ShortleashPolicyBoundaryAttempt {
	context: ShortleashPolicyContext;
	references: ShortleashPolicyReferences;
	before: ReadonlyMap<string, unknown>;
}

/** Result of capture and evaluation for one policy boundary. */
export interface ShortleashPolicyBoundaryResult {
	after: ReadonlyMap<string, unknown>;
	decision: ShortleashPolicyDecision;
}

/** Result of capture and evaluation for all policy boundaries in one attempt. */
export interface ShortleashPolicyFinalization {
	boundaries: readonly ShortleashPolicyBoundaryResult[];
	after: ReadonlyMap<string, unknown>;
}

/** Capture policy snapshots for one or more boundaries in declaration order. */
export async function captureShortleashPolicyBoundaries(
	registry: ShortleashPolicyRegistry,
	definition: ShortleashDefinition,
	phase: "before" | "after",
	boundaries: ReadonlyArray<Pick<ShortleashPolicyBoundaryAttempt, "context" | "references">>,
): Promise<ReadonlyMap<string, unknown>> {
	const snapshots = new Map<string, unknown>();
	for (const boundary of boundaries) {
		const captured = await registry.capture(definition, boundary.context, phase, boundary.references);
		for (const [key, value] of captured) snapshots.set(key, value);
	}
	return snapshots;
}

/** Build the persisted before/after observation map for one policy boundary. */
export function buildShortleashPolicyObservations(
	before: ReadonlyMap<string, unknown>,
	after: ReadonlyMap<string, unknown>,
): ShortleashPolicyObservations {
	return new Map(
		[...new Set([...before.keys(), ...after.keys()])].map(key => [
			key,
			{ before: before.get(key), after: after.get(key) } satisfies ShortleashPolicyObservation,
		]),
	);
}

/** Capture, assemble observations, and evaluate one or more policy boundaries. */
export async function finalizeShortleashPolicyBoundaries(
	registry: ShortleashPolicyRegistry,
	definition: ShortleashDefinition,
	boundaries: readonly ShortleashPolicyBoundaryAttempt[],
): Promise<ShortleashPolicyFinalization> {
	const results: ShortleashPolicyBoundaryResult[] = [];
	for (const boundary of boundaries) {
		const after = await registry.capture(definition, boundary.context, "after", boundary.references);
		const observations = buildShortleashPolicyObservations(boundary.before, after);
		const decision = await registry.evaluate(definition, boundary.context, boundary.references, observations);
		results.push({ after, decision });
	}

	const after = new Map<string, unknown>();
	for (const result of results) {
		for (const [key, value] of result.after) after.set(key, value);
	}
	return { boundaries: results, after };
}

/** Combine decisions while preserving the last boundary when policy produced output. */
export function combineShortleashPolicyDecisions(
	decisions: readonly ShortleashPolicyDecision[],
): ShortleashPolicyDecision {
	let boundary = decisions[0]?.boundary ?? "complete";
	for (let index = decisions.length - 1; index >= 0; index--) {
		const decision = decisions[index];
		if (decision.failures.length > 0 || decision.evaluations.length > 0) {
			boundary = decision.boundary;
			break;
		}
	}
	return {
		boundary,
		accepted: decisions.every(decision => decision.accepted),
		failures: decisions.flatMap(decision => decision.failures),
		evaluations: decisions.flatMap(decision => decision.evaluations),
	};
}

/** Format policy failures consistently for terminal errors and corrective prompts. */
export function formatShortleashPolicyFailures(decision: ShortleashPolicyDecision): string[] {
	return decision.failures.map(failure => `${failure.source} ${failure.id}: ${failure.message}`);
}

/** Format a policy rejection prompt with a caller-specific subject and instruction. */
export function formatShortleashPolicyFeedback(
	decision: ShortleashPolicyDecision,
	subject: string,
	instruction: string,
): string {
	return [subject, ...formatShortleashPolicyFailures(decision).map(failure => `- ${failure}`), instruction].join("\n");
}
