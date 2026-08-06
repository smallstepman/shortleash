import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StateTracker } from "../../../src/orchestration/execution/state";

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-state-test-"));
});

afterEach(async () => {
	await fs.rm(workspace, { recursive: true, force: true });
});

function result(output = "ok") {
	return {
		index: 0,
		id: "worker-result",
		agent: "worker",
		agentSource: "project" as const,
		task: "implement",
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 3,
		requests: 1,
	};
}

describe("Swarm state lifecycle", () => {
	it("serializes completed results and resumes only compatible state", async () => {
		const tracker = new StateTracker(workspace, "resume");
		await tracker.init(["worker"], 1, "sequential", {
			definitionHash: "hash-a",
			workspace,
		});
		await tracker.recordResult("worker", 0, 0, result());
		await tracker.updatePipeline({ status: "failed", nextIteration: 0 });
		await tracker.releaseRunLock();

		const resumedTracker = new StateTracker(workspace, "resume");
		await resumedTracker.acquireRunLock({ definitionHash: "hash-a", workspace });
		const init = await resumedTracker.init(["worker"], 1, "sequential", {
			definitionHash: "hash-a",
			workspace,
			resume: true,
		});
		expect(init.resumed).toBe(true);
		expect(resumedTracker.state.results.worker[0]?.result.output).toBe("ok");
		await resumedTracker.releaseRunLock();

		const incompatibleTracker = new StateTracker(workspace, "resume");
		await incompatibleTracker.acquireRunLock({ definitionHash: "hash-b", workspace });
		expect(
			incompatibleTracker.init(["worker"], 1, "sequential", {
				definitionHash: "hash-b",
				workspace,
				resume: true,
			}),
		).rejects.toThrow("definition hash changed");
		await incompatibleTracker.releaseRunLock();
	});
	it("requires an explicit restart to replace terminal persisted state", async () => {
		const tracker = new StateTracker(workspace, "restart");
		await tracker.init(["worker"], 1, "sequential", {
			definitionHash: "hash-a",
			workspace,
		});
		await tracker.recordResult("worker", 0, 0, result());
		await tracker.updatePipeline({ status: "completed", nextIteration: 1, completedAt: Date.now() });

		const repeated = new StateTracker(workspace, "restart");
		await expect(
			repeated.init(["worker"], 1, "sequential", {
				definitionHash: "hash-a",
				workspace,
			}),
		).rejects.toThrow("Use --resume to continue it or --restart to run it again");

		const restarted = new StateTracker(workspace, "restart");
		const init = await restarted.init(["worker"], 1, "sequential", {
			definitionHash: "hash-b",
			workspace,
			restart: true,
		});
		expect(init.resumed).toBe(false);
		expect(restarted.state.status).toBe("running");
		expect(restarted.state.results.worker).toEqual([]);
	});
	it("requires persisted state for resume and refuses corrupt run locks", async () => {
		const missing = new StateTracker(workspace, "missing-resume");
		await expect(
			missing.init(["worker"], 1, "sequential", {
				resume: true,
			}),
		).rejects.toThrow("no persisted state");

		const tracker = new StateTracker(workspace, "corrupt-lock");
		await tracker.init(["worker"], 1, "sequential", { definitionHash: "hash", workspace });
		await fs.writeFile(path.join(tracker.swarmDir, "run.lock"), "{not-json");

		const contender = new StateTracker(workspace, "corrupt-lock");
		await expect(
			contender.acquireRunLock({ definitionHash: "hash", workspace }, { allowStaleRecovery: true }),
		).rejects.toThrow("run lock");
	});

	it("rejects concurrent runs and recovers an explicit stale lock", async () => {
		const tracker = new StateTracker(workspace, "locking");
		await tracker.init(["worker"], 1, "sequential", { definitionHash: "hash", workspace });
		await tracker.acquireRunLock({ definitionHash: "hash", workspace });

		const competingTracker = new StateTracker(workspace, "locking");
		expect(competingTracker.acquireRunLock({ definitionHash: "hash", workspace })).rejects.toThrow("already running");
		await tracker.releaseRunLock();

		await fs.writeFile(
			path.join(tracker.swarmDir, "run.lock"),
			JSON.stringify({
				runId: "dead-run",
				pid: 999_999_999,
				startedAt: Date.now() - 1000,
				definitionHash: "hash",
				workspace,
			}),
		);
		expect(competingTracker.acquireRunLock({ definitionHash: "hash", workspace })).rejects.toThrow("stale run lock");
		await competingTracker.acquireRunLock({ definitionHash: "hash", workspace }, { allowStaleRecovery: true });
		await competingTracker.releaseRunLock();
	});

	it("surfaces corrupt state instead of treating it as missing", async () => {
		const tracker = new StateTracker(workspace, "corrupt");
		await tracker.init(["worker"], 1, "sequential");
		await fs.writeFile(path.join(tracker.swarmDir, "state", "pipeline.json"), "{not-json");
		await expect(tracker.load()).rejects.toThrow("state at");
	});
	it("normalizes malformed persisted entries without trusting broad JSON casts", async () => {
		const tracker = new StateTracker(workspace, "normalize");
		await tracker.init(["worker"], 1, "sequential");
		await fs.writeFile(
			path.join(tracker.swarmDir, "state", "pipeline.json"),
			JSON.stringify({
				...tracker.state,
				agents: {
					worker: {
						name: "worker",
						status: "running",
						iteration: "invalid",
						wave: 0,
						recentTools: [{ tool: "ignored", args: 7, endMs: "invalid" }],
					},
				},
				results: {
					worker: [
						{ iteration: "invalid", attempt: 0, result: result() },
						{ iteration: 0, attempt: 0, result: result("recovered") },
					],
				},
				policy: {
					boundary: "agent",
					accepted: true,
					failures: [],
					evaluations: [],
					updatedAt: Date.now(),
				},
				projectionHistory: [{ targetId: "bead", event: "unknown", status: "failed", updatedAt: Date.now() }],
			}),
		);

		const loaded = await tracker.load();
		expect(loaded?.agents.worker.iteration).toBe(0);
		expect(loaded?.results.worker).toHaveLength(1);
		expect(loaded?.results.worker[0]?.result.output).toBe("recovered");
		expect(loaded?.policy?.boundary).toBe("agent");
		expect(loaded?.projectionHistory).toEqual([]);
	});
});
