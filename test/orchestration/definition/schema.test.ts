import {
	fingerprintSwarmDefinition,
	parsePolicyRef,
	parseSwarm,
	serializeSwarmDefinition,
} from "../../../src/orchestration/definition/schema";

const yamlDefinition = `
swarm:
  name: format-equivalence
  workspace: ./workspace
  mode: pipeline
  target_count: 2
  model: default-model
  plugins:
    - ./policies/obligations.ts
  checks:
    - obligations:architecture
    - plugin: obligations
      id: acceptance
  evals:
    - plugin: obligations
      id: evaluator
  agents:
    discover:
      role: investigator
      task: |
        Inspect the repository.
      extra_context: |
        Record evidence.
      reports_to:
        - implement
      waits_for: []
      model: fast-model
      checks:
        - obligations:agent-architecture
        - obligations:agent-evidence
      evals:
        - obligations:agent-review
    implement:
      role: engineer
      task: Implement the change.
      waits_for:
        - discover
`;

const jsonDefinition = JSON.stringify({
	swarm: {
		name: "format-equivalence",
		workspace: "./workspace",
		mode: "pipeline",
		target_count: 2,
		model: "default-model",
		plugins: ["./policies/obligations.ts"],
		checks: ["obligations:architecture", { plugin: "obligations", id: "acceptance" }],
		evals: [{ plugin: "obligations", id: "evaluator" }],
		agents: {
			discover: {
				role: "investigator",
				task: "Inspect the repository.",
				extra_context: "Record evidence.",
				reports_to: ["implement"],
				waits_for: [],
				model: "fast-model",
				checks: ["obligations:agent-architecture", "obligations:agent-evidence"],
				evals: ["obligations:agent-review"],
			},
			implement: {
				role: "engineer",
				task: "Implement the change.",
				waits_for: ["discover"],
			},
		},
	},
});

