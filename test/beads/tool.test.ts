import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BeadsClient } from "../../src/beads/client";
import { type BeadsToolParams, createBeadsTool } from "../../src/beads/tool";
import swarmExtension from "../../src/extension";

function validSwarmMetadata(name = "test-swarm"): Record<string, unknown> {
	return {
		shortleash: {
			name,
			workspace: ".",
			agents: {
				worker: {
					role: "engineer",
					task: "Implement the claimed work.",
				},
			},
		},
	};
}

describe("BeadsClient", () => {
	it("maps bounded reads and mutations to JSON bd argv calls", async () => {
		const calls: string[][] = [];
		const client = new BeadsClient({
			run: async args => {
				calls.push([...args]);
				return JSON.stringify({ data: args[0] === "create" ? { id: "bd-new" } : [] });
			},
		});

		await client.show({ ids: ["bd-1"] }, process.cwd());
		await client.list({ parentId: "bd-parent", status: "open", priority: 2, limit: 3 }, process.cwd());
		await client.ready({ assignee: "alice", unassigned: true }, process.cwd());
		await client.create(
			{
				title: "Milestone",
				type: "chore",
				deferUntil: "+1d",
				deps: [{ issueId: "bd-1", type: "discovered-from" }],
			},
			process.cwd(),
		);
		await client.update(
			{ issueId: "bd-1", type: "chore", parentId: "bd-parent", status: "closed", appendNotes: "accepted" },
			process.cwd(),
		);
		await client.claim({ issueId: "bd-1" }, process.cwd());
		await client.close({ issueId: "bd-1", reason: "accepted" }, process.cwd());
		await client.dependencies(
			{ action: "add", issueIds: ["bd-1"], dependencyIssueId: "bd-2", type: "blocks" },
			process.cwd(),
		);
		await client.dependencies({ action: "list", issueIds: ["bd-1"], direction: "up" }, process.cwd());

		expect(calls).toEqual([
			["show", "bd-1", "--json"],
			["list", "--parent", "bd-parent", "--status", "open", "--priority", "2", "--limit", "3", "--json"],
			["ready", "--assignee", "alice", "--unassigned", "--json"],
			["create", "--title", "Milestone", "--type", "chore", "--defer", "+1d", "--json"],
			["dep", "add", "bd-new", "bd-1", "--type", "discovered-from", "--json"],
			[
				"update",
				"bd-1",
				"--type",
				"chore",
				"--parent",
				"bd-parent",
				"--status",
				"closed",
				"--append-notes",
				"accepted",
				"--json",
			],
			["update", "bd-1", "--claim", "--json"],
			["close", "bd-1", "--reason", "accepted", "--json"],
			["dep", "add", "bd-1", "bd-2", "--type", "blocks", "--json"],
			["dep", "list", "bd-1", "--direction", "up", "--json"],
		]);
	});
	it("requires valid swarm metadata for feature, bug, and task mutations", async () => {
		let commandCount = 0;
		const client = new BeadsClient({
			run: async _args => {
				commandCount++;
				return JSON.stringify({ data: [{ id: "bd-existing", type: "task", metadata: {} }] });
			},
		});

		await expect(client.create({ title: "Missing config", type: "feature" }, process.cwd())).rejects.toThrow(
			"requires metadata.shortleash",
		);
		await expect(
			client.create(
				{ title: "Invalid config", type: "bug", metadata: { shortleash: { name: "broken" } } },
				process.cwd(),
			),
		).rejects.toThrow("metadata.shortleash");
		await expect(client.update({ issueId: "bd-existing", notes: "touch" }, process.cwd())).rejects.toThrow(
			"existing task issue",
		);
		expect(commandCount).toBe(1);
	});
	it("rejects non-swarm metadata that would replace a configured issue", async () => {
		const calls: string[][] = [];
		const client = new BeadsClient({
			run: async args => {
				calls.push([...args]);
				return JSON.stringify({
					data: [
						{
							id: "bd-configured",
							type: "task",
							metadata: validSwarmMetadata("existing-swarm"),
						},
					],
				});
			},
		});

		await expect(
			client.update(
				{ issueId: "bd-configured", title: "Keep swarm configuration", metadata: { workflow: "plain" } },
				process.cwd(),
			),
		).rejects.toThrow("requires metadata.shortleash");
		expect(calls).toEqual([["show", "bd-configured", "--json"]]);
	});

	it("rejects nonexistent and reversed dependency removals", async () => {
		const reversedCalls: string[][] = [];
		const reversedClient = new BeadsClient({
			run: async args => {
				reversedCalls.push([...args]);
				if (args[0] === "dep" && args[1] === "list" && args[2] === "bd-2") {
					return JSON.stringify({ data: [{ id: "bd-1" }] });
				}
				return JSON.stringify({ data: [] });
			},
		});

		await expect(
			reversedClient.dependencies(
				{ action: "remove", issueIds: ["bd-1"], dependencyIssueId: "bd-2" },
				process.cwd(),
			),
		).rejects.toThrow("dependency edge is reversed");
		expect(reversedCalls).toEqual([
			["dep", "list", "bd-1", "--direction", "down", "--json"],
			["dep", "list", "bd-2", "--direction", "down", "--json"],
		]);

		const missingCalls: string[][] = [];
		const missingClient = new BeadsClient({
			run: async args => {
				missingCalls.push([...args]);
				return JSON.stringify({ data: [] });
			},
		});

		await expect(
			missingClient.dependencies({ action: "remove", issueIds: ["bd-1"], dependencyIssueId: "bd-3" }, process.cwd()),
		).rejects.toThrow("dependency edge not found");
		expect(missingCalls).toEqual([
			["dep", "list", "bd-1", "--direction", "down", "--json"],
			["dep", "list", "bd-3", "--direction", "down", "--json"],
		]);
	});

	it("verifies dependency removal after the bd command reports success", async () => {
		const calls: string[][] = [];
		let listCalls = 0;
		const client = new BeadsClient({
			run: async args => {
				calls.push([...args]);
				if (args[0] === "dep" && args[1] === "list") {
					listCalls++;
					return JSON.stringify({ data: listCalls === 1 ? [{ id: "bd-2" }] : [] });
				}
				return JSON.stringify({ data: { status: "removed" } });
			},
		});

		const result = await client.dependencies(
			{ action: "remove", issueIds: ["bd-1"], dependencyIssueId: "bd-2" },
			process.cwd(),
		);

		expect(result.data).toEqual({ status: "removed" });
		expect(calls).toEqual([
			["dep", "list", "bd-1", "--direction", "down", "--json"],
			["dep", "remove", "bd-1", "bd-2", "--json"],
			["dep", "list", "bd-1", "--direction", "down", "--json"],
		]);
	});
	it("allows Beads to close an issue without a reason", async () => {
		const calls: string[][] = [];
		const client = new BeadsClient({
			run: async args => {
				calls.push([...args]);
				return JSON.stringify({ data: { id: "bd-1", status: "closed" } });
			},
		});

		await client.close({ issueId: "bd-1" }, process.cwd());

		expect(calls).toEqual([["close", "bd-1", "--json"]]);
	});

	it("passes nested metadata through a temporary file and cleans it up", async () => {
		const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "beads-tool-test-"));
		try {
			let observed: unknown;
			let metadataPath = "";
			const client = new BeadsClient({
				temporaryDirectory,
				run: async args => {
					metadataPath = args[args.indexOf("--metadata") + 1]?.slice(1) ?? "";
					observed = JSON.parse(await fs.readFile(metadataPath, "utf8"));
					return JSON.stringify({ data: { id: "bd-new" } });
				},
			});

			const metadata = {
				...validSwarmMetadata(),
				workflow: { instance_id: "wf-1", milestone: true },
			};
			const result = await client.create({ title: "Nested metadata", metadata }, temporaryDirectory);

			expect(result.data).toEqual({ id: "bd-new" });
			expect(observed).toEqual(metadata);
			expect(metadataPath).toContain(temporaryDirectory);
			expect(await fs.readdir(temporaryDirectory)).toEqual([]);
		} finally {
			await fs.rm(temporaryDirectory, { recursive: true, force: true });
		}
	});

	it("accepts workspace-relative metadata files but rejects unsafe or invalid sources", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "beads-metadata-test-"));
		try {
			await fs.mkdir(path.join(workspace, ".omp"));
			const metadataFile = path.join(workspace, ".omp", "workflow.json");
			await fs.writeFile(
				metadataFile,
				JSON.stringify({ ...validSwarmMetadata("file-swarm"), workflow: { phase: "discovery" } }),
			);
			const calls: string[][] = [];
			const client = new BeadsClient({
				run: async args => {
					calls.push([...args]);
					return JSON.stringify({ data: { id: "bd-new" } });
				},
			});

			await client.create({ title: "File metadata", metadataFile: ".omp/workflow.json" }, workspace);
			expect(calls[0]).toEqual([
				"create",
				"--title",
				"File metadata",
				"--type",
				"task",
				"--metadata",
				`@${metadataFile}`,
				"--json",
			]);
			await expect(client.create({ title: "Escape", metadataFile: "../outside.json" }, workspace)).rejects.toThrow(
				"within the workspace",
			);
			await fs.writeFile(metadataFile, "[]");
			await expect(
				client.create({ title: "Array metadata", metadataFile: ".omp/workflow.json" }, workspace),
			).rejects.toThrow("JSON object");
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});
});

