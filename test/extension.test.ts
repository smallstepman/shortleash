import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import shortleashExtension from "../src/extension";

type Completion = { value: string; label: string; description?: string };
type Command = { getArgumentCompletions?: (prefix: string) => Completion[] | null };

const validShortleash = {
	name: "fixture-swarm",
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
				id: "open-swarm",
				title: "Open swarm",
				status: "open",
				metadata: { shortleash: validShortleash },
			},
			{
				id: "closed-swarm",
				title: "Closed swarm",
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
				id: "malformed-swarm",
				title: "Malformed swarm",
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
		expect(suggestions?.find(item => item.value === "run issue://open-swarm")).toMatchObject({
			label: "open-swarm — Open swarm",
			description: "Run Shortleash 'fixture-swarm'",
		});
		expect(suggestions?.some(item => item.value.includes("closed-swarm"))).toBe(false);
		expect(suggestions?.some(item => item.value.includes("plain-task"))).toBe(false);
		expect(suggestions?.some(item => item.value.includes("malformed-swarm"))).toBe(false);
		expect(calls).toEqual([["list", "--status", "open", "--json"]]);
	});

	it("filters Bead suggestions after an input subcommand", async () => {
		const { command } = loadCommand([
			{
				id: "alpha-swarm",
				title: "Alpha pipeline",
				status: "open",
				metadata: { shortleash: { ...validShortleash, name: "alpha" } },
			},
			{
				id: "beta-swarm",
				title: "Beta pipeline",
				status: "open",
				metadata: { shortleash: { ...validShortleash, name: "beta" } },
			},
		]);

		expect((await complete(command, "run "))?.map(item => item.value)).toEqual([
			"run issue://alpha-swarm",
			"run issue://beta-swarm",
		]);
		expect((await complete(command, "plan beta"))?.map(item => item.value)).toEqual(["plan issue://beta-swarm"]);
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
});
