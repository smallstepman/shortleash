import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseSwarm } from "../../../src/orchestration/definition/schema";
import { StateTracker } from "../../../src/orchestration/execution/state";
import { attachSwarmDashboard } from "../../../src/orchestration/presentation/dashboard";

describe("swarm dashboard lifecycle", () => {
	it("attaches the widget and opens an overlay from Alt+W", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-dashboard-ui-"));
		try {
			const definition = parseSwarm(`
swarm:
  name: dashboard-ui
  workspace: ${workspace}
  mode: sequential
  agents:
    inspect:
      role: inspector
      task: Inspect the workspace.
`);
			const stateTracker = new StateTracker(workspace, definition.name);
			await stateTracker.init(["inspect"], 1, "sequential");

			const widgets: Array<{ key: string; content: unknown; options: unknown }> = [];
			let terminalInput: ((data: string) => unknown) | undefined;
			let unsubscribeCalled = false;
			let customOptions: unknown;
			let customComponent: { render(width: number): readonly string[] } | undefined;
			let finishCustom: (() => void) | undefined;

			const ui = {
				setWidget(key: string, content: unknown, options: unknown) {
					widgets.push({ key, content, options });
				},
				onTerminalInput(handler: (data: string) => unknown) {
					terminalInput = handler;
					return () => {
						unsubscribeCalled = true;
					};
				},
				notify() {},
				custom: async (...args: unknown[]) => {
					customOptions = args[1];
					const factory = args[0] as (...factoryArgs: unknown[]) => unknown;
					let resolveCustom!: () => void;
					const completed = new Promise<void>(resolve => {
						resolveCustom = resolve;
					});
					const done = () => resolveCustom();
					finishCustom = done;
					customComponent = (await factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text },
						{},
						done,
					)) as { render(width: number): readonly string[] };
					return completed;
				},
			} as unknown as ExtensionContext["ui"];
			const ctx = { hasUI: true, ui } as unknown as ExtensionContext;

			const dashboard = attachSwarmDashboard(ctx, definition, stateTracker, () => {});
			expect(widgets[0]).toMatchObject({
				key: "swarm-dashboard-ui",
				options: { placement: "belowEditor" },
			});
			expect(terminalInput?.("\x1bw")).toEqual({ consume: true });

			await Promise.resolve();
			expect(customOptions).toEqual({ overlay: true });
			expect(customComponent).toBeDefined();
			const rendered = customComponent?.render(100).join("\n") ?? "";
			expect(rendered).toContain("Swarm dashboard-ui");
			expect(rendered).toContain("Execution graph");

			finishCustom?.();
			await dashboard.dispose();
			expect(widgets.at(-1)?.content).toBeUndefined();
			expect(unsubscribeCalled).toBe(true);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});
});