describe("beads OMP tool", () => {
	it("validates direct execute calls and keeps claim separate from execution", async () => {
		const calls: string[][] = [];
		const tool = createBeadsTool({
			client: new BeadsClient({
				run: async args => {
					calls.push([...args]);
					return JSON.stringify({ data: { id: "bd-1", status: "in_progress" } });
				},
			}),
		});
		const ctx = { cwd: process.cwd() } as Parameters<typeof tool.execute>[4];

		const result = await tool.execute(
			"claim-call",
			{ op: "claim", issue_id: "bd-1" } as BeadsToolParams,
			undefined,
			undefined,
			ctx,
		);
		expect(calls).toEqual([["update", "bd-1", "--claim", "--json"]]);
		expect(result.content).toEqual([{ type: "text", text: '{\n  "id": "bd-1",\n  "status": "in_progress"\n}' }]);
		expect(result.details).toMatchObject({ operation: "claim", args: ["update", "bd-1", "--claim"] });
		await tool.execute("close-call", { op: "close", issue_id: "bd-1" } as BeadsToolParams, undefined, undefined, ctx);
		expect(calls.at(-1)).toEqual(["close", "bd-1", "--json"]);

		await expect(
			tool.execute("invalid-show", { op: "show" } as BeadsToolParams, undefined, undefined, ctx),
		).rejects.toThrow("show requires issue_id or issue_ids");
	});

	it("routes a JavaScript-eval-shaped nested metadata call without JSON escaping", async () => {
		let receivedMetadata: Record<string, unknown> | undefined;
		const tool = createBeadsTool({
			client: new BeadsClient({
				run: async args => {
					const metadataPath = args[args.indexOf("--metadata") + 1]?.slice(1);
					receivedMetadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as Record<string, unknown>;
					return JSON.stringify({ data: { id: "bd-new" } });
				},
			}),
		});
		const ctx = { cwd: process.cwd() } as Parameters<typeof tool.execute>[4];

		const metadata = {
			...validSwarmMetadata("eval-swarm"),
			workflow: { instance_id: "wf-1", projection: { milestone: "architecture" } },
		};
		await tool.execute(
			"create-call",
			{
				op: "create",
				title: "Workflow milestone",
				metadata,
			} as BeadsToolParams,
			undefined,
			undefined,
			ctx,
		);

		expect(receivedMetadata).toEqual(metadata);
	});

	it("delegates a claimed configured Bead to the swarm handler", async () => {
		const calls: string[][] = [];
		const metadata = validSwarmMetadata("claim-swarm");
		let delegated = 0;
		const tool = createBeadsTool({
			client: new BeadsClient({
				run: async args => {
					calls.push([...args]);
					if (args[0] === "show") {
						return JSON.stringify({
							data: [
								{
									id: "bd-claim",
									title: "Claimed work",
									type: "task",
									metadata,
								},
							],
						});
					}
					return JSON.stringify({ data: { id: "bd-claim", status: "in_progress" } });
				},
			}),
			onClaim: async input => {
				delegated++;
				expect(input.issueId).toBe("bd-claim");
				expect(input.bead.title).toBe("Claimed work");
				return { status: "completed", swarmName: "claim-swarm", iterations: 1, errors: [] };
			},
		});
		const ctx = { cwd: process.cwd() } as Parameters<typeof tool.execute>[4];

		const result = await tool.execute(
			"claim-configured",
			{ op: "claim", issue_id: "bd-claim" } as BeadsToolParams,
			undefined,
			undefined,
			ctx,
		);

		expect(delegated).toBe(1);
		expect(calls).toEqual([
			["update", "bd-claim", "--claim", "--json"],
			["show", "bd-claim", "--json"],
		]);
		expect(result.details).toMatchObject({
			delegation: { status: "completed", swarmName: "claim-swarm", iterations: 1 },
		});
		expect(JSON.parse(result.content[0].text)).toMatchObject({
			swarm: { status: "completed", swarmName: "claim-swarm" },
		});
	});

	it("claims an unconfigured Bead without invoking the swarm handler", async () => {
		let delegated = 0;
		const tool = createBeadsTool({
			client: new BeadsClient({
				run: async args => {
					if (args[0] === "show") {
						return JSON.stringify({ data: [{ id: "bd-plain", type: "task", metadata: { workflow: "plain" } }] });
					}
					return JSON.stringify({ data: { id: "bd-plain", status: "in_progress" } });
				},
			}),
			onClaim: async () => {
				delegated++;
				return { status: "completed" };
			},
		});
		const ctx = { cwd: process.cwd() } as Parameters<typeof tool.execute>[4];

		await tool.execute(
			"claim-plain",
			{ op: "claim", issue_id: "bd-plain" } as BeadsToolParams,
			undefined,
			undefined,
			ctx,
		);

		expect(delegated).toBe(0);
	});
});

describe("extension registration", () => {
	it("registers one discoverable beads tool with the extension", () => {
		const registeredTools: unknown[] = [];
		const api = {
			setLabel: () => {},
			registerCommand: () => {},
			registerTool: (tool: unknown) => registeredTools.push(tool),
		} as Parameters<typeof swarmExtension>[0];

		swarmExtension(api);

		expect(registeredTools).toHaveLength(1);
		expect(registeredTools[0]).toMatchObject({
			name: "beads",
			loadMode: "discoverable",
			strict: true,
		});
	});
});
