import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry, SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";
import { parseSwarm } from "../../../src/orchestration/definition/schema";
import { buildDependencyGraph, buildExecutionWaves } from "../../../src/orchestration/execution/dag";
import { PipelineController } from "../../../src/orchestration/execution/pipeline";
import { StateTracker } from "../../../src/orchestration/execution/state";
import { SwarmPolicyRegistry } from "../../../src/orchestration/policy/plugins";

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-pipeline-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("pipeline agent guardrails", () => {
	it("blocks a wave when an agent-scoped check fails", async () => {
		const definition = parseSwarm(`
swarm:
  name: scoped-policy-pipeline
  workspace: .
  mode: parallel
  agents:
    worker:
      role: tester
      task: run the test
      checks:
        - fixture:block
`);
		const deps = buildDependencyGraph(definition);
		const waves = buildExecutionWaves(deps);
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()], definition.targetCount, definition.mode);

		const result: SingleResult = {
			index: 0,
			id: "worker-result",
			agent: "worker",
			agentSource: "project",
			task: "run the test",
			exitCode: 0,
			output: "ok",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};
		vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(result);

		const policyRegistry = new SwarmPolicyRegistry();
		policyRegistry.register({
			name: "fixture",
			checks: [
				{
					id: "block",
					description: "agent policy blocked",
					boundary: "wave",
					check: context => context.agent !== "worker",
				},
			],
		});

		const controller = new PipelineController(definition, waves, stateTracker);
		const pipelineResult = await controller.run({
			workspace,
			modelRegistry: {} as ModelRegistry,
			policyRegistry,
		});

		expect(pipelineResult.status).toBe("failed");
		expect(pipelineResult.errors).toContain("check fixture:block: agent policy blocked");
		expect(pipelineResult.policy?.accepted).toBe(false);
	});
	it("retries an agent after a rejected finalization without spawning a new session", async () => {
		const definition = parseSwarm(`
swarm:
  name: finalization-policy-pipeline
  workspace: .
  mode: parallel
  agents:
    worker:
      role: tester
      task: run the test
      checks:
        - fixture:finalize
`);
		const deps = buildDependencyGraph(definition);
		const waves = buildExecutionWaves(deps);
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()], definition.targetCount, definition.mode);

		const initialResult: SingleResult = {
			index: 0,
			id: "worker-initial",
			agent: "worker",
			agentSource: "project",
			task: "run the test",
			exitCode: 0,
			output: "initial",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};
		const correctedResult = { ...initialResult, id: "worker-corrected", output: "corrected" };
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(initialResult);
		const followUpSpy = vi.spyOn(taskExecutor, "runSubagentFollowUpTurn").mockResolvedValue(correctedResult);

		const policyRegistry = new SwarmPolicyRegistry();
		let evaluations = 0;
		policyRegistry.register({
			name: "fixture",
			checks: [
				{
					id: "finalize",
					description: "agent output must be corrected",
					boundary: "agent",
					capture: context => ({
						phase: context.phase,
						output: context.latestResults.get("worker")?.output ?? "none",
					}),
					check: context => {
						evaluations++;
						return (
							context.observation?.after &&
							(context.observation.after as { output?: string }).output === "corrected"
						);
					},
				},
			],
		});

		const controller = new PipelineController(definition, waves, stateTracker);
		const pipelineResult = await controller.run({
			workspace,
			modelRegistry: {} as ModelRegistry,
			policyRegistry,
		});

		expect(pipelineResult.status).toBe("completed");
		expect(evaluations).toBe(2);
		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		expect(runSubprocessSpy.mock.calls[0][0].keepAlive).toBe(true);
		expect(followUpSpy).toHaveBeenCalledTimes(1);
		expect(followUpSpy.mock.calls[0][0]).toMatchObject({
			id: "swarm-finalization-policy-pipeline-worker-0",
			message: expect.stringContaining("finalization was rejected"),
		});
		expect(pipelineResult.agentResults.get("worker")).toEqual([correctedResult]);
		const restartedTracker = new StateTracker(workspace, definition.name);
		const recoveredState = await restartedTracker.load();
		const observations = Object.values(recoveredState?.policyObservations ?? {});
		expect(observations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					agent: "worker",
					iteration: 0,
					attempt: 0,
					before: { phase: "before", output: "none" },
					after: { phase: "after", output: "initial" },
				}),
				expect.objectContaining({
					agent: "worker",
					iteration: 0,
					attempt: 1,
					before: { phase: "before", output: "initial" },
					after: { phase: "after", output: "corrected" },
				}),
			]),
		);
	});
});

describe("pipeline resume", () => {
	it("reuses persisted successful results instead of spawning the completed agent", async () => {
		const definition = parseSwarm(`
swarm:
  name: resume-pipeline
  workspace: .
  mode: parallel
  agents:
    worker:
      role: tester
      task: run the test
`);
		const waves = buildExecutionWaves(buildDependencyGraph(definition));
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()], definition.targetCount, definition.mode);
		const persistedResult: SingleResult = {
			index: 0,
			id: "persisted-worker",
			agent: "worker",
			agentSource: "project",
			task: "run the test",
			exitCode: 0,
			output: "persisted",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};
		await stateTracker.recordResult("worker", 0, 0, persistedResult);
		await stateTracker.updatePipeline({ status: "failed", nextIteration: 0, completedAt: Date.now() });
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess");

		const result = await new PipelineController(definition, waves, stateTracker).run({
			workspace,
			modelRegistry: {} as ModelRegistry,
			resume: true,
		});

		expect(result.status).toBe("completed");
		expect(result.agentResults.get("worker")).toEqual([persistedResult]);
		expect(runSubprocessSpy).not.toHaveBeenCalled();
	});
});

