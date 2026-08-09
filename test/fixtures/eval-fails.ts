export default {
	version: "1",
	description: "The fixture evaluator fails.",
	boundary: "complete" as const,
	evaluate: () => ({
		outcome: "fail" as const,
		explanation: "Fixture evaluator blocked completion.",
		findings: [{ code: "fixture-failure" }],
		evidenceRefs: ["artifact://fixture"],
	}),
};
