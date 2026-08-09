import { describe, expect, it } from "bun:test";
import {
	hasShortleashMetadata,
	SHORTLEASH_DEFINITION_JSON_SCHEMA,
	SHORTLEASH_METADATA_JSON_SCHEMA,
	validateShortleashMetadata,
} from "../../../src/orchestration/definition/metadata";

const validMetadata = {
	shortleash: {
		name: "metadata-schema",
		workspace: ".",
		agents: {
			discover: {
				agent: "scout",
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
		expect(SHORTLEASH_DEFINITION_JSON_SCHEMA.required).toEqual(["name", "workspace"]);
		expect(SHORTLEASH_DEFINITION_JSON_SCHEMA.additionalProperties).toBe(false);
		expect(SHORTLEASH_METADATA_JSON_SCHEMA.additionalProperties).toBe(true);
		expect(SHORTLEASH_METADATA_JSON_SCHEMA.properties.shortleash).toBe(SHORTLEASH_DEFINITION_JSON_SCHEMA);
	});

	it("validates the standard metadata.shortleash shape and ignores sibling metadata", () => {
		const definition = validateShortleashMetadata(validMetadata);
		expect(definition.name).toBe("metadata-schema");
		expect(definition.agents.get("discover")?.agent).toBe("scout");
		expect([...definition.agents.keys()]).toEqual(["discover", "implement"]);
		expect(hasShortleashMetadata(JSON.stringify(validMetadata))).toBe(true);
	});

	it("accepts direct current-session metadata without agents", () => {
		const definition = validateShortleashMetadata({
			shortleash: {
				name: "direct-metadata",
				workspace: ".",
				task: "Continue the current objective.",
				checks: ["./checks/architecture.ts", "./checks/evidence.ts"],
				evals: ["./checks/review.ts"],
			},
		});

		expect(definition.agents.size).toBe(0);
		expect(definition.task).toBe("Continue the current objective.");
		expect(definition.checks).toEqual(["./checks/architecture.ts", "./checks/evidence.ts"]);
	});

	it("rejects unknown fields and invalid dependency references before bd is invoked", () => {
		expect(() =>
			validateShortleashMetadata({ shortleash: { ...validMetadata.shortleash, unexpected: true } }),
		).toThrow("unexpected is not allowed");
		expect(() =>
			validateShortleashMetadata({
				shortleash: {
					...validMetadata.shortleash,
					agents: { worker: { role: "engineer", task: "work", waits_for: ["missing"] } },
				},
			}),
		).toThrow("unknown agent");
	});

	it("rejects dependency cycles", () => {
		expect(() =>
			validateShortleashMetadata({
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