describe("pipeline failure and cancellation semantics", () => {
	it("skips dependent waves after a failed agent by default", async () => {
		const definition = parseSwarm(`
swarm:
  name: skip-dependents
  workspace: .
  mode: parallel
  agents:
    root:
      role: worker
      task: fail
    child:
      role: worker
      task: should not run
      waits_for: [root]
`);
		const waves = buildExecutionWaves(buildDependencyGraph(definition));
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()], 1, definition.mode);
		const calls: string[] = [];
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			const agentName = options.agent.name;
			calls.push(agentName);
			return {
				index: options.index,
				id: options.id,
				agent: agentName,
				agentSource: "project" as const,
				task: options.task,
				exitCode: agentName === "root" ? 1 : 0,
				output: "",
				stderr: agentName === "root" ? "failed" : "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
				error: agentName === "root" ? "failed" : undefined,
			};
		});

		const result = await new PipelineController(definition, waves, stateTracker).run({
			workspace,
			modelRegistry: {} as ModelRegistry,
		});

		expect(result.status).toBe("failed");
		expect(calls).toEqual(["root"]);
		expect(stateTracker.state.agents.child.status).toBe("skipped");
	});

	it("continues independent and dependent waves when explicitly configured", async () => {
		const definition = parseSwarm(`
swarm:
  name: continue-failures
  workspace: .
  mode: parallel
  failure_policy: continue
  agents:
    root:
      role: worker
      task: fail
    child:
      role: worker
      task: continue
      waits_for: [root]
`);
		const waves = buildExecutionWaves(buildDependencyGraph(definition));
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()], 1, definition.mode);
		const calls: string[] = [];
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			calls.push(options.agent.name);
			return {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: "project" as const,
				task: options.task,
				exitCode: options.agent.name === "root" ? 1 : 0,
				output: "",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
				error: options.agent.name === "root" ? "failed" : undefined,
			};
		});

		const result = await new PipelineController(definition, waves, stateTracker).run({
			workspace,
			modelRegistry: {} as ModelRegistry,
		});

		expect(result.status).toBe("failed");
		expect(calls).toEqual(["root", "child"]);
		expect(stateTracker.state.agents.child.status).toBe("completed");
	});

	it("marks a mid-wave cancellation as aborted instead of completed", async () => {
		const definition = parseSwarm(`
swarm:
  name: abort
  workspace: .
  mode: parallel
  agents:
    worker:
      role: worker
      task: wait
`);
		const waves = buildExecutionWaves(buildDependencyGraph(definition));
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init(["worker"], 1, definition.mode);
		const abortController = new AbortController();
		vi.spyOn(taskExecutor, "runSubprocess").mockImplementation(async options => {
			abortController.abort();
			return {
				index: options.index,
				id: options.id,
				agent: "worker",
				agentSource: "project" as const,
				task: options.task,
				exitCode: 1,
				output: "",
				stderr: "cancelled",
				truncated: false,
				durationMs: 0,
				tokens: 0,
				requests: 0,
				aborted: true,
				error: "cancelled",
			};
		});

		const result = await new PipelineController(definition, waves, stateTracker).run({
			workspace,
			signal: abortController.signal,
			modelRegistry: {} as ModelRegistry,
		});

		expect(result.status).toBe("aborted");
		expect(stateTracker.state.status).toBe("aborted");
	});
});
it("keeps cancellation terminal when completion evaluation returns", async () => {
	const definition = parseSwarm(`
swarm:
  name: abort-during-completion
  workspace: .
  mode: parallel
  checks:
    - fixture:cancel-on-complete
  agents:
    worker:
      role: worker
      task: finish
`);
	const waves = buildExecutionWaves(buildDependencyGraph(definition));
	const stateTracker = new StateTracker(workspace, definition.name);
	await stateTracker.init(["worker"], 1, definition.mode);
	vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue({
		index: 0,
		id: "worker-result",
		agent: "worker",
		agentSource: "project",
		task: "finish",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	});

	const abortController = new AbortController();
	const policyRegistry = new SwarmPolicyRegistry();
	policyRegistry.register({
		name: "fixture",
		checks: [
			{
				id: "cancel-on-complete",
				description: "cancel after completion evaluation",
				boundary: "complete",
				check: () => {
					abortController.abort();
					return true;
				},
			},
		],
	});

	const result = await new PipelineController(definition, waves, stateTracker).run({
		workspace,
		signal: abortController.signal,
		modelRegistry: {} as ModelRegistry,
		policyRegistry,
	});

	expect(result.status).toBe("aborted");
	expect(stateTracker.state.status).toBe("aborted");
});
