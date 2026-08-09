import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";
import { type ModelRegistry, Settings, type SingleResult } from "@oh-my-pi/pi-coding-agent";
import type { StructuredSubagentResult } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import * as structuredExecutor from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { parseShortleash } from "../../../src/orchestration/definition/schema";
import { buildDependencyGraph, buildExecutionWaves } from "../../../src/orchestration/execution/dag";
import { PipelineController } from "../../../src/orchestration/execution/pipeline";
import { StateTracker } from "../../../src/orchestration/execution/state";
import { ShortleashPolicyRegistry } from "../../../src/orchestration/policy/policies";

function structuredExecution(result: SingleResult): StructuredSubagentResult {
	return {
		result,
		policy: {
			effectiveAgent: {
				name: "task",
				description: "test",
				systemPrompt: "test",
				source: "bundled",
			},
			schema: {
				schema: undefined,
				source: "none",
				mode: "permissive",
				outputSchemaOverridesAgent: false,
			},
		},
		mergeSummary: "",
		changesApplied: null,
		artifactsDir: path.join(workspace, "artifacts"),
		temporaryArtifacts: false,
	} as unknown as StructuredSubagentResult;
}

let workspace: string;
function policyPath(name: string): string {
	return path.resolve(process.cwd(), "test", "fixtures", `${name}.ts`);
}

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-pipeline-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("pipeline agent guardrails", () => {
	it("places independent agents in one initial wave", () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "independent-wave",
					workspace: ".",
					agents: {
						first: { role: "worker", task: "first" },
						second: { role: "worker", task: "second" },
					},
				},
			}),
		);
		expect(buildExecutionWaves(buildDependencyGraph(definition))).toEqual([["first", "second"]]);
	});
	it("blocks a wave when an agent-scoped check fails", async () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "scoped-policy-pipeline",
					workspace: ".",
					agents: {
						worker: {
							role: "tester",
							task: "run the test",
							checks: [policyPath("block")],
						},
					},
				},
			}),
		);
		const deps = buildDependencyGraph(definition);
		const waves = buildExecutionWaves(deps);
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()]);

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
		vi.spyOn(structuredExecutor, "runStructuredSubagent").mockResolvedValue(structuredExecution(result));

		const policyRegistry = new ShortleashPolicyRegistry();
		policyRegistry.register(policyPath("block"), {
			description: "agent policy blocked",
			boundary: "wave",
			check: context => context.agent !== "worker",
		});

		const controller = new PipelineController(definition, waves, stateTracker);
		const pipelineResult = await controller.run({
			workspace,
			modelRegistry: {} as ModelRegistry,
			policyRegistry,
		});

		expect(pipelineResult.status).toBe("failed");
		expect(pipelineResult.errors).toContain("check ./test/fixtures/block.ts: agent policy blocked");
		expect(pipelineResult.policy?.accepted).toBe(false);
	});
	it("retries an agent after a rejected finalization without spawning a new session", async () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "finalization-policy-pipeline",
					workspace: ".",
					agents: {
						worker: {
							role: "tester",
							task: "run the test",
							checks: [policyPath("finalize")],
						},
					},
				},
			}),
		);
		const deps = buildDependencyGraph(definition);
		const waves = buildExecutionWaves(deps);
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()]);

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
		const structuredSpy = vi
			.spyOn(structuredExecutor, "runStructuredSubagent")
			.mockResolvedValue(structuredExecution(initialResult));
		const followUpSpy = vi.spyOn(taskExecutor, "runSubagentFollowUpTurn").mockResolvedValue(correctedResult);

		const policyRegistry = new ShortleashPolicyRegistry();
		let evaluations = 0;
		policyRegistry.register(policyPath("finalize"), {
			description: "agent output must be corrected",
			boundary: "agent",
			capture: context => ({
				phase: context.phase,
				output: context.latestResults.get("worker")?.output ?? "none",
			}),
			check: context => {
				evaluations++;
				return (
					context.observation?.after && (context.observation.after as { output?: string }).output === "corrected"
				);
			},
		});

		const controller = new PipelineController(definition, waves, stateTracker);
		const pipelineResult = await controller.run({
			workspace,
			modelRegistry: {} as ModelRegistry,
			policyRegistry,
		});

		expect(pipelineResult.status).toBe("completed");
		expect(evaluations).toBe(2);
		expect(structuredSpy).toHaveBeenCalledTimes(1);
		expect(structuredSpy.mock.calls[0][0].keepAlive).toBe(true);
		expect(followUpSpy.mock.calls[0][0]).toMatchObject({
			id: "shortleash-finalization-policy-pipeline-worker",
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
					attempt: 0,
					before: { phase: "before", output: "none" },
					after: { phase: "after", output: "initial" },
				}),
				expect.objectContaining({
					agent: "worker",
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
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "resume-pipeline",
					workspace: ".",
					agents: {
						worker: { role: "tester", task: "run the test" },
					},
				},
			}),
		);
		const waves = buildExecutionWaves(buildDependencyGraph(definition));
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()]);
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
		await stateTracker.recordResult("worker", 0, persistedResult);
		await stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
		const structuredSpy = vi.spyOn(structuredExecutor, "runStructuredSubagent");

		const result = await new PipelineController(definition, waves, stateTracker).run({
			workspace,
			modelRegistry: {} as ModelRegistry,
			resume: true,
		});

		expect(result.status).toBe("completed");
		expect(result.agentResults.get("worker")).toEqual([persistedResult]);
		expect(structuredSpy).not.toHaveBeenCalled();
	});
});

