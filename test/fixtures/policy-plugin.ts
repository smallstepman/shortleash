import { defineSwarmPlugin } from "../../src/orchestration/policy/plugins";

export default defineSwarmPlugin({
	name: "fixture",
	setup(api) {
		api.registerCheck({
			id: "passes",
			description: "The fixture check passes.",
			boundary: "complete",
			check: () => true,
		});
		return {
			evals: [
				{
					id: "fails",
					version: "1",
					description: "The fixture evaluator fails.",
					boundary: "complete",
					evaluate: () => ({
						outcome: "fail",
						explanation: "Fixture evaluator blocked completion.",
						findings: [{ code: "fixture-failure" }],
						evidenceRefs: ["artifact://fixture"],
					}),
				},
			],
		};
	},
});
