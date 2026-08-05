import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry, SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";
import { buildDirectSwarmPrompt, executeDirectSwarm, executeSwarmAgent } from "../../src/swarm/executor";
import { parseSwarm } from "../../src/swarm/schema";
import { StateTracker } from "../../src/swarm/state";

const mockResult = {
	index: 0,
	id: "test-agent-0",
	agent: "test",
	agentSource: "project",
	task: "test task",
	exitCode: 0,
	output: "ok",
	stderr: "",
	truncated: false,
	durationMs: 100,
	tokens: 0,
} as SingleResult;

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("executeSwarmAgent", () => {
	it("does not pass authStorage to runSubprocess when modelRegistry is provided", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(mockResult);

		const mockModelRegistry = {
			authStorage: { discover: vi.fn() },
		} as unknown as ModelRegistry;

		const stateTracker = new StateTracker(workspace, "test-swarm");
		await stateTracker.init(["test-agent"], 1, "parallel");

		const agent = {
			name: "test-agent",
			role: "tester",
			task: "do something",
			reportsTo: [],
			waitsFor: [],
			checks: [],
			evals: [],
		};

		await executeSwarmAgent(agent, 0, {
			workspace,
			swarmName: "test-swarm",
			iteration: 0,
			modelRegistry: mockModelRegistry,
			stateTracker,
		});

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		const passedOptions = runSubprocessSpy.mock.calls[0][0];
		const { authStorage, modelRegistry } = passedOptions;
		expect(authStorage).toBeUndefined();
		expect(modelRegistry).toBe(mockModelRegistry);
		expect(passedOptions.keepAlive).toBe(true);
	});

	it("continues a rejected finalization in the same keep-alive session", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(mockResult);
		const followUpResult = { ...mockResult, id: "test-agent-follow-up", output: "fixed" } as SingleResult;
		const followUpSpy = vi.spyOn(taskExecutor, "runSubagentFollowUpTurn").mockResolvedValue(followUpResult);
		const onFinalize = vi.fn().mockResolvedValueOnce("Fix the failed policy.").mockResolvedValueOnce(undefined);

		const stateTracker = new StateTracker(workspace, "test-swarm");
		await stateTracker.init(["test-agent"], 1, "parallel");

		const agent = {
			name: "test-agent",
			role: "tester",
			task: "do something",
			reportsTo: [],
			waitsFor: [],
			checks: [],
			evals: [],
		};

		const result = await executeSwarmAgent(agent, 0, {
			workspace,
			swarmName: "test-swarm",
			iteration: 0,
			stateTracker,
			onFinalize,
		});

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		expect(runSubprocessSpy.mock.calls[0][0].keepAlive).toBe(true);
		expect(onFinalize).toHaveBeenCalledTimes(2);
		expect(followUpSpy).toHaveBeenCalledTimes(1);
		expect(followUpSpy.mock.calls[0][0]).toMatchObject({
			id: "swarm-test-swarm-test-agent-0",
			message: "Fix the failed policy.",
		});
		expect(result).toBe(followUpResult);
	});

	it("fails instead of finalizing when corrective attempts remain rejected", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(mockResult);
		const followUpSpy = vi.spyOn(taskExecutor, "runSubagentFollowUpTurn").mockResolvedValue(mockResult);
		const stateTracker = new StateTracker(workspace, "test-swarm");
		await stateTracker.init(["test-agent"], 1, "parallel");

		const agent = {
			name: "test-agent",
			role: "tester",
			task: "do something",
			reportsTo: [],
			waitsFor: [],
			checks: [],
			evals: [],
		};

		await expect(
			executeSwarmAgent(agent, 0, {
				workspace,
				swarmName: "test-swarm",
				iteration: 0,
				stateTracker,
				maxFinalizeAttempts: 1,
				onFinalize: async () => "Still rejected.",
			}),
		).rejects.toThrow("after 1 corrective attempts");
		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		expect(followUpSpy).toHaveBeenCalledTimes(1);
	});

	it("materializes parent history into the spawned session", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(mockResult);
		const stateTracker = new StateTracker(workspace, "test-swarm");
		await stateTracker.init(["test-agent"], 1, "parallel");

		const agent = {
			name: "test-agent",
			role: "tester",
			task: "do something",
			reportsTo: [],
			waitsFor: [],
			checks: [],
			evals: [],
		};
		const parentMessage = {
			role: "user",
			content: [{ type: "text", text: "parent context" }],
			timestamp: Date.now(),
		} as AgentMessage;

		await executeSwarmAgent(agent, 0, {
			workspace,
			swarmName: "test-swarm",
			iteration: 0,
			stateTracker,
			inheritHistory: true,
			parentMessages: [parentMessage],
		});

		const passedOptions = runSubprocessSpy.mock.calls[0][0];
		expect(passedOptions.sessionFile).toBeString();
		const sessionText = await fs.readFile(passedOptions.sessionFile!, "utf8");
		expect(sessionText).toContain("parent context");
	});
});

describe("direct current-session execution", () => {
	it("sends a no-agent definition through the host session instead of spawning a worker", () => {
		const definition = parseSwarm(`
swarm:
  name: direct-execution
  workspace: .
  task: Inspect the current workspace and report findings.
  checks:
    - fixture:architecture
`);
		const sendUserMessage = vi.fn();

		executeDirectSwarm(definition, { sendUserMessage });

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage.mock.calls[0][0]).toContain("Inspect the current workspace and report findings.");
		expect(sendUserMessage.mock.calls[0][0]).toContain("current OMP session");
		expect(sendUserMessage.mock.calls[0][0]).toContain("check:fixture:architecture");
	});

	it("rejects direct execution when agents are declared", () => {
		const definition = parseSwarm(`
swarm:
  name: delegated-execution
  workspace: .
  agents:
    worker:
      role: engineer
      task: implement
`);

		expect(() => executeDirectSwarm(definition, { sendUserMessage: vi.fn() })).toThrow(
			"requires a definition without agents",
		);
		expect(buildDirectSwarmPrompt(definition)).toContain("current OMP session");
	});
});
