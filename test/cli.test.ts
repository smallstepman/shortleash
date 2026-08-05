import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StateTracker } from "../src/swarm/state";

const cliPath = path.resolve(import.meta.dir, "../src/cli.ts");

describe("Shortleash CLI", () => {
	it("renders a completed dashboard from a child Bun process", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-cli-test-"));
		try {
			const definitionPath = path.join(workspace, "swarm.yaml");
			await fs.writeFile(
				definitionPath,
				`swarm:\n  name: cli-dashboard\n  workspace: ${workspace}\n  mode: sequential\n  agents:\n    worker:\n      role: tester\n      task: report completion\n`,
			);
			const stateTracker = new StateTracker(workspace, "cli-dashboard");
			await stateTracker.init(["worker"], 1, "sequential");
			await stateTracker.updatePipeline({ status: "completed", completedAt: Date.now() });

			const child = Bun.spawn([process.execPath, cliPath, "dashboard", definitionPath], {
				cwd: workspace,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);

			expect(exitCode, stderr).toBe(0);
			expect(stderr).toBe("");
			expect(stdout).toContain("Swarm cli-dashboard");
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	}, 30_000);
});
