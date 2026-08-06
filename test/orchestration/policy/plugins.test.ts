import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSwarm } from "../../../src/orchestration/definition/schema";
import {
	discoverSwarmPluginPaths,
	loadSwarmPlugins,
	type SwarmPolicyContext,
	SwarmPolicyRegistry,
} from "../../../src/orchestration/policy/plugins";

function definitionWith(...sections: string[]): ReturnType<typeof parseSwarm> {
	const checks = sections.includes("checks") ? "  checks:\n    - fixture:passes\n" : "  checks: []\n";
	const evals = sections.includes("evals") ? "  evals:\n    - fixture:fails\n" : "  evals: []\n";
	return parseSwarm(`
swarm:
  name: policy-test
  workspace: ./workspace
${checks}${evals}
  agents:
    worker:
      role: tester
      task: run the test
`);
}

function context(definition: ReturnType<typeof parseSwarm>): SwarmPolicyContext {
	return {
		definition,
		cwd: process.cwd(),
		workspace: process.cwd(),
		swarmDir: path.join(process.cwd(), ".swarm_policy-test"),
		boundary: "complete",
		iteration: 0,
		latestResults: new Map(),
		history: new Map(),
		params: {},
		state: {
			name: definition.name,
			status: "running",
			mode: definition.mode,
			iteration: 0,
			targetCount: definition.targetCount,
			agents: {},
			startedAt: Date.now(),
		},
	};
}

describe("swarm policy plugins", () => {
	it("parses code plugin references from YAML", () => {
		const definition = parseSwarm(`
swarm:
  name: policy-test
  workspace: ./workspace
  plugins:
    - ./policies.ts
  checks:
    - fixture:passes
    - id: local-check
      plugin: local
  evals:
    - fixture:fails
  agents:
    worker:
      role: tester
      task: run the test
      checks:
        - fixture:passes
      evals: []
`);

		expect(definition.plugins).toEqual(["./policies.ts"]);
		expect(definition.checks).toEqual(["fixture:passes", { plugin: "local", id: "local-check" }]);
		expect(definition.evals).toEqual(["fixture:fails"]);
		expect(definition.agents.get("worker")?.checks).toEqual([
			"fixture:passes",
			{ plugin: "local", id: "local-check" },
			"fixture:passes",
		]);
	});

	it("loads a discovered code plugin and evaluates blocking results", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-plugin-test-"));
		try {
			const pluginPath = path.resolve(import.meta.dir, "../../fixtures/policy-plugin.ts");
			const definition = definitionWith("checks", "evals");
			const discovered = await discoverSwarmPluginPaths({
				cwd: tempDir,
				definitionDir: tempDir,
				configuredPaths: [pluginPath],
				includeInstalledPlugins: false,
			});
			expect(discovered.errors).toEqual([]);
			expect(discovered.paths).toEqual([pluginPath]);

			const loaded = await loadSwarmPlugins({
				paths: discovered.paths,
				cwd: tempDir,
				workspace: tempDir,
				definitionPath: path.join(tempDir, "workflow.yaml"),
				definition,
			});
			expect(loaded.errors).toEqual([]);
			expect(loaded.registry.validateDefinition(definition)).toEqual([]);

			const decision = await loaded.registry.evaluate(definition, context(definition));
			expect(decision.accepted).toBe(false);
			expect(decision.failures).toEqual([
				{
					source: "eval",
					id: "fixture:fails",
					message: "Fixture evaluator blocked completion.",
					findings: [{ code: "fixture-failure" }],
					evidenceRefs: ["artifact://fixture"],
				},
			]);
			expect(decision.evaluations[0]).toEqual({
				id: "fixture:fails",
				version: "1",
				outcome: "fail",
				explanation: "Fixture evaluator blocked completion.",
				findings: [{ code: "fixture-failure" }],
				evidenceRefs: ["artifact://fixture"],
			});
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("discovers project-local policy modules", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-discovery-test-"));
		try {
			const pluginDir = path.join(tempDir, ".omp", "swarm");
			await fs.mkdir(pluginDir, { recursive: true });
			const pluginPath = path.join(pluginDir, "policy.ts");
			await fs.writeFile(pluginPath, "export default {};\n");

			const discovered = await discoverSwarmPluginPaths({
				cwd: tempDir,
				includeInstalledPlugins: false,
			});
			expect(discovered.errors).toEqual([]);
			expect(discovered.paths).toEqual([pluginPath]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("runs checks at their declared boundary", async () => {
		const definition = definitionWith("checks");
		const registry = new SwarmPolicyRegistry();
		registry.register({
			name: "fixture",
			checks: [
				{
					id: "passes",
					description: "passes",
					boundary: "complete",
					check: () => false,
				},
			],
		});

		const waveDecision = await registry.evaluate(definition, { ...context(definition), boundary: "wave" });
		const completeDecision = await registry.evaluate(definition, context(definition));
		expect(waveDecision.accepted).toBe(true);
		expect(completeDecision.accepted).toBe(false);
		expect(completeDecision.failures[0]?.source).toBe("check");
	});
	it("evaluates agent-scoped policy references with the agent context", async () => {
		const definition = parseSwarm(`
swarm:
  name: scoped-policy-test
  workspace: ./workspace
  agents:
    worker:
      role: tester
      task: run the test
      checks:
        - fixture:agent-only
`);
		const registry = new SwarmPolicyRegistry();
		registry.register({
			name: "fixture",
			checks: [
				{
					id: "agent-only",
					description: "agent context is required",
					check: policyContext => policyContext.agent === "worker",
				},
			],
		});

		const agent = definition.agents.get("worker");
		expect(agent).toBeDefined();
		expect(registry.validateDefinition(definition)).toEqual([]);
		const decision = await registry.evaluate(definition, { ...context(definition), agent: "worker" }, agent!);
		expect(decision.accepted).toBe(true);
		expect(decision.failures).toEqual([]);
	});
	it("propagates typed reference params into before/after policy observations", async () => {
		const definition = parseSwarm(`
swarm:
  name: parameterized-policy-test
  workspace: ./workspace
  checks:
    - plugin: fixture
      id: parameterized
      params:
        extension: .rs
        count: 3
        enabled: true
  agents:
    worker:
      role: tester
      task: run the test
`);
		const registry = new SwarmPolicyRegistry();
		registry.register({
			name: "fixture",
			checks: [
				{
					id: "parameterized",
					description: "parameterized policy",
					boundary: "complete",
					capture: captureContext => ({ phase: captureContext.phase }),
					check: policyContext => {
						expect(policyContext.params).toEqual({
							extension: ".rs",
							count: 3,
							enabled: true,
						});
						expect(policyContext.observation).toEqual({
							before: { phase: "before" },
							after: { phase: "after" },
						});
						return true;
					},
				},
			],
		});

		const policyContext = context(definition);
		const before = await registry.capture(definition, policyContext, "before");
		const after = await registry.capture(definition, policyContext, "after");
		const observations = new Map(
			[...before.keys()].map(key => [key, { before: before.get(key), after: after.get(key) }] as const),
		);
		const decision = await registry.evaluate(definition, policyContext, definition, observations);

		expect(decision.accepted).toBe(true);
	});
});
