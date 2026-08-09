import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveShortleashPlan } from "../../../src/orchestration/definition/plan";
import { parseShortleash } from "../../../src/orchestration/definition/schema";
import {
	loadShortleashPolicyModules,
	type ShortleashPolicyContext,
	ShortleashPolicyRegistry,
} from "../../../src/orchestration/policy/policies";

const CHECK_PATH = path.resolve(import.meta.dir, "../../fixtures/check-passes.ts");
const EVAL_PATH = path.resolve(import.meta.dir, "../../fixtures/eval-fails.ts");

function policyPath(name: string): string {
	return path.resolve(process.cwd(), "test", "fixtures", `${name}.ts`);
}

function definitionWith(...sections: string[]): ReturnType<typeof parseShortleash> {
	return parseShortleash(
		JSON.stringify({
			swarm: {
				name: "policy-test",
				workspace: "./workspace",
				checks: sections.includes("checks") ? [CHECK_PATH] : [],
				evals: sections.includes("evals") ? [EVAL_PATH] : [],
				agents: {
					worker: { role: "tester", task: "run the test" },
				},
			},
		}),
	);
}

function context(definition: ReturnType<typeof parseShortleash>): ShortleashPolicyContext {
	return {
		definition,
		cwd: process.cwd(),
		workspace: process.cwd(),
		shortleashDir: path.join(process.cwd(), ".shortleash_policy-test"),
		boundary: "complete",
		latestResults: new Map(),
		history: new Map(),
		params: {},
		state: {
			version: 4,
			name: definition.name,
			definitionHash: "test",
			workspace: process.cwd(),
			status: "running",
			currentWave: 0,
			agents: {},
			results: {},
			policyHistory: [],
			policyObservations: {},
			projectionHistory: [],
			startedAt: Date.now(),
		},
	};
}

describe("Shortleash policy modules", () => {
	it("parses direct module paths and object parameters", () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "policy-test",
					workspace: "./workspace",
					checks: [CHECK_PATH, { path: CHECK_PATH, params: { count: 3, strict: true } }],
					evals: [EVAL_PATH],
				},
			}),
		);

		expect(definition.checks).toEqual([CHECK_PATH, { path: CHECK_PATH, params: { count: 3, strict: true } }]);
		expect(definition.evals).toEqual([EVAL_PATH]);
	});

	it("loads the referenced TypeScript modules and evaluates blocking results", async () => {
		const definition = definitionWith("checks", "evals");
		const loaded = await loadShortleashPolicyModules({
			paths: [CHECK_PATH, EVAL_PATH],
			definitionDir: path.dirname(CHECK_PATH),
		});

		expect(loaded.errors).toEqual([]);
		expect(loaded.registry.validateDefinition(definition)).toEqual([]);

		const decision = await loaded.registry.evaluate(definition, context(definition));
		expect(decision.accepted).toBe(false);
		expect(decision.failures).toEqual([
			{
				source: "eval",
				id: "./eval-fails.ts",
				message: "Fixture evaluator blocked completion.",
				findings: [{ code: "fixture-failure" }],
				evidenceRefs: ["artifact://fixture"],
			},
		]);
		expect(decision.evaluations[0]).toEqual({
			id: "./eval-fails.ts",
			version: "1",
			outcome: "fail",
			explanation: "Fixture evaluator blocked completion.",
			findings: [{ code: "fixture-failure" }],
			evidenceRefs: ["artifact://fixture"],
		});
	});

	it("loads only explicitly referenced modules and reports an invalid module shape", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-policy-module-test-"));
		try {
			const invalidPath = path.join(tempDir, "invalid.ts");
			await fs.writeFile(invalidPath, "export default {} as const;\n");
			const definition = parseShortleash(
				JSON.stringify({
					swarm: { name: "invalid-module", workspace: ".", checks: [invalidPath] },
				}),
			);
			const loaded = await loadShortleashPolicyModules({ paths: [invalidPath], definitionDir: tempDir });
			expect(loaded.errors).toEqual([expect.stringContaining("Module must default-export a Shortleash check")]);
			expect(loaded.registry.validateDefinition(definition)).toEqual([
				expect.stringContaining("Unknown Shortleash check module"),
			]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("runs checks at their declared boundary", async () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: { name: "boundary-test", workspace: ".", checks: [policyPath("boundary")] },
			}),
		);
		const registry = new ShortleashPolicyRegistry();
		registry.register(policyPath("boundary"), {
			description: "passes",
			boundary: "complete",
			check: () => false,
		});

		const waveDecision = await registry.evaluate(definition, { ...context(definition), boundary: "wave" });
		const completeDecision = await registry.evaluate(definition, context(definition));
		expect(waveDecision.accepted).toBe(true);
		expect(completeDecision.accepted).toBe(false);
		expect(completeDecision.failures[0]?.source).toBe("check");
	});

	it("evaluates agent-scoped module references with the agent context", async () => {
		const modulePath = policyPath("agent-only");
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "scoped-policy-test",
					workspace: ".",
					agents: {
						worker: { role: "tester", task: "run the test", checks: [modulePath] },
					},
				},
			}),
		);
		const registry = new ShortleashPolicyRegistry();
		registry.register(modulePath, {
			description: "agent context is required",
			check: policyContext => policyContext.agent === "worker",
		});

		const agent = definition.agents.get("worker");
		expect(agent).toBeDefined();
		expect(registry.validateDefinition(definition)).toEqual([]);
		const decision = await registry.evaluate(definition, { ...context(definition), agent: "worker" }, agent!);
		expect(decision.accepted).toBe(true);
		expect(decision.failures).toEqual([]);
	});

	it("propagates typed reference params into before/after policy observations", async () => {
		const modulePath = policyPath("parameterized");
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "parameterized-policy-test",
					workspace: ".",
					checks: [{ path: modulePath, params: { extension: ".rs", count: 3, enabled: true } }],
				},
			}),
		);
		const registry = new ShortleashPolicyRegistry();
		registry.register(modulePath, {
			description: "parameterized policy",
			boundary: "complete",
			capture: captureContext => ({ phase: captureContext.phase }),
			check: policyContext => {
				expect(policyContext.params).toEqual({ extension: ".rs", count: 3, enabled: true });
				expect(policyContext.observation).toEqual({ before: { phase: "before" }, after: { phase: "after" } });
				return true;
			},
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
	it("resolves relative policy module paths from the definition file", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-plan-policy-test-"));
		try {
			const modulePath = path.join(tempDir, "checks.ts");
			const definitionPath = path.join(tempDir, "workflow.json");
			await fs.writeFile(
				modulePath,
				'export default { description: "relative path check", boundary: "complete", check: () => true };\n',
			);
			await fs.writeFile(
				definitionPath,
				JSON.stringify({
					swarm: {
						name: "relative-policy",
						workspace: ".",
						checks: [{ path: "./checks.ts", params: { strict: true } }],
					},
				}),
			);

			const plan = await resolveShortleashPlan(definitionPath, tempDir);
			expect(plan.policyPaths).toEqual([modulePath]);
			expect(plan.policyRegistry.validateDefinition(plan.definition)).toEqual([]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
