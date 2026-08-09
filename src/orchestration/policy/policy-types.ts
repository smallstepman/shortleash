/** Shared policy result contracts used by the registry, pipeline, and durable state. */

export type ShortleashPolicyBoundary = "agent" | "wave" | "complete";
export type ShortleashPolicyKind = "check" | "eval";

export interface ShortleashPolicyObservation {
	before: unknown;
	after: unknown;
}

export type ShortleashPolicyObservations = ReadonlyMap<string, ShortleashPolicyObservation>;

export interface ShortleashPolicyFailure {
	source: ShortleashPolicyKind;
	id: string;
	message: string;
	findings: readonly unknown[];
	evidenceRefs: readonly string[];
}

export interface ShortleashEvaluationRecord {
	id: string;
	version: string;
	outcome: "pass" | "fail";
	explanation: string;
	findings: readonly unknown[];
	evidenceRefs: readonly string[];
}

export interface ShortleashPolicyDecision {
	boundary: ShortleashPolicyBoundary;
	accepted: boolean;
	failures: readonly ShortleashPolicyFailure[];
	evaluations: readonly ShortleashEvaluationRecord[];
}
