import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createShortleashBeadsProjector,
	resolveShortleashInput,
	type ShortleashBeadRecord,
	shortleashDefinitionFromBead,
} from "../../../src/orchestration/adapters/beads";

const bead: ShortleashBeadRecord = {
	id: "obligated-gty",
	title: "Implement streaming retry logic",
	metadata: {
		shortleash: {
			name: "streaming-retry",
			workspace: ".",
			agents: {
				backend: {
					role: "backend",
					task: "Implement streaming retry logic.",
				},
			},
		},
		workflow: { phase: "implementation", agent: "backend" },
		acceptance: ["unit-tests", "integration-tests"],
		risk: "medium",
	},
};

describe("Beads-backed Shortleash input", () => {
	it("reads the standard Shortleash definition from metadata.shortleash", () => {
		const definition = shortleashDefinitionFromBead(bead);
		expect(definition.name).toBe("streaming-retry");
		expect([...definition.agents.keys()]).toEqual(["backend"]);
	});

	it("rejects metadata that does not use the Shortleash schema", () => {
		expect(() =>
			shortleashDefinitionFromBead({
				...bead,
				metadata: { workflow: { phase: "implementation", agent: "backend" } },
			}),
		).toThrow("metadata.shortleash");
	});

	it("resolves both bare Beads IDs and issue:// references", async () => {
		const reader = async (id: string): Promise<ShortleashBeadRecord> => ({ ...bead, id });
		const bare = await resolveShortleashInput("obligated-gty", process.cwd(), { readBead: reader });
		const uri = await resolveShortleashInput("issue://obligated-gty", process.cwd(), { readBead: reader });

		expect(bare.beadId).toBe("obligated-gty");
		expect(uri.beadId).toBe("obligated-gty");
		expect(bare.definition.name).toBe(uri.definition.name);
		expect(bare.definitionPath).toBe("issue://obligated-gty");
	});

	it("keeps JSON file input working", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-input-test-"));
		try {
			const filePath = path.join(tempDir, "workflow.json");
			await fs.writeFile(
				filePath,
				JSON.stringify({
					swarm: {
						name: "file-workflow",
						workspace: ".",
						agents: { worker: { role: "engineer", task: "Run the work." } },
					},
				}),
			);

			const resolved = await resolveShortleashInput(filePath, tempDir);
			expect(resolved.beadId).toBeUndefined();
			expect(resolved.definition.name).toBe("file-workflow");
			expect(resolved.definitionDir).toBe(tempDir);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("projects lifecycle notes idempotently and detects a closed-Bead drift", async () => {
		const calls: string[][] = [];
		let notes = "Existing note";
		const projector = createShortleashBeadsProjector("obligated-gty", process.cwd(), {
			run: async args => {
				calls.push(args);
				if (args[0] === "show") {
					return JSON.stringify({
						data: [{ id: "obligated-gty", status: "closed", notes }],
					});
				}
				notes = args.at(-1) ?? notes;
				return "";
			},
		});

		const event = {
			type: "started" as const,
			shortleashName: "streaming-retry",
			status: "running",
		};
		await projector.project(event);
		await projector.project(event);
		const reconciliation = await projector.reconcile("running");
		expect(reconciliation.drift).toBe(true);
		expect(calls.filter(args => args[0] === "update")).toHaveLength(1);
		expect(calls[1]).toEqual([
			"update",
			"obligated-gty",
			"--notes",
			"Existing note\n[shortleash:streaming-retry] started: running",
		]);
	});

	it("reports a missing projected Bead as drift", async () => {
		const projector = createShortleashBeadsProjector("obligated-gty", process.cwd(), {
			run: async () => "[]",
		});
		const reconciliation = await projector.reconcile("running");
		expect(reconciliation).toMatchObject({
			beadId: "obligated-gty",
			drift: true,
			missing: true,
		});
	});
});