describe("swarm definition formats", () => {
	it("parses equivalent JSON and YAML structures identically", () => {
		expect(parseSwarm(jsonDefinition)).toEqual(parseSwarm(yamlDefinition));
	});

	it("rejects empty definitions with a format-independent error", () => {
		expect(() => parseSwarm("  \n")).toThrow("Swarm definition must not be empty");
	});
	it("rejects unknown raw fields before normalization", () => {
		expect(() =>
			parseSwarm(
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
			parseSwarm(
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

	it("rejects malformed relationship arrays instead of retaining untyped values", () => {
		expect(() =>
			parseSwarm(
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

	it("parses typed inline policy parameters", () => {
		expect(parsePolicyRef("fixture:check::count=3::ratio=1.5::enabled=true::none=null")).toEqual({
			plugin: "fixture",
			id: "check",
			params: {
				count: 3,
				ratio: 1.5,
				enabled: true,
				none: null,
			},
		});
	});
});

describe("swarm execution policy defaults", () => {
	it("defaults workers to shared workspace and no parent history", () => {
		const definition = parseSwarm(`
swarm:
  name: defaults
  workspace: .
  agents:
    worker:
      role: engineer
      task: implement
`);

		expect(definition.workspaceIsolation).toBe("none");
		expect(definition.inheritHistory).toBe(false);
		expect(definition.agentExecution).toBe("herdr");
		expect(definition.agents.get("worker")).toMatchObject({
			workspaceIsolation: undefined,
			inheritHistory: undefined,
		});
	});

	it("selects the in-process subagent backend when configured", () => {
		const definition = parseSwarm(`
swarm:
  name: subagents
  workspace: .
  agent_execution: subagents
  agents:
    worker:
      role: engineer
      task: implement
`);

		expect(definition.agentExecution).toBe("subagents");
		expect(serializeSwarmDefinition(definition).agentExecution).toBe("subagents");
		expect(() =>
			parseSwarm(`
swarm:
  name: invalid-execution
  workspace: .
  agent_execution: threads
  agents:
    worker:
      role: engineer
      task: implement
`),
		).toThrow("Invalid agent_execution");
	});

	it("parses global policies and per-agent overrides", () => {
		const definition = parseSwarm(`
swarm:
  name: policies
  workspace: .
  isolation: worktree
  inherit_history: parent
  agents:
    inherited:
      role: engineer
      task: implement
    local:
      role: tester
      task: verify
      workspace_isolation: none
      history: none
`);

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
		const definition = parseSwarm(`
swarm:
  name: inherited-policies
  workspace: .
  checks:
    - fixture:global-architecture
    - fixture:global-acceptance
  evals:
    - fixture:global-eval
  agents:
    first:
      role: engineer
      task: implement
      checks:
        - fixture:local-architecture
        - fixture:local-acceptance
      evals:
        - fixture:local-eval
    second:
      role: tester
      task: verify
`);

		expect(definition.agents.get("first")).toMatchObject({
			checks: [
				"fixture:global-architecture",
				"fixture:global-acceptance",
				"fixture:local-architecture",
				"fixture:local-acceptance",
			],
			evals: ["fixture:global-eval", "fixture:local-eval"],
		});
		expect(definition.agents.get("second")).toMatchObject({
			checks: ["fixture:global-architecture", "fixture:global-acceptance"],
			evals: ["fixture:global-eval"],
		});
	});

	it("parses a no-agent definition for direct current-session execution", () => {
		const definition = parseSwarm(`
swarm:
  name: direct-current
  workspace: .
  task: Continue the current objective.
  checks:
    - fixture:global-architecture
`);

		expect(definition.task).toBe("Continue the current objective.");
		expect(definition.agents.size).toBe(0);
		expect(definition.agentOrder).toEqual([]);
		expect(definition.checks).toEqual(["fixture:global-architecture"]);
	});
	it("rejects removed rule and must fields instead of silently ignoring them", () => {
		expect(() =>
			parseSwarm(`
swarm:
  name: removed-top-level-policy
  workspace: .
  rules: []
`),
		).toThrow("swarm uses removed policy fields; use checks instead");

		expect(() =>
			parseSwarm(`
swarm:
  name: removed-agent-policy
  workspace: .
  agents:
    worker:
      role: engineer
      task: implement
      must: []
`),
		).toThrow("swarm.agents.worker uses removed policy fields; use checks instead");
	});

	it("rejects invalid isolation and history values", () => {
		expect(() =>
			parseSwarm(`
swarm:
  name: invalid-isolation
  workspace: .
  isolation: sandbox
  agents:
    worker:
      role: engineer
      task: implement
`),
		).toThrow("swarm.isolation must be one of: none, worktree");

		expect(() =>
			parseSwarm(`
swarm:
  name: invalid-history
  workspace: .
  inherit_history: maybe
  agents:
    worker:
      role: engineer
      task: implement
`),
		).toThrow("swarm.inherit_history must be a boolean or one of: parent, none");
	});
});

describe("swarm lifecycle controls", () => {
	it("normalizes failure, concurrency, timeout, and budget controls", () => {
		const definition = parseSwarm(`
swarm:
  name: controls
  workspace: .
  mode: parallel
  failure_policy: fail_fast
  max_concurrency: 2
  agent_timeout_ms: 1500
  token_budget: 10000
  request_budget: 8
  agents:
    worker:
      role: engineer
      task: implement
`);

		expect(definition).toMatchObject({
			failurePolicy: "fail_fast",
			maxConcurrency: 2,
			agentTimeoutMs: 1500,
			tokenBudget: 10000,
			requestBudget: 8,
		});
	});

	it("fingerprints semantically equivalent normalized definitions deterministically", () => {
		const first = parseSwarm(`
swarm:
  name: fingerprint
  workspace: .
  agents:
    worker:
      role: engineer
      task: implement
`);
		const second = parseSwarm(`
swarm:
  name: fingerprint
  workspace: .
  agents:
    worker:
      role: engineer
      task: implement
`);

		expect(fingerprintSwarmDefinition(first)).toBe(fingerprintSwarmDefinition(second));
		expect(serializeSwarmDefinition(first)).toMatchObject({ name: "fingerprint", agents: [{ name: "worker" }] });
	});
});
