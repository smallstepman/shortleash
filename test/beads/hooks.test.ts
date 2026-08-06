import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type BeadsClaimHookHandler,
	formatBeadsShowCard,
	parseBeadsCommand,
	registerBeadsHooks,
} from "../../src/beads/hooks";

const workspace = "/tmp/shortleash-hooks-test";

function validMetadata(name = "hook-swarm"): Record<string, unknown> {
	return {
		shortleash: {
			name,
			workspace: ".",
			agents: {
				worker: { role: "engineer", task: "Implement the claimed work." },
			},
		},
	};
}

type Handler = (event: any, ctx: ExtensionContext) => Promise<unknown>;

function harness(options: { bead?: Record<string, unknown>; onClaim?: BeadsClaimHookHandler } = {}) {
	const handlers = new Map<string, Handler>();
	const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const messages: unknown[] = [];
	const registeredTools: any[] = [];
	const schema = () => ({
		optional() {
			return this;
		},
		strict() {
			return this;
		},
	});
	const bead = options.bead ?? {
		id: "bd-hook",
		title: "Hooked work",
		status: "open",
		type: "task",
		metadata: validMetadata(),
	};
	const api = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: (tool: unknown) => registeredTools.push(tool),
		zod: {
			object: schema,
			string: schema,
			record: schema,
			number: schema,
			boolean: schema,
		},
		exec: async (command: string, args: string[], execOptions?: { cwd?: string }) => {
			calls.push({ command, args, cwd: execOptions?.cwd });
			if (args[0] === "show") {
				return { stdout: JSON.stringify({ data: [bead] }), stderr: "", code: 0, killed: false };
			}
			return {
				stdout: JSON.stringify({ data: { id: bead.id, status: "in_progress" } }),
				stderr: "",
				code: 0,
				killed: false,
			};
		},
		sendMessage: (message: unknown) => messages.push(message),
	} as unknown as ExtensionAPI;
	registerBeadsHooks(api, { onClaim: options.onClaim });
	return { handlers, calls, messages, bead, registeredTool: registeredTools[0] };
}

function context(): ExtensionContext {
	return { cwd: workspace } as ExtensionContext;
}

describe("Beads bash hooks", () => {
	it("parses only a direct bd command and declines shell composition", () => {
		expect(parseBeadsCommand("bd show 'issue with spaces'")?.args).toEqual(["show", "issue with spaces"]);
		expect(parseBeadsCommand("bd show issue | jq .")?.args).toBeUndefined();
		expect(parseBeadsCommand("printf bd show")?.args).toBeUndefined();
	});

	it("renders an envelope returned by bd show as an issue card", () => {
		const card = formatBeadsShowCard({
			data: [
				{
					id: "bd-1",
					title: "A hooked issue",
					status: "open",
					issue_type: "task",
					priority: 1,
					description: "Investigate the repository.",
					metadata: { source: "test" },
				},
			],
		});

		expect(card).toContain("Beads issue: bd-1");
		expect(card).toContain("Title: A hooked issue");
		expect(card).toContain("Metadata:");
	});

	it("intercepts direct agent bd show results without rewriting the command or exposing JSON", async () => {
		const { handlers, calls } = harness();
		const call = await handlers.get("tool_call")?.(
			{ type: "tool_call", toolName: "bash", toolCallId: "show-call", input: { command: "bd show bd-hook" } },
			context(),
		);
		expect(call).toBeUndefined();
		expect(calls).toEqual([]);

		const result = await handlers.get("tool_result")?.(
			{
				type: "tool_result",
				toolName: "bash",
				toolCallId: "show-call",
				input: { command: "bd show bd-hook" },
				content: [{ type: "text", text: "native bd output" }],
				isError: false,
			},
			context(),
		);
		expect(calls).toEqual([{ command: "bd", args: ["show", "bd-hook", "--json"], cwd: workspace }]);
		expect(result).toMatchObject({
			content: [{ type: "text" }],
			details: {
				type: "shortleash-beads-show",
				operation: "show",
				args: ["show", "bd-hook"],
				data: [{ id: "bd-hook", title: "Hooked work" }],
			},
		});
		expect((result as { content: [{ text: string }] }).content[0].text).toContain("Beads issue: bd-hook");
		expect((result as { content: [{ text: string }] }).content[0].text).not.toContain('"id"');
	});
	it("delegates direct and complex commands to native Bash without rewriting", async () => {
		const { registeredTool } = harness();
		const forwarded: Array<Record<string, unknown>> = [];
		const ctx = {
			...context(),
			invokeTool: async (input: Record<string, unknown>) => {
				forwarded.push(input);
				return { content: [{ type: "text", text: "native result" }], isError: false };
			},
		} as ExtensionContext;

		await registeredTool.execute(
			"direct-call",
			{ command: "bd show bd-hook" },
			new AbortController().signal,
			undefined,
			ctx,
		);
		await registeredTool.execute(
			"complex-call",
			{ command: "bd show bd-hook | jq ." },
			new AbortController().signal,
			undefined,
			ctx,
		);

		expect(forwarded).toEqual([{ command: "bd show bd-hook" }, { command: "bd show bd-hook | jq ." }]);
	});

	it("blocks invalid Shortleash metadata before bd create/update executes", async () => {
		const { handlers, calls } = harness();
		const event = {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "create-call",
			input: {
				command: `bd create --title broken --metadata '${JSON.stringify({ shortleash: { name: "broken" } })}'`,
			},
		};
		const result = await handlers.get("tool_call")?.(event, context());

		expect(result).toMatchObject({ block: true });
		expect((result as { reason: string }).reason).toContain("shortleash");
		expect(calls).toEqual([]);
	});

	it("validates a configured claim, lets bd claim, and starts the same logical OMP run", async () => {
		let claimedIssue: string | undefined;
		let claimedContext: ExtensionContext | undefined;
		const { handlers, messages } = harness({
			onClaim: async (issueId, ctx) => {
				claimedIssue = issueId;
				claimedContext = ctx;
				return { status: "completed", swarmName: "hook-swarm" };
			},
		});
		const ctx = context();
		const call = await handlers.get("tool_call")?.(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "claim-call",
				input: { command: "bd update bd-hook --claim" },
			},
			ctx,
		);
		expect(call).toMatchObject({ input: { command: "bd update bd-hook --claim --json" } });

		const result = await handlers.get("tool_result")?.(
			{
				type: "tool_result",
				toolName: "bash",
				toolCallId: "claim-call",
				input: { command: "bd update bd-hook --claim --json" },
				content: [{ type: "text", text: '{"id":"bd-hook","status":"in_progress"}' }],
				isError: false,
			},
			ctx,
		);
		expect((result as { content: [{ text: string }] }).content[0].text).toContain("autorun started");
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(claimedIssue).toBe("bd-hook");
		expect(claimedContext).toBe(ctx);
		expect(JSON.stringify(messages)).toContain("autorun for 'bd-hook' finished");
	});

	it("handles user bd show through a bounded argv call", async () => {
		const { handlers, calls } = harness();
		const result = await handlers.get("user_bash")?.(
			{ type: "user_bash", command: "bd show bd-hook", cwd: workspace, excludeFromContext: false },
			context(),
		);

		expect(calls[0]).toMatchObject({ command: "bd", args: ["show", "bd-hook", "--json"], cwd: workspace });
		expect((result as { result: { output: string } }).result.output).toContain("Beads issue: bd-hook");
	});
});