describe("pipeline failure and cancellation semantics", () => {
	it("uses the host task concurrency setting for a ready wave", async () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "host-concurrency",
					workspace: ".",
					agents: {
						first: { role: "worker", task: "first" },
						second: { role: "worker", task: "second" },
						third: { role: "worker", task: "third" },
					},
				},
			}),
		);
		const waves = buildExecutionWaves(buildDependencyGraph(definition));
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()]);
		let active = 0;
		let peak = 0;
		let startedCount = 0;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(structuredExecutor, "runStructuredSubagent").mockImplementation(async request => {
			active += 1;
			peak = Math.max(peak, active);
			startedCount += 1;
			if (startedCount === 1) started.resolve();
			await release.promise;
			active -= 1;
			return structuredExecution({
				index: request.index ?? 0,
				id: request.identity?.id ?? "worker",
				agent: request.identity?.label ?? "task",
				agentSource: "project",
				task: request.assignment,
				exitCode: 0,
				output: "",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			});
		});

		const run = new PipelineController(definition, waves, stateTracker).run({
			workspace,
			modelRegistry: {} as ModelRegistry,
			settings: Settings.isolated({ "task.maxConcurrency": 1 }),
		});
		await started.promise;
		expect(peak).toBe(1);
		release.resolve();
		const result = await run;

		expect(result.status).toBe("completed");
		expect(peak).toBe(1);
	});
	it("skips dependent waves after a failed agent by default", async () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "skip-dependents",
					workspace: ".",
					agents: {
						root: { role: "worker", task: "fail" },
						child: { role: "worker", task: "should not run", waits_for: ["root"] },
					},
				},
			}),
		);
		const waves = buildExecutionWaves(buildDependencyGraph(definition));
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()]);
		const calls: string[] = [];
		vi.spyOn(structuredExecutor, "runStructuredSubagent").mockImplementation(async request => {
			const agentName = request.identity?.label ?? "task";
			calls.push(agentName);
			return structuredExecution({
				index: request.index ?? 0,
				id: request.identity?.id ?? agentName,
				agent: agentName,
				agentSource: "project",
				task: request.assignment,
				exitCode: agentName === "root" ? 1 : 0,
				output: "",
				stderr: agentName === "root" ? "failed" : "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
				error: agentName === "root" ? "failed" : undefined,
			});
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
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "continue-failures",
					workspace: ".",
					failure_policy: "continue",
					agents: {
						root: { role: "worker", task: "fail" },
						child: { role: "worker", task: "continue", waits_for: ["root"] },
					},
				},
			}),
		);
		const waves = buildExecutionWaves(buildDependencyGraph(definition));
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init([...definition.agents.keys()]);
		const calls: string[] = [];
		vi.spyOn(structuredExecutor, "runStructuredSubagent").mockImplementation(async request => {
			const agentName = request.identity?.label ?? "task";
			calls.push(agentName);
			return structuredExecution({
				index: request.index ?? 0,
				id: request.identity?.id ?? agentName,
				agent: agentName,
				agentSource: "project",
				task: request.assignment,
				exitCode: agentName === "root" ? 1 : 0,
				output: "",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
				error: agentName === "root" ? "failed" : undefined,
			});
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
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "abort",
					workspace: ".",
					agents: {
						worker: { role: "worker", task: "wait" },
					},
				},
			}),
		);
		const abortController = new AbortController();
		const waves = buildExecutionWaves(buildDependencyGraph(definition));
		const stateTracker = new StateTracker(workspace, definition.name);
		await stateTracker.init(["worker"]);
		vi.spyOn(structuredExecutor, "runStructuredSubagent").mockImplementation(async request => {
			abortController.abort();
			return structuredExecution({
				index: request.index ?? 0,
				id: request.identity?.id ?? "worker",
				agent: request.identity?.label ?? "worker",
				agentSource: "project",
				task: request.assignment,
				exitCode: 1,
				output: "",
				stderr: "cancelled",
				truncated: false,
				durationMs: 0,
				tokens: 0,
				requests: 0,
				aborted: true,
				error: "cancelled",
			});
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
	const definition = parseShortleash(
		JSON.stringify({
			swarm: {
				name: "abort-during-completion",
				workspace: ".",
				checks: [policyPath("cancel-on-complete")],
				agents: {
					worker: { role: "worker", task: "finish" },
				},
			},
		}),
	);
	const waves = buildExecutionWaves(buildDependencyGraph(definition));
	const stateTracker = new StateTracker(workspace, definition.name);
	await stateTracker.init(["worker"]);
	vi.spyOn(structuredExecutor, "runStructuredSubagent").mockResolvedValue(
		structuredExecution({
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
		}),
	);

	const abortController = new AbortController();
	const policyRegistry = new ShortleashPolicyRegistry();
	policyRegistry.register(policyPath("cancel-on-complete"), {
		description: "cancel after completion evaluation",
		boundary: "complete",
		check: () => {
			abortController.abort();
			return true;
		},
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
