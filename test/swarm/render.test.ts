import { describe, expect, it } from "bun:test";
import { renderSwarmDashboardLines } from "../../src/swarm/render";
import { parseSwarm } from "../../src/swarm/schema";
import type { SwarmState } from "../../src/swarm/state";

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
});
