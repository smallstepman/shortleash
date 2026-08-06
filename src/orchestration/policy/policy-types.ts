/** Shared policy result contracts used by the registry, pipeline, and durable state. */

export type SwarmPolicyBoundary = "agent" | "wave" | "iteration" | "complete";
export type SwarmPolicyKind = "check" | "eval";

export interface SwarmPolicyObservation {
	before: unknown;
	after: unknown;
}

export type SwarmPolicyObservations = ReadonlyMap<string, SwarmPolicyObservation>;

export interface SwarmPolicyFailure {
	source: SwarmPolicyKind;
	id: string;
	message: string;
	findings: readonly unknown[];
	evidenceRefs: readonly string[];
}

export interface SwarmEvaluationRecord {
	id: string;
	version: string;
	outcome: "pass" | "fail";
	explanation: string;
	findings: readonly unknown[];
	evidenceRefs: readonly string[];
}

export interface SwarmPolicyDecision {
	boundary: SwarmPolicyBoundary;
	accepted: boolean;
	failures: readonly SwarmPolicyFailure[];
	evaluations: readonly SwarmEvaluationRecord[];
}
