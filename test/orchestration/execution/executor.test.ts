import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry, SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";
import type { StructuredSubagentResult } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import * as structuredExecutor from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { parseShortleash } from "../../../src/orchestration/definition/schema";
import {
	buildDirectShortleashPrompt,
	executeDirectShortleash,
	executeShortleashAgent,
} from "../../../src/orchestration/execution/executor";
import { StateTracker } from "../../../src/orchestration/execution/state";

const mockResult = {
	index: 0,
	id: "test-agent-0",
	agent: "test-agent",
	agentSource: "project",
	task: "test task",
	exitCode: 0,
	output: "ok",
	stderr: "",
	truncated: false,
	durationMs: 100,
	tokens: 0,
} as SingleResult;

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

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("executeShortleashAgent", () => {
	it("builds an OMP structured task with the resolved worker session", async () => {
		const structuredSpy = vi
			.spyOn(structuredExecutor, "runStructuredSubagent")
			.mockResolvedValue(structuredExecution(mockResult));

		const mockModelRegistry = {
			authStorage: { discover: vi.fn() },
		} as unknown as ModelRegistry;

		const stateTracker = new StateTracker(workspace, "test-shortleash");
		await stateTracker.init(["test-agent"]);

		const agent = {
			name: "test-agent",
			role: "tester",
			task: "do something",
			reportsTo: [],
			waitsFor: [],
			checks: [],
			evals: [],
		};

		await executeShortleashAgent(agent, 0, {
			workspace,
			shortleashName: "test-shortleash",
			modelRegistry: mockModelRegistry,
			stateTracker,
		});

		expect(structuredSpy).toHaveBeenCalledTimes(1);
		const request = structuredSpy.mock.calls[0][0];
		expect(request).toMatchObject({
			invocationKind: "task",
			assignment: "do something",
			keepAlive: true,
			enableLsp: false,
			enableIrc: false,
		});
		expect(request.agent).toBeUndefined();
		expect(request.session.modelRegistry).toBe(mockModelRegistry);
		expect(request.session.settings).toBeDefined();
		expect(request.session.getSessionFile()).toBeString();
	});

	it("continues a rejected finalization in the same keep-alive session", async () => {
		const structuredSpy = vi
			.spyOn(structuredExecutor, "runStructuredSubagent")
			.mockResolvedValue(structuredExecution(mockResult));
		const followUpResult = { ...mockResult, id: "test-agent-follow-up", output: "fixed" } as SingleResult;
		const followUpSpy = vi.spyOn(taskExecutor, "runSubagentFollowUpTurn").mockResolvedValue(followUpResult);
		const onFinalize = vi.fn().mockResolvedValueOnce("Fix the failed policy.").mockResolvedValueOnce(undefined);

		const stateTracker = new StateTracker(workspace, "test-shortleash");
		await stateTracker.init(["test-agent"]);

		const agent = {
			name: "test-agent",
			role: "tester",
			task: "do something",
			reportsTo: [],
			waitsFor: [],
			checks: [],
			evals: [],
		};

		const result = await executeShortleashAgent(agent, 0, {
			workspace,
			shortleashName: "test-shortleash",
			stateTracker,
			onFinalize,
		});

		expect(structuredSpy).toHaveBeenCalledTimes(1);
		expect(onFinalize).toHaveBeenCalledTimes(2);
		expect(followUpSpy).toHaveBeenCalledTimes(1);
		expect(followUpSpy.mock.calls[0][0]).toMatchObject({
			id: "shortleash-test-shortleash-test-agent",
			message: "Fix the failed policy.",
			agent: { name: "task" },
		});
		expect(result).toBe(followUpResult);
	});
	it("reopens the same child journal for corrective worktree turns", async () => {
		const correctedResult = { ...mockResult, id: "test-agent-retry", output: "fixed" } as SingleResult;
		const structuredSpy = vi
			.spyOn(structuredExecutor, "runStructuredSubagent")
			.mockResolvedValueOnce(structuredExecution(mockResult))
			.mockResolvedValueOnce(structuredExecution(correctedResult));
		const followUpSpy = vi.spyOn(taskExecutor, "runSubagentFollowUpTurn");
		const onFinalize = vi.fn().mockResolvedValueOnce("Fix the failed policy.").mockResolvedValueOnce(undefined);
		const stateTracker = new StateTracker(workspace, "test-shortleash");
		await stateTracker.init(["test-agent"]);

		const agent = {
			name: "test-agent",
			role: "tester",
			task: "do something",
			reportsTo: [],
			waitsFor: [],
			checks: [],
			evals: [],
		};

		const result = await executeShortleashAgent(agent, 0, {
			workspace,
			shortleashName: "test-shortleash",
			stateTracker,
			workspaceIsolation: "worktree",
			onFinalize,
		});

		expect(result).toBe(correctedResult);
		expect(structuredSpy).toHaveBeenCalledTimes(2);
		expect(structuredSpy.mock.calls[1][0]).toMatchObject({
			assignment: "Fix the failed policy.",
			identity: { id: "shortleash-test-shortleash-test-agent-retry-1" },
			keepAlive: false,
			isolation: { requested: true, merge: "patch", apply: true },
		});
		expect(structuredSpy.mock.calls[1][0].session.getSessionFile()).toBe(
			structuredSpy.mock.calls[0][0].session.getSessionFile(),
		);
		expect(followUpSpy).not.toHaveBeenCalled();
	});

	it("fails instead of finalizing when corrective attempts remain rejected", async () => {
		const structuredSpy = vi
			.spyOn(structuredExecutor, "runStructuredSubagent")
			.mockResolvedValue(structuredExecution(mockResult));
		const followUpSpy = vi.spyOn(taskExecutor, "runSubagentFollowUpTurn").mockResolvedValue(mockResult);
		const stateTracker = new StateTracker(workspace, "test-shortleash");
		await stateTracker.init(["test-agent"]);

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
			executeShortleashAgent(agent, 0, {
				workspace,
				shortleashName: "test-shortleash",
				stateTracker,
				maxFinalizeAttempts: 1,
				onFinalize: async () => "Still rejected.",
			}),
		).rejects.toThrow("after 1 corrective attempts");
		expect(structuredSpy).toHaveBeenCalledTimes(1);
		expect(followUpSpy).toHaveBeenCalledTimes(1);
	});

	it("materializes parent history into the structured child session", async () => {
		const structuredSpy = vi
			.spyOn(structuredExecutor, "runStructuredSubagent")
			.mockResolvedValue(structuredExecution(mockResult));
		const stateTracker = new StateTracker(workspace, "test-shortleash");
		await stateTracker.init(["test-agent"]);

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

		await executeShortleashAgent(agent, 0, {
			workspace,
			shortleashName: "test-shortleash",
			stateTracker,
			inheritHistory: true,
			parentMessages: [parentMessage],
		});

		const sessionFile = structuredSpy.mock.calls[0][0].session.getSessionFile();
		expect(sessionFile).toBeString();
		const sessionText = await fs.readFile(sessionFile!, "utf8");
		expect(sessionText).toContain("parent context");
	});
});

describe("direct current-session execution", () => {
	it("sends a no-agent definition through the host session instead of spawning a worker", () => {
		const definition = parseShortleash(
			JSON.stringify({
				shortleash: {
					name: "direct-execution",
					workspace: ".",
					task: "Inspect the current workspace and report findings.",
					checks: ["./checks/architecture.ts"],
				},
			}),
		);
		const sendUserMessage = vi.fn();

		executeDirectShortleash(definition, { sendUserMessage });

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage.mock.calls[0][0]).toContain("Inspect the current workspace and report findings.");
		expect(sendUserMessage.mock.calls[0][0]).toContain("current OMP session");
		expect(sendUserMessage.mock.calls[0][0]).toContain("check:./checks/architecture.ts");
	});

	it("rejects direct execution when agents are declared", () => {
		const definition = parseShortleash(
			JSON.stringify({
				shortleash: {
					name: "delegated-execution",
					workspace: ".",
					agents: {
						worker: { role: "engineer", task: "implement" },
					},
				},
			}),
		);

		expect(() => executeDirectShortleash(definition, { sendUserMessage: vi.fn() })).toThrow(
			"requires a definition without agents",
		);
		expect(buildDirectShortleashPrompt(definition)).toContain("current OMP session");
	});
});
