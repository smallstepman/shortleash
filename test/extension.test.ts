import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import shortleashExtension from "../src/extension";

type Completion = { value: string; label: string; description?: string };
type Command = { getArgumentCompletions?: (prefix: string) => Completion[] | null };

const validShortleash = {
	name: "fixture-shortleash",
	workspace: ".",
	agents: {
		worker: { role: "worker", task: "Inspect the fixture." },
	},
};

function loadCommand(
	issues: unknown[],
	options: { code?: number; stderr?: string } = {},
): { command: Command; calls: string[][] } {
	const commands = new Map<string, Command>();
	const calls: string[][] = [];
	const pi = {
		on: () => {},
		setLabel: () => {},
		registerTool: () => {},
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		exec: async (_command: string, args: string[]) => {
			calls.push(args);
			return {
				stdout: JSON.stringify({ data: issues }),
				stderr: options.stderr ?? "",
				code: options.code ?? 0,
				killed: false,
			};
		},
	} as unknown as ExtensionAPI;
	shortleashExtension(pi);
	const command = commands.get("shortleash");
	if (!command) throw new Error("shortleash command was not registered");
	return { command, calls };
}

async function complete(command: Command, prefix: string): Promise<Completion[] | null> {
	return await (command.getArgumentCompletions?.(prefix) as unknown as Promise<Completion[] | null>);
}

describe("Shortleash command completions", () => {
	it("keeps subcommands and adds runnable open Shortleash Beads at the root", async () => {
		const { command, calls } = loadCommand([
			{
				id: "open-shortleash",
				title: "Open Shortleash",
				status: "open",
				metadata: { shortleash: validShortleash },
			},
			{
				id: "closed-shortleash",
				title: "Closed Shortleash",
				status: "closed",
				metadata: { shortleash: validShortleash },
			},
			{
				id: "plain-task",
				title: "Plain task",
				status: "open",
				metadata: { workflow: "implementation" },
			},
			{
				id: "malformed-shortleash",
				title: "Malformed Shortleash",
				status: "open",
				metadata: { shortleash: { workspace: "." } },
			},
		]);

		const suggestions = await complete(command, "");
		expect(suggestions?.slice(0, 7).map(item => item.value)).toEqual([
			"run",
			"plan",
			"inspect",
			"status",
			"evaluate",
			"reconcile",
			"help",
		]);
		expect(suggestions?.find(item => item.value === "run issue://open-shortleash")).toMatchObject({
			label: "open-shortleash — Open Shortleash",
			description: "Run Shortleash 'fixture-shortleash'",
		});
		expect(suggestions?.some(item => item.value.includes("closed-shortleash"))).toBe(false);
		expect(suggestions?.some(item => item.value.includes("plain-task"))).toBe(false);
		expect(suggestions?.some(item => item.value.includes("malformed-shortleash"))).toBe(false);
		expect(calls).toEqual([["list", "--status", "open", "--json"]]);
	});

	it("filters Bead suggestions after an input subcommand", async () => {
		const { command } = loadCommand([
			{
				id: "alpha-shortleash",
				title: "Alpha pipeline",
				status: "open",
				metadata: { shortleash: { ...validShortleash, name: "alpha" } },
			},
			{
				id: "beta-shortleash",
				title: "Beta pipeline",
				status: "open",
				metadata: { shortleash: { ...validShortleash, name: "beta" } },
			},
		]);

		expect((await complete(command, "run "))?.map(item => item.value)).toEqual([
			"run issue://alpha-shortleash",
			"run issue://beta-shortleash",
		]);
		expect((await complete(command, "plan beta"))?.map(item => item.value)).toEqual(["plan issue://beta-shortleash"]);
	});

	it("falls back to existing subcommands when Beads is unavailable", async () => {
		const { command } = loadCommand([], { code: 1, stderr: "bd unavailable" });

		expect((await complete(command, ""))?.map(item => item.value)).toEqual([
			"run",
			"plan",
			"inspect",
			"status",
			"evaluate",
			"reconcile",
			"help",
		]);
		expect(await complete(command, "run ")).toBeNull();
	});
	it("finalizes a direct current-session run through the shared policy path", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-direct-extension-test-"));
		try {
			const definitionPath = path.join(root, "workflow.json");
			await fs.writeFile(
				definitionPath,
				JSON.stringify({ shortleash: { name: "direct-extension", workspace: "./workspace", task: "finish" } }),
			);
			type TestHandler = (event: unknown, context: unknown) => Promise<void> | void;
			type TestCommand = { handler: (args: string, context: unknown) => Promise<void> | void };
			const handlers = new Map<string, TestHandler>();
			const commands = new Map<string, TestCommand>();
			const notices: string[] = [];
			const messages: string[] = [];
			const sessionManager = { getSessionId: () => "direct-extension-session", getBranch: () => [] };
			const ctx = {
				cwd: root,
				sessionManager,
				modelRegistry: {},
				ui: { notify: (message: string) => notices.push(message) },
			};
			const pi = {
				on: (event: string, handler: TestHandler) => {
					handlers.set(event, handler);
				},
				registerCommand: (name: string, command: TestCommand) => commands.set(name, command),
				registerTool: () => {},
				exec: async () => ({ stdout: "[]", stderr: "", code: 0, killed: false }),
				sendUserMessage: (message: string) => messages.push(message),
				logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
				pi: { settings: undefined },
			} as unknown as ExtensionAPI;

			shortleashExtension(pi);
			const command = commands.get("shortleash");
			if (!command) throw new Error("shortleash command was not registered");
			await command.handler(`run ${definitionPath}`, ctx);
			const agentEnd = handlers.get("agent_end");
			if (!agentEnd) throw new Error("agent_end handler was not registered");
			await agentEnd({ willContinue: false, messages: [{ role: "assistant", content: "done" }] }, ctx);

			expect(notices).toContain("Shortleash 'direct-extension' completed in the current OMP session.");
			expect(messages).toHaveLength(1);
			expect(messages[0]).toContain("\nfinish\n");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
