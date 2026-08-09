import {
	fingerprintShortleashDefinition,
	parseShortleash,
	parseShortleashPolicyPath,
	serializeShortleashDefinition,
} from "../../../src/orchestration/definition/schema";

const jsonDefinition = JSON.stringify({
	swarm: {
		name: "format-equivalence",
		workspace: "./workspace",
		model: "default-model",
		checks: ["./policies/architecture.ts", { path: "./policies/acceptance.ts" }],
		evals: [{ path: "./policies/evaluator.ts" }],
		agents: {
			discover: {
				role: "investigator",
				task: "Inspect the repository.",
				extra_context: "Record evidence.",
				reports_to: ["implement"],
				waits_for: [],
				model: "fast-model",
				checks: ["./policies/agent-architecture.ts", "./policies/agent-evidence.ts"],
				evals: ["./policies/agent-review.ts"],
			},
			implement: {
				role: "engineer",
				task: "Implement the change.",
				waits_for: ["discover"],
			},
		},
	},
});

describe("Shortleash definition JSON", () => {
	it("parses JSON definitions", () => {
		expect(parseShortleash(jsonDefinition).name).toBe("format-equivalence");
	});

	it("rejects non-JSON definitions", () => {
		expect(() => parseShortleash("swarm:\n  name: invalid\n  workspace: .")).toThrow("must be valid JSON");
	});

	it("rejects empty definitions with a format-independent error", () => {
		expect(() => parseShortleash("  \n")).toThrow("Shortleash definition must not be empty");
	});
	it("rejects unknown raw fields before normalization", () => {
		expect(() =>
			parseShortleash(
				JSON.stringify({
					swarm: {
						name: "unknown-field",
						workspace: ".",
						unexpected: true,
					},
				}),
			),
		).toThrow("swarm.unexpected is not allowed");

		expect(() =>
			parseShortleash(
				JSON.stringify({
					swarm: {
						name: "unknown-agent-field",
						workspace: ".",
						agents: {
							worker: { role: "engineer", task: "implement", unexpected: true },
						},
					},
				}),
			),
		).toThrow("swarm.agents.worker.unexpected is not allowed");
	});
	it("rejects the removed separate plugin registry field", () => {
		expect(() =>
			parseShortleash(
				JSON.stringify({
					swarm: {
						name: "removed-plugin-registry",
						workspace: ".",
						plugins: ["./policies.ts"],
					},
				}),
			),
		).toThrow("swarm.plugins is not allowed");
	});

	it("rejects removed scheduling and budget configuration", () => {
		for (const [field, value] of [
			["mode", "parallel"],
			["max_concurrency", "2"],
			["target_count", "2"],
			["agent_execution", "subagents"],
			["token_budget", "10000"],
			["request_budget", "8"],
		]) {
			expect(() =>
				parseShortleash(
					JSON.stringify({
						swarm: {
							name: `removed-${field}`,
							workspace: ".",
							[field]: value,
						},
					}),
				),
			).toThrow(`swarm.${field} is not allowed`);
		}
	});

	it("rejects malformed relationship arrays instead of retaining untyped values", () => {
		expect(() =>
			parseShortleash(
				JSON.stringify({
					swarm: {
						name: "invalid-relationships",
						workspace: ".",
						agents: {
							worker: { role: "engineer", task: "implement", waits_for: ["", 7] },
						},
					},
				}),
			),
		).toThrow("swarm.agents.worker.waits_for must be an array of non-empty strings");
	});

	it("parses direct TypeScript policy module paths and typed parameters", () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "parameterized",
					workspace: ".",
					checks: [{ path: "./checks/git.ts", params: { count: 3, ratio: 1.5, enabled: true, none: null } }],
				},
			}),
		);
		expect(definition.checks).toEqual([
			{ path: "./checks/git.ts", params: { count: 3, ratio: 1.5, enabled: true, none: null } },
		]);
		expect(parseShortleashPolicyPath("./checks/git.ts")).toBe("./checks/git.ts");
		expect(() => parseShortleashPolicyPath("./checks/git.js")).toThrow("must point to a .ts file");
	});
});
describe("Shortleash execution policy defaults", () => {
	it("defaults workers to shared workspace and no parent history", () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "defaults",
					workspace: ".",
					agents: {
						worker: { role: "engineer", task: "implement" },
					},
				},
			}),
		);

		expect(definition.workspaceIsolation).toBe("none");
		expect(definition.inheritHistory).toBe(false);
		expect(definition.agents.get("worker")).toMatchObject({
			workspaceIsolation: undefined,
			inheritHistory: undefined,
		});
	});

	it("parses global policies and per-agent overrides", () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "policies",
					workspace: ".",
					isolation: "worktree",
					inherit_history: "parent",
					agents: {
						inherited: { role: "engineer", task: "implement" },
						local: {
							role: "tester",
							task: "verify",
							workspace_isolation: "none",
							history: "none",
						},
					},
				},
			}),
		);

		expect(definition.workspaceIsolation).toBe("worktree");
		expect(definition.inheritHistory).toBe(true);
		expect(definition.agents.get("inherited")).toMatchObject({
			workspaceIsolation: undefined,
			inheritHistory: undefined,
		});
		expect(definition.agents.get("local")).toMatchObject({
			workspaceIsolation: "none",
			inheritHistory: false,
		});
	});

	it("merges top-level checks into every declared agent in declaration order", () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "inherited-policies",
					workspace: ".",
					checks: ["./policies/global-architecture.ts", "./policies/global-acceptance.ts"],
					evals: ["./policies/global-eval.ts"],
					agents: {
						first: {
							role: "engineer",
							task: "implement",
							checks: ["./policies/local-architecture.ts", "./policies/local-acceptance.ts"],
							evals: ["./policies/local-eval.ts"],
						},
						second: { role: "tester", task: "verify" },
					},
				},
			}),
		);

		expect(definition.agents.get("first")).toMatchObject({
			checks: [
				"./policies/global-architecture.ts",
				"./policies/global-acceptance.ts",
				"./policies/local-architecture.ts",
				"./policies/local-acceptance.ts",
			],
			evals: ["./policies/global-eval.ts", "./policies/local-eval.ts"],
		});
		expect(definition.agents.get("second")).toMatchObject({
			checks: ["./policies/global-architecture.ts", "./policies/global-acceptance.ts"],
			evals: ["./policies/global-eval.ts"],
		});
	});

	it("parses a no-agent definition for direct current-session execution", () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "direct-current",
					workspace: ".",
					task: "Continue the current objective.",
					checks: ["./policies/global-architecture.ts"],
				},
			}),
		);

		expect(definition.task).toBe("Continue the current objective.");
		expect(definition.agents.size).toBe(0);
		expect(definition.agentOrder).toEqual([]);
		expect(definition.checks).toEqual(["./policies/global-architecture.ts"]);
	});
	it("rejects removed rule and must fields instead of silently ignoring them", () => {
		expect(() =>
			parseShortleash(
				JSON.stringify({
					swarm: {
						name: "removed-top-level-policy",
						workspace: ".",
						rules: [],
					},
				}),
			),
		).toThrow("swarm uses removed policy fields; use checks instead");

		expect(() =>
			parseShortleash(
				JSON.stringify({
					swarm: {
						name: "removed-agent-policy",
						workspace: ".",
						agents: {
							worker: { role: "engineer", task: "implement", must: [] },
						},
					},
				}),
			),
		).toThrow("swarm.agents.worker uses removed policy fields; use checks instead");
	});

	it("rejects invalid isolation and history values", () => {
		expect(() =>
			parseShortleash(
				JSON.stringify({
					swarm: {
						name: "invalid-isolation",
						workspace: ".",
						isolation: "sandbox",
						agents: {
							worker: { role: "engineer", task: "implement" },
						},
					},
				}),
			),
		).toThrow("swarm.isolation must be one of: none, worktree");

		expect(() =>
			parseShortleash(
				JSON.stringify({
					swarm: {
						name: "invalid-history",
						workspace: ".",
						inherit_history: "maybe",
						agents: {
							worker: { role: "engineer", task: "implement" },
						},
					},
				}),
			),
		).toThrow("swarm.inherit_history must be a boolean or one of: parent, none");
	});
});

describe("swarm lifecycle controls", () => {
	it("normalizes failure and timeout controls", () => {
		const definition = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "controls",
					workspace: ".",
					failure_policy: "fail_fast",
					agent_timeout_ms: 1500,
					agents: {
						worker: { role: "engineer", task: "implement" },
					},
				},
			}),
		);

		expect(definition).toMatchObject({
			failurePolicy: "fail_fast",
			agentTimeoutMs: 1500,
		});
	});

	it("fingerprints semantically equivalent normalized definitions deterministically", () => {
		const first = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "fingerprint",
					workspace: ".",
					agents: {
						worker: { role: "engineer", task: "implement" },
					},
				},
			}),
		);
		const second = parseShortleash(
			JSON.stringify({
				swarm: {
					name: "fingerprint",
					workspace: ".",
					agents: {
						worker: { role: "engineer", task: "implement" },
					},
				},
			}),
		);

		expect(fingerprintShortleashDefinition(first)).toBe(fingerprintShortleashDefinition(second));
		expect(serializeShortleashDefinition(first)).toMatchObject({ name: "fingerprint", agents: [{ name: "worker" }] });
	});
});
