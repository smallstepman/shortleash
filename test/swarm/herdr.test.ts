import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildDependencyGraph, buildExecutionWaves } from "../../src/swarm/dag";
import {
	CliHerdrControl,
	type HerdrCallOptions,
	type HerdrControl,
	type HerdrPane,
	type HerdrResult,
	HerdrSwarmSession,
	type HerdrTab,
} from "../../src/swarm/herdr";
import { PipelineController } from "../../src/swarm/pipeline";
import { parseSwarm } from "../../src/swarm/schema";
import { StateTracker } from "../../src/swarm/state";

class FakeHerdrControl implements HerdrControl {
	readonly calls: string[] = [];
	startAgentFailures = 0;
	#nextPane = 1;

	async probe(): Promise<void> {
		this.calls.push("probe");
	}

	async createTab(options: Parameters<HerdrControl["createTab"]>[0]): Promise<HerdrTab> {
		this.calls.push(`tab:create:${options.label}`);
		return { tabId: "w1:t1", workspaceId: "w1" };
	}

	async listPanes(_workspaceId: string): Promise<HerdrPane[]> {
		this.calls.push("pane:list");
		return [{ paneId: "w1:p-dashboard", tabId: "w1:t1", workspaceId: "w1" }];
	}

	async runPane(_paneId: string, command: string): Promise<void> {
		this.calls.push(`pane:run:${command}`);
	}

	async splitPane(options: Parameters<HerdrControl["splitPane"]>[0]): Promise<string> {
		const paneId = `w1:p-agent-${this.#nextPane++}`;
		this.calls.push(`pane:split:${options.anchorPaneId}:${paneId}`);
		return paneId;
	}
	async startAgent(options: Parameters<HerdrControl["startAgent"]>[0]): Promise<void> {
		this.calls.push(`agent:start:${options.name}:${options.kind}:${options.paneId}`);
		if (this.startAgentFailures > 0) {
			this.startAgentFailures--;
			throw new Error("Herdr VALIDATION_ERROR: agent target pane is not an available shell");
		}
	}

	async waitAgent(target: string): Promise<void> {
		this.calls.push(`agent:wait:${target}`);
	}

	async promptAgent(target: string, prompt: string): Promise<void> {
		this.calls.push(`agent:prompt:${target}:${prompt.split("\n", 1)[0]}`);
	}

	async readAgent(target: string): Promise<string> {
		this.calls.push(`agent:read:${target}`);
		return `completed:${target}`;
	}

	async closePane(paneId: string): Promise<void> {
		this.calls.push(`pane:close:${paneId}`);
	}

	async closeTab(tabId: string): Promise<void> {
		this.calls.push(`tab:close:${tabId}`);
	}
}

class ScriptedHerdrRunner {
	readonly calls: string[][] = [];
	agentOutputs = ["agent output"];
	async run<T>(args: string[], _options?: { textOk?: boolean } & HerdrCallOptions): Promise<HerdrResult<T>> {
		this.calls.push(args);
		if (args[0] === "tab" && args[1] === "create") {
			return { ok: true, data: { tab_id: "w1:t1" } as T };
		}
		if (args[0] === "pane" && args[1] === "list") {
			return {
				ok: true,
				data: { panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }] } as T,
			};
		}
		if (args[0] === "pane" && args[1] === "split") {
			return { ok: true, data: { pane: { pane_id: "w1:p2" } } as T };
		}
		if (args[0] === "agent" && args[1] === "read") {
			return { ok: true, data: (this.agentOutputs.shift() ?? "agent output") as T };
		}
		return { ok: true, data: {} as T };
	}
}

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-herdr-test-"));
});

afterEach(async () => {
	await fs.rm(workspace, { recursive: true, force: true });
});

function diamondDefinition() {
	return parseSwarm(`
swarm:
  name: herdr-diamond
  workspace: .
  mode: parallel
  failure_policy: fail_fast
  agents:
    root:
      role: coordinator
      task: prepare the fan-out
      reports_to: [left, middle, right]
    left:
      role: worker
      task: complete the left branch
      reports_to: [sink]
    middle:
      role: worker
      task: complete the middle branch
      reports_to: [sink]
    right:
      role: worker
      task: complete the right branch
      reports_to: [sink]
    sink:
      role: integrator
      task: integrate the branches
`);
}

