import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	compileShortleashToGasCity,
	parseGasCityJson,
	runGasCityCommand,
	runGasCityJson,
} from "../../../src/orchestration/adapters/gascity";
import {
	type GasCityPolicyBridgeConfig,
	runGasCityPolicyCheck,
} from "../../../src/orchestration/adapters/gascity-check";
import type { ShortleashPlan } from "../../../src/orchestration/definition/plan";
import {
	parseShortleash,
	type ShortleashDefinition,
	serializeShortleashDefinition,
} from "../../../src/orchestration/definition/schema";

function makePlan(definition: ShortleashDefinition, root: string, beadId?: string): ShortleashPlan {
	return {
		input: beadId ? `issue://${beadId}` : path.join(root, "definition.json"),
		source: {
			definition,
			definitionPath: beadId ? `issue://${beadId}` : path.join(root, "definition.json"),
			definitionDir: root,
			beadId,
		},
		definition,
		definitionDir: root,
		definitionPath: beadId ? `issue://${beadId}` : path.join(root, "definition.json"),
		workspace: root,
		waves: [],
		policyPaths: [],
		policyErrors: [],
		policyRegistry: undefined as never,
	};
}

function gasCityRunner(root: string, formula: (content: string) => void, route?: (args: readonly string[]) => void) {
	return async (args: readonly string[]): Promise<string> => {
		if (args[0] === "formula" && args[1] === "list") {
			return JSON.stringify({ ok: true, city_path: root, formulas: [] });
		}
		if (args[0] === "formula" && args[1] === "cook") {
			const files = await fs.readdir(path.join(root, "formulas"));
			const formulaFile = files.find(file => file.startsWith("shortleash-") && file.endsWith(".toml"));
			if (!formulaFile) throw new Error("generated formula was not present during cook");
			formula(await fs.readFile(path.join(root, "formulas", formulaFile), "utf8"));
			return JSON.stringify({ ok: true, root_id: "gc-root", created: 8 });
		}
		if (args[0] === "sling") {
			route?.(args);
			return JSON.stringify({ ok: true, routed: true });
		}
		throw new Error(`unexpected gc args: ${args.join(" ")}`);
	};
}

