import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { parseShortleash } from "../../../src/orchestration/definition/schema";
import { StateTracker } from "../../../src/orchestration/execution/state";
import { attachShortleashDashboard } from "../../../src/orchestration/presentation/dashboard";

describe("Shortleash dashboard lifecycle", () => {
	it("attaches the widget and opens an overlay from Alt+W", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "shortleash-dashboard-ui-"));
		try {
			const definition = parseShortleash(
				JSON.stringify({
					swarm: {
						name: "dashboard-ui",
						workspace,
						agents: {
							inspect: { role: "inspector", task: "Inspect the workspace." },
						},
					},
				}),
			);
			const stateTracker = new StateTracker(workspace, definition.name);
			await stateTracker.init(["inspect"]);

			const widgets: Array<{ key: string; content: unknown; options: unknown }> = [];
			let terminalInput: ((data: string) => unknown) | undefined;
			let unsubscribeCalled = false;
			let customOptions: unknown;
			let customComponent: { render(width: number): readonly string[]; handleInput(data: string): void } | undefined;
			let cancelRequested = 0;
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
					customComponent = (await factory(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text },
						{},
						done,
					)) as { render(width: number): readonly string[]; handleInput(data: string): void };
					return completed;
				},
			} as unknown as ExtensionContext["ui"];
			const ctx = { hasUI: true, ui } as unknown as ExtensionContext;

			const dashboard = attachShortleashDashboard(ctx, definition, stateTracker, () => {
				cancelRequested++;
			});
			expect(widgets[0]).toMatchObject({
				key: "shortleash-dashboard-ui",
				options: { placement: "belowEditor" },
			});
			expect(terminalInput?.("\x1bw")).toEqual({ consume: true });

			await Promise.resolve();
			expect(customOptions).toEqual({ overlay: true });
			expect(customComponent).toBeDefined();
			const renderedLines = customComponent?.render(100) ?? [];
			const rendered = renderedLines.join("\n");
			expect(rendered).toContain("Shortleash dashboard-ui");
			expect(rendered).toContain("Execution graph");
			expect(visibleWidth(renderedLines[0] ?? "")).toBe(100);
			expect(renderedLines[0]).toContain("╭");
			expect(renderedLines.at(-1)).toContain("╯");

			customComponent?.handleInput("j");
			customComponent?.handleInput("k");
			customComponent?.handleInput("h");
			customComponent?.handleInput("l");
			customComponent?.handleInput("x");
			await dashboard.dispose();
			expect(cancelRequested).toBe(1);
			expect(widgets.at(-1)?.content).toBeUndefined();
			expect(unsubscribeCalled).toBe(true);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});
});