describe("Herdr CLI adapter", () => {
	it("uses the pi-herdr layout and orchestration argv contract", async () => {
		const runner = new ScriptedHerdrRunner();
		const control = new CliHerdrControl(runner);

		const tab = await control.createTab({ cwd: workspace, label: "shortleash: test", focus: false });
		const panes = await control.listPanes(tab.workspaceId);
		await control.runPane("w1:p1", "printf hello");
		const split = await control.splitPane({
			anchorPaneId: "w1:p1",
			direction: "right",
			cwd: workspace,
		});
		await control.startAgent({ paneId: split, name: "worker", kind: "omp" });
		await control.waitAgent(split, { timeoutMs: 500 });
		await control.promptAgent(split, "do the work", { timeoutMs: 500 });
		expect(await control.readAgent(split)).toBe("agent output");
		await control.closePane(split);
		await control.closeTab(tab.tabId);

		expect(panes).toEqual([{ paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" }]);
		expect(runner.calls).toEqual([
			["tab", "create", "--cwd", workspace, "--label", "shortleash: test", "--no-focus"],
			["pane", "list", "--workspace", "w1"],
			["pane", "run", "w1:p1", "printf hello"],
			["pane", "split", "--pane", "w1:p1", "--direction", "right", "--cwd", workspace],
			["agent", "start", "worker", "--kind", "omp", "--pane", "w1:p2"],
			["agent", "wait", "w1:p2", "--until", "idle", "--timeout", "500"],
			["agent", "prompt", "w1:p2", "do the work", "--wait", "--timeout", "500"],
			["agent", "read", "w1:p2", "--source", "recent", "--lines", "80", "--format", "text"],
			["pane", "close", "w1:p2"],
			["tab", "close", "w1:t1"],
		]);
	});

	it("polls OMP pane output when Herdr state stays idle", async () => {
		const runner = new ScriptedHerdrRunner();
		runner.agentOutputs = ["baseline", "baseline", "⠙ Running task ⟦esc⟧", "completed"];
		const control = new CliHerdrControl(runner);

		await control.startAgent({ paneId: "w1:p2", name: "worker", kind: "omp" });
		await control.promptAgent("w1:p2", "do the work", { wait: false });
		await control.waitAgent("w1:p2", { timeoutMs: 1_000 });

		expect(runner.calls).toEqual([
			["agent", "start", "worker", "--kind", "omp", "--pane", "w1:p2"],
			["agent", "read", "w1:p2", "--source", "recent", "--lines", "80", "--format", "text"],
			["agent", "prompt", "w1:p2", "do the work"],
			["agent", "read", "w1:p2", "--source", "recent", "--lines", "80", "--format", "text"],
			["agent", "read", "w1:p2", "--source", "recent", "--lines", "80", "--format", "text"],
			["agent", "read", "w1:p2", "--source", "recent", "--lines", "80", "--format", "text"],
		]);
	});
});

describe("Herdr swarm session", () => {
	it("bounds Herdr agent names to the CLI contract", async () => {
		const definition = parseSwarm(`
swarm:
  name: scratchpad-herdr-test-drive
  workspace: .
  agents:
    discover:
      role: smoke worker
      task: pause and report
`);
		const waves = buildExecutionWaves(buildDependencyGraph(definition));
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()], definition.targetCount, definition.mode);
		const control = new FakeHerdrControl();
		control.startAgentFailures = 2;
		const session = await HerdrSwarmSession.open({
			client: control,
			definition,
			definitionInput: "scratchpad-herdr-test-drive.yaml",
			workspace,
			cwd: workspace,
		});
		expect(session).toBeDefined();
		const result = await new PipelineController(definition, waves, stateTracker).run({
			workspace,
			agentRunner: session!.runAgent,
		});
		await session!.dispose();

		const startCall = control.calls.find(call => call.startsWith("agent:start:"));
		const agentName = startCall?.split(":")[2];
		expect(control.calls.filter(call => call.startsWith("agent:start:"))).toHaveLength(3);
		expect(result.status).toBe("completed");
		expect(agentName).toMatch(/^[a-z][a-z0-9_-]*$/);
		expect(agentName?.length).toBeLessThanOrEqual(32);
	});

	it("keeps one dashboard tab and rotates panes by DAG wave", async () => {
		const definition = diamondDefinition();
		const waves = buildExecutionWaves(buildDependencyGraph(definition));
		expect(waves).toEqual([["root"], ["left", "middle", "right"], ["sink"]]);

		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()], definition.targetCount, definition.mode);
		const control = new FakeHerdrControl();
		const session = await HerdrSwarmSession.open({
			client: control,
			definition,
			definitionInput: "diamond.yaml",
			workspace,
			cwd: workspace,
		});
		expect(session).toBeDefined();
		expect(control.calls.slice(0, 3)).toEqual(["probe", "tab:create:shortleash: herdr-diamond", "pane:list"]);
		expect(control.calls[3]).toMatch(/^pane:run:/);

		const result = await new PipelineController(definition, waves, stateTracker).run({
			workspace,
			agentRunner: session!.runAgent,
		});
		await session!.dispose();

		expect(result.status).toBe("completed");
		expect(control.calls.filter(call => call.startsWith("pane:split:")).length).toBe(5);
		expect(control.calls.filter(call => call.startsWith("agent:start:")).length).toBe(5);
		expect(control.calls.filter(call => call.startsWith("agent:prompt:")).length).toBe(5);
		expect(control.calls.filter(call => call.startsWith("pane:close:")).length).toBe(5);
		expect(control.calls.at(-1)).toBe("tab:close:w1:t1");

		const firstClose = control.calls.indexOf("pane:close:w1:p-agent-1");
		const nextWaveSplit = control.calls.indexOf("pane:split:w1:p-dashboard:w1:p-agent-2");
		expect(firstClose).toBeGreaterThan(-1);
		expect(nextWaveSplit).toBeGreaterThan(firstClose);
		for (const paneId of ["w1:p-agent-2", "w1:p-agent-3", "w1:p-agent-4"]) {
			expect(control.calls.indexOf(`pane:close:${paneId}`)).toBeLessThan(
				control.calls.indexOf("pane:split:w1:p-dashboard:w1:p-agent-5"),
			);
		}
	});

	it("returns to the in-process executor when Herdr cannot be reached", async () => {
		const control = new FakeHerdrControl();
		control.probe = async () => {
			control.calls.push("probe");
			throw new Error("server unavailable");
		};
		const session = await HerdrSwarmSession.open({
			client: control,
			definition: diamondDefinition(),
			definitionInput: "diamond.yaml",
			workspace,
			cwd: workspace,
		});
		expect(session).toBeUndefined();
		expect(control.calls).toEqual(["probe"]);
	});
});