describe("Gas City Shortleash adapter", () => {
	it("compiles dependency edges, checks, metadata, and a completion gate", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-gascity-test-"));
		let formulaText = "";
		const checkPath = path.resolve("test/fixtures/check-passes.ts");
		const definition = parseShortleash(
			JSON.stringify({
				shortleash: {
					name: "guarded-feature",
					workspace: ".",
					checks: [checkPath],
					agents: {
						planner: { role: "planner", task: "Write the plan." },
						implementer: { role: "engineer", task: "Implement the plan.", waits_for: ["planner"] },
					},
				},
			}),
		);
		const plan = makePlan(definition, root);
		plan.policyPaths = [checkPath];
		const result = await compileShortleashToGasCity(plan, {
			cwd: root,
			run: gasCityRunner(root, content => {
				formulaText = content;
			}),
		});

		expect(result.rootId).toBe("gc-root");
		expect(result.created).toBe(8);
		expect(formulaText).toContain('formula = "shortleash-guarded-feature-');
		expect(formulaText).toContain('id = "agent-0-planner"');
		expect(formulaText).toContain('id = "agent-1-implementer"');
		expect(formulaText).toContain('needs = ["agent-0-planner"]');
		expect(formulaText).toContain('id = "completion-policy"');
		expect(formulaText).toContain("max_attempts = 4");
		expect(formulaText).toContain('path = ".omp/shortleash/gascity/');
		expect(formulaText).toContain("shortleash_policy_bundle_hash");
		expect(formulaText).toContain("shortleash_definition_hash");
		expect(await fs.readdir(path.join(root, "formulas"))).toEqual([]);
		expect(await fs.stat(result.runtimePath).then(() => true)).toBe(true);
	});
	it("routes a cooked workflow and repairs an unrouted persisted workflow on resume", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-gascity-route-"));
		const definition = parseShortleash(
			JSON.stringify({
				shortleash: {
					name: "route-flow",
					workspace: ".",
					agents: { worker: { role: "worker", task: "Implement the task." } },
				},
			}),
		);
		const plan = makePlan(definition, root);
		const routed: string[][] = [];
		let cooks = 0;
		const run = async (args: readonly string[]): Promise<string> => {
			if (args[0] === "formula" && args[1] === "cook") cooks += 1;
			return gasCityRunner(
				root,
				() => {},
				args => routed.push([...args]),
			)(args);
		};

		const first = await compileShortleashToGasCity(plan, { cwd: root, run });
		expect(first.routedTo).toBeUndefined();
		const resumed = await compileShortleashToGasCity(plan, {
			cwd: root,
			resume: true,
			routeTarget: "omp",
			run,
		});

		expect(resumed.rootId).toBe(first.rootId);
		expect(resumed.routedTo).toBe("omp");
		expect(routed).toEqual([["sling", "omp", "gc-root", "--no-formula", "--json"]]);
		expect(cooks).toBe(1);
		expect(JSON.parse(await fs.readFile(path.join(first.runtimePath, "workflow.json"), "utf8")).routedTo).toBe("omp");
	});

	it("resumes a routed workflow without cooking duplicate beads", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-gascity-resume-"));
		const definition = parseShortleash(
			JSON.stringify({
				shortleash: {
					name: "resume-flow",
					workspace: ".",
					agents: { worker: { role: "worker", task: "Implement the task." } },
				},
			}),
		);
		const plan = makePlan(definition, root);
		let cooks = 0;
		const run = async (args: readonly string[]): Promise<string> => {
			if (args[0] === "formula" && args[1] === "cook") cooks += 1;
			return gasCityRunner(root, () => {})(args);
		};
		const first = await compileShortleashToGasCity(plan, { cwd: root, routeTarget: "omp", run });
		const resumed = await compileShortleashToGasCity(plan, { cwd: root, resume: true, routeTarget: "omp", run });

		expect(resumed.rootId).toBe(first.rootId);
		expect(resumed.routedTo).toBe("omp");
		expect(cooks).toBe(1);
	});

	it("creates an epic bridge bead and attaches the cooked workflow", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-gascity-epic-"));
		const definition = parseShortleash(
			JSON.stringify({
				shortleash: {
					name: "epic-flow",
					workspace: ".",
					agents: { worker: { role: "worker", task: "Implement the task." } },
				},
			}),
		);
		const beadsCalls: string[][] = [];
		const beadsRun = async (args: readonly string[]): Promise<string> => {
			beadsCalls.push([...args]);
			if (args[0] === "show") {
				return JSON.stringify({ data: [{ id: "epic-1", issue_type: "epic", status: "open" }] });
			}
			if (args[0] === "list") return JSON.stringify({ data: [] });
			if (args[0] === "create") {
				return JSON.stringify({
					data: [
						{
							id: "bridge-1",
							title: "Run Shortleash 'epic-flow' in Gas City",
							status: "open",
							metadata: {},
						},
					],
				});
			}
			throw new Error(`unexpected bd args: ${args.join(" ")}`);
		};
		const result = await compileShortleashToGasCity(makePlan(definition, root, "epic-1"), {
			cwd: root,
			beadsRun,
			run: gasCityRunner(root, content => {
				expect(content).toContain('id = "agent-0-worker"');
			}),
		});

		expect(result.attachBeadId).toBe("bridge-1");
		expect(result.bridgeBeadId).toBe("bridge-1");
		expect(beadsCalls.some(args => args[0] === "create" && args.some(arg => arg.startsWith("--parent=epic-1")))).toBe(
			true,
		);
	});
	it("passes the requested working directory to the Gas City child process", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-gascity-cwd-"));
		const bin = path.join(root, "bin");
		await fs.mkdir(bin, { recursive: true });
		const fakeGc = path.join(bin, "gc");
		await fs.writeFile(fakeGc, '#!/bin/sh\nprintf "%s\\n" "$PWD"\nprintf "%s\\n" "$BD_JSON_ENVELOPE"\n', {
			encoding: "utf8",
			mode: 0o755,
		});
		await fs.chmod(fakeGc, 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		try {
			expect((await runGasCityCommand(["probe"], root)).trim().split("\n")).toEqual([root, "0"]);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});
	it("runs the trusted JS policy bridge and persists decision artifacts", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-gascity-bridge-"));
		const modulePath = path.resolve("test/fixtures/check-passes.ts");
		const definition = parseShortleash(JSON.stringify({ shortleash: { name: "bridge-check", workspace: "." } }));
		const config: GasCityPolicyBridgeConfig = {
			schemaVersion: 1,
			key: "complete",
			boundary: "complete",
			definition: serializeShortleashDefinition(definition),
			definitionDir: process.cwd(),
			definitionHash: "definition-hash",
			cwd: root,
			workspace: root,
			shortleashDir: path.join(root, ".shortleash_bridge-check"),
			policyModules: [
				{
					path: modulePath,
					sha256: createHash("sha256")
						.update(await fs.readFile(modulePath))
						.digest("hex"),
				},
			],
			references: { checks: [modulePath], evals: [] },
			historyPath: path.join(root, "history.json"),
			allHistoryPaths: { complete: path.join(root, "history.json") },
			agentHistoryKeys: {},
			resultsDir: path.join(root, "results"),
		};
		const configPath = path.join(root, "config.json");
		await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
		const previousBead = process.env.GC_BEAD_ID;
		const previousIteration = process.env.GC_ITERATION;
		process.env.GC_BEAD_ID = "bead-1";
		process.env.GC_ITERATION = "1";
		try {
			expect(
				await runGasCityPolicyCheck(configPath, async () =>
					JSON.stringify({
						data: [{ id: "bead-1", title: "Implemented", status: "closed", metadata: {} }],
					}),
				),
			).toBe(0);
			const artifact = path.join(root, "results", "complete", "attempt-0.json");
			expect(await fs.stat(artifact).then(() => true)).toBe(true);
			expect(JSON.parse(await fs.readFile(path.join(root, "history.json"), "utf8")).results).toHaveLength(1);
		} finally {
			if (previousBead === undefined) delete process.env.GC_BEAD_ID;
			else process.env.GC_BEAD_ID = previousBead;
			if (previousIteration === undefined) delete process.env.GC_ITERATION;
			else process.env.GC_ITERATION = previousIteration;
		}
	});
	it("blocks rejected policies and writes failure evidence", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-gascity-bridge-failure-"));
		const modulePath = path.resolve("test/fixtures/eval-fails.ts");
		const definition = parseShortleash(JSON.stringify({ shortleash: { name: "bridge-failure", workspace: "." } }));
		const config: GasCityPolicyBridgeConfig = {
			schemaVersion: 1,
			key: "complete",
			boundary: "complete",
			definition: serializeShortleashDefinition(definition),
			definitionDir: process.cwd(),
			definitionHash: "definition-hash",
			cwd: root,
			workspace: root,
			shortleashDir: path.join(root, ".shortleash_bridge-failure"),
			policyModules: [
				{
					path: modulePath,
					sha256: createHash("sha256")
						.update(await fs.readFile(modulePath))
						.digest("hex"),
				},
			],
			references: { checks: [], evals: [modulePath] },
			historyPath: path.join(root, "history.json"),
			allHistoryPaths: { complete: path.join(root, "history.json") },
			agentHistoryKeys: {},
			resultsDir: path.join(root, "results"),
		};
		const configPath = path.join(root, "config.json");
		await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
		const previousBead = process.env.GC_BEAD_ID;
		const previousIteration = process.env.GC_ITERATION;
		process.env.GC_BEAD_ID = "bead-1";
		process.env.GC_ITERATION = "1";
		try {
			expect(
				await runGasCityPolicyCheck(configPath, async () =>
					JSON.stringify({
						data: [{ id: "bead-1", title: "Implemented", status: "closed", metadata: {} }],
					}),
				),
			).toBe(1);
			const artifact = JSON.parse(
				await fs.readFile(path.join(root, "results", "complete", "attempt-0.json"), "utf8"),
			);
			expect(artifact.decision.accepted).toBe(false);
			expect(artifact.decision.evaluations).toHaveLength(1);
			expect(JSON.parse(await fs.readFile(path.join(root, "history.json"), "utf8")).results).toHaveLength(1);
		} finally {
			if (previousBead === undefined) delete process.env.GC_BEAD_ID;
			else process.env.GC_BEAD_ID = previousBead;
			if (previousIteration === undefined) delete process.env.GC_ITERATION;
			else process.env.GC_ITERATION = previousIteration;
		}
	});

	it("reports malformed and explicit Gas City JSON failures", async () => {
		expect(() => parseGasCityJson("not-json", ["formula", "list"])).toThrow("returned invalid JSON");
		expect(() =>
			parseGasCityJson(JSON.stringify({ ok: false, error: { message: "bad formula" } }), ["formula", "cook"]),
		).toThrow("bad formula");
		await expect(runGasCityJson(["formula", "list"], ".", undefined, async () => "not-json")).rejects.toThrow(
			"returned invalid JSON",
		);
	});
});
