import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { parseSwarm } from "../../../src/orchestration/definition/schema";
import type { SwarmState } from "../../../src/orchestration/execution/state";
import { renderSwarmDashboardLines } from "../../../src/orchestration/presentation/render";

const identityTheme = {
	fg: (_color: string, text: string) => text,
};

describe("swarm dashboard rendering", () => {
	it("renders graph rows and at most five recent actions", () => {
		const definition = parseSwarm(`
swarm:
  name: dashboard
  workspace: .
  agents:
    inspect:
      role: investigator
      task: inspect
    implement:
      role: engineer
      task: implement
      waits_for: [inspect]
`);
		const state: SwarmState = {
			name: "dashboard",
			status: "running",
			mode: "pipeline",
			iteration: 0,
			targetCount: 1,
			startedAt: Date.now(),
			agents: {
				inspect: {
					name: "inspect",
					status: "completed",
					iteration: 0,
					wave: 0,
					recentTools: Array.from({ length: 7 }, (_, index) => ({
						tool: `tool-${index}`,
						args: `arg-${index}`,
						endMs: index,
					})),
				},
				implement: {
					name: "implement",
					status: "running",
					iteration: 0,
					wave: 1,
					currentTool: "edit",
				},
			},
		};

		const lines = renderSwarmDashboardLines(definition, state, 100, identityTheme);
		const rendered = lines.join("\n");
		expect(rendered).toContain("inspect");
		expect(rendered).toContain("implement");
		expect(rendered).toContain("╭");
		expect(rendered).toContain("╰");
		expect(rendered).toContain("│");
		expect(rendered).toContain("tool-0(arg-0)");
		expect(rendered).toContain("tool-4(arg-4)");
		expect(rendered).not.toContain("tool-5(arg-5)");
		expect(rendered).toContain("edit running");
	});

	it("draws diagonal branches and animates active nodes", () => {
		const definition = parseSwarm(`
swarm:
  name: diamond
  workspace: .
  agents:
    start:
      role: root
      task: start
    validate:
      role: branch
      task: validate
      waits_for: [start]
    reject:
      role: branch
      task: reject
      waits_for: [start]
    process:
      role: join
      task: process
      waits_for: [validate, reject]
`);
		const state: SwarmState = {
			name: "diamond",
			status: "running",
			mode: "pipeline",
			iteration: 0,
			targetCount: 1,
			startedAt: Date.now(),
			agents: {
				start: { name: "start", status: "completed", iteration: 0, wave: 0 },
				validate: { name: "validate", status: "running", iteration: 0, wave: 1 },
				reject: { name: "reject", status: "pending", iteration: 0, wave: 1 },
				process: { name: "process", status: "pending", iteration: 0, wave: 2 },
			},
		};
		const frame0 = renderSwarmDashboardLines(definition, state, 100, identityTheme, 0).join("\n");
		const frame1 = renderSwarmDashboardLines(definition, state, 100, identityTheme, 1).join("\n");
		expect(frame0).toContain("╱");
		expect(frame0).toContain("╲");
		expect(frame0).not.toEqual(frame1);
	});
	it("uses lighter connectors for dense graphs without changing node layout", () => {
		const definition = parseSwarm(`
swarm:
  name: dense
  workspace: .
  agents:
    root01:
      role: root
      task: root
    root02:
      role: root
      task: root
    root03:
      role: root
      task: root
    root04:
      role: root
      task: root
    merge01:
      role: merge
      task: merge
      waits_for: [root01, root02]
    merge02:
      role: merge
      task: merge
      waits_for: [root02, root03]
    merge03:
      role: merge
      task: merge
      waits_for: [root03, root04]
    finale:
      role: finale
      task: finale
      waits_for: [merge01, merge02, merge03]
`);
		const state: SwarmState = {
			name: "dense",
			status: "running",
			mode: "pipeline",
			iteration: 0,
			targetCount: 1,
			startedAt: Date.now(),
			agents: {
				root01: { name: "root01", status: "completed", iteration: 0, wave: 0 },
				root02: { name: "root02", status: "completed", iteration: 0, wave: 0 },
				root03: { name: "root03", status: "pending", iteration: 0, wave: 0 },
				root04: { name: "root04", status: "pending", iteration: 0, wave: 0 },
				merge01: { name: "merge01", status: "waiting", iteration: 0, wave: 1 },
				merge02: { name: "merge02", status: "pending", iteration: 0, wave: 1 },
				merge03: { name: "merge03", status: "pending", iteration: 0, wave: 1 },
				finale: { name: "finale", status: "pending", iteration: 0, wave: 2 },
			},
		};
		const lines = renderSwarmDashboardLines(definition, state, 60, identityTheme);
		const graphStart = lines.indexOf(" Execution graph");
		const graphEnd = lines.indexOf(" Recent native actions");
		const graph = lines.slice(graphStart + 1, graphEnd);
		const rendered = graph.join("\n");
		expect(rendered).toContain("╭");
		expect(rendered).toContain("╰");
		expect(rendered).not.toContain("Dense dependency map");
		expect(rendered).not.toContain("←");
		expect(rendered).not.toContain("╱");
		expect(rendered).not.toContain("╲");
		expect(rendered).toMatch(/[·┄┊]/);
		for (const name of definition.agentOrder) expect(rendered).toContain(name);
		for (const line of graph) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("keeps library-backed graph output deterministic and bounded at narrow widths", () => {
		const definition = parseSwarm(`
swarm:
  name: narrow
  workspace: .
  agents:
    first:
      role: root
      task: first
    second:
      role: branch
      task: second
      waits_for: [first]
    third:
      role: branch
      task: third
      waits_for: [first]
    fourth:
      role: join
      task: fourth
      waits_for: [second, third]
`);
		const state: SwarmState = {
			name: "narrow",
			status: "running",
			mode: "pipeline",
			iteration: 0,
			targetCount: 1,
			startedAt: Date.now(),
			agents: {},
		};
		const first = renderSwarmDashboardLines(definition, state, 18, identityTheme, 0);
		const second = renderSwarmDashboardLines(definition, state, 18, identityTheme, 0);
		const graphStart = first.indexOf(" Execution graph");
		const graphEnd = first.indexOf(" Recent native actions");
		expect(first).toEqual(second);
		expect(graphStart).toBeGreaterThanOrEqual(0);
		expect(graphEnd).toBeGreaterThan(graphStart);
		for (const line of first.slice(graphStart + 1, graphEnd)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(18);
		}
	});

	it("reports cycles without throwing and ignores unknown dependency references", () => {
		const cycle = parseSwarm(`
swarm:
  name: cycle
  workspace: .
  agents:
    first:
      role: root
      task: first
      waits_for: [second]
    second:
      role: branch
      task: second
      waits_for: [first]
`);
		const cycleState: SwarmState = {
			name: "cycle",
			status: "failed",
			mode: "pipeline",
			iteration: 0,
			targetCount: 1,
			startedAt: Date.now(),
			agents: {},
		};
		const cycleOutput = renderSwarmDashboardLines(cycle, cycleState, 36, identityTheme).join("\n");
		expect(cycleOutput).toContain("Dependency cycle");

		const missing = parseSwarm(`
swarm:
  name: missing
  workspace: .
  agents:
    worker:
      role: worker
      task: worker
      waits_for: [not-defined]
`);
		const missingState: SwarmState = {
			name: "missing",
			status: "running",
			mode: "pipeline",
			iteration: 0,
			targetCount: 1,
			startedAt: Date.now(),
			agents: {},
		};
		const missingOutput = renderSwarmDashboardLines(missing, missingState, 36, identityTheme).join("\n");
		expect(missingOutput).toContain("worker");
		expect(missingOutput).not.toContain("Unable to lay out execution graph");
	});
	it("preserves status colors through the text canvas", () => {
		const definition = parseSwarm(`
swarm:
  name: colors
  workspace: .
  agents:
    done:
      role: root
      task: done
    active:
      role: worker
      task: active
      waits_for: [done]
`);
		const state: SwarmState = {
			name: "colors",
			status: "running",
			mode: "pipeline",
			iteration: 0,
			targetCount: 1,
			startedAt: Date.now(),
			agents: {
				done: { name: "done", status: "completed", iteration: 0, wave: 0 },
				active: { name: "active", status: "running", iteration: 0, wave: 1 },
			},
		};
		const calls: Array<[string, string]> = [];
		renderSwarmDashboardLines(definition, state, 60, {
			fg(color, text) {
				calls.push([color, text]);
				return text;
			},
		});
		expect(calls.some(([color, text]) => color === "success" && text.includes("done"))).toBe(true);
		expect(calls.some(([color, text]) => color === "warning" && text.includes("active"))).toBe(true);
	});
});
