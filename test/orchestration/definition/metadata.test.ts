import { describe, expect, it } from "bun:test";
import {
	hasSwarmMetadata,
	SWARM_DEFINITION_JSON_SCHEMA,
	SWARM_METADATA_JSON_SCHEMA,
	validateSwarmMetadata,
} from "../../../src/orchestration/definition/metadata";

const validMetadata = {
	shortleash: {
		name: "metadata-schema",
		workspace: ".",
		mode: "pipeline",
		agents: {
			discover: {
				role: "investigator",
				task: "Inspect the repository.",
				waits_for: [],
			},
			implement: {
				role: "engineer",
				task: "Implement the change.",
				waits_for: ["discover"],
			},
		},
	},
	workflow: { phase: "implementation" },
};

describe("Beads Shortleash metadata schema", () => {
	it("exposes a strict spawn-definition schema while preserving unrelated metadata", () => {
		expect(SWARM_DEFINITION_JSON_SCHEMA.required).toEqual(["name", "workspace"]);
		expect(SWARM_DEFINITION_JSON_SCHEMA.additionalProperties).toBe(false);
		expect(SWARM_METADATA_JSON_SCHEMA.additionalProperties).toBe(true);
		expect(SWARM_METADATA_JSON_SCHEMA.properties.shortleash).toBe(SWARM_DEFINITION_JSON_SCHEMA);
	});

	it("validates the standard metadata.shortleash shape and ignores sibling metadata", () => {
		const definition = validateSwarmMetadata(validMetadata);
		expect(definition.name).toBe("metadata-schema");
		expect([...definition.agents.keys()]).toEqual(["discover", "implement"]);
		expect(hasSwarmMetadata(JSON.stringify(validMetadata))).toBe(true);
	});

	it("accepts direct current-session metadata without agents", () => {
		const definition = validateSwarmMetadata({
			shortleash: {
				name: "direct-metadata",
				workspace: ".",
				task: "Continue the current objective.",
				checks: ["fixture:architecture", "fixture:evidence"],
				evals: ["fixture:review"],
			},
		});

		expect(definition.agents.size).toBe(0);
		expect(definition.task).toBe("Continue the current objective.");
		expect(definition.checks).toEqual(["fixture:architecture", "fixture:evidence"]);
	});

	it("rejects unknown fields and invalid dependency references before bd is invoked", () => {
		expect(() => validateSwarmMetadata({ shortleash: { ...validMetadata.shortleash, unexpected: true } })).toThrow(
			"unexpected is not allowed",
		);
		expect(() =>
			validateSwarmMetadata({
				shortleash: {
					...validMetadata.shortleash,
					agents: { worker: { role: "engineer", task: "work", waits_for: ["missing"] } },
				},
			}),
		).toThrow("unknown agent");
	});

	it("rejects dependency cycles", () => {
		expect(() =>
			validateSwarmMetadata({
				shortleash: {
					...validMetadata.shortleash,
					agents: {
						first: { role: "engineer", task: "first", waits_for: ["second"] },
						second: { role: "engineer", task: "second", waits_for: ["first"] },
					},
				},
			}),
		).toThrow("cycle detected");
	});
});
