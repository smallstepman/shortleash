import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createSwarmBeadsProjector,
	resolveSwarmInput,
	type SwarmBeadRecord,
	swarmDefinitionFromBead,
} from "../../src/swarm/beads";

const bead: SwarmBeadRecord = {
	id: "obligated-gty",
	title: "Implement streaming retry logic",
	metadata: {
		shortleash: {
			name: "streaming-retry",
			workspace: ".",
			mode: "sequential",
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

describe("Beads-backed swarm input", () => {
	it("reads the standard swarm definition from metadata.shortleash", () => {
		const definition = swarmDefinitionFromBead(bead);
		expect(definition.name).toBe("streaming-retry");
		expect(definition.mode).toBe("sequential");
		expect([...definition.agents.keys()]).toEqual(["backend"]);
	});

	it("rejects metadata that does not use the swarm schema", () => {
		expect(() =>
			swarmDefinitionFromBead({
				...bead,
				metadata: { workflow: { phase: "implementation", agent: "backend" } },
			}),
		).toThrow("metadata.shortleash");
	});

	it("resolves both bare Beads IDs and issue:// references", async () => {
		const reader = async (id: string): Promise<SwarmBeadRecord> => ({ ...bead, id });
		const bare = await resolveSwarmInput("obligated-gty", process.cwd(), { readBead: reader });
		const uri = await resolveSwarmInput("issue://obligated-gty", process.cwd(), { readBead: reader });

		expect(bare.beadId).toBe("obligated-gty");
		expect(uri.beadId).toBe("obligated-gty");
		expect(bare.definition.name).toBe(uri.definition.name);
		expect(bare.definitionPath).toBe("issue://obligated-gty");
	});

	it("keeps JSON file input working", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-input-test-"));
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

			const resolved = await resolveSwarmInput(filePath, tempDir);
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
		const projector = createSwarmBeadsProjector("obligated-gty", process.cwd(), {
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
			swarmName: "streaming-retry",
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
			"Existing note\n[swarm:streaming-retry] started: running",
		]);
	});

	it("reports a missing projected Bead as drift", async () => {
		const projector = createSwarmBeadsProjector("obligated-gty", process.cwd(), {
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
