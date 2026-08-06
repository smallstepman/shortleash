import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Text as TextComponent } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, ScrollView } from "@oh-my-pi/pi-tui";
import type { SwarmDefinition } from "../definition/schema";
import type { StateTracker } from "../execution/state";
import { renderSwarmDashboardPanelLines, renderSwarmWidgetLine } from "./render";

export interface SwarmDashboardHandle {
	update(): void;
	dispose(): Promise<void>;
}

/** Attach the live widget and Alt+W dashboard to any active swarm execution. */
export function attachSwarmDashboard(
	ctx: ExtensionContext,
	definition: SwarmDefinition,
	stateTracker: StateTracker,
	onCancel: () => void,
): SwarmDashboardHandle {
	const widgetKey = `swarm-${definition.name}`;
	let dashboardPromise: Promise<void> | undefined;
	let closeDashboard: (() => void) | undefined;
	let overlayTui: { requestRender(): void } | undefined;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	let disposed = false;

	const requestRender = (): void => {
		overlayTui?.requestRender();
	};

	const update = (): void => {
		if (!ctx.hasUI || disposed) return;
		ctx.ui.setWidget(
			widgetKey,
			(_tui, theme) => new TextComponent(renderSwarmWidgetLine(definition, stateTracker.state, theme), 0, 0),
			{ placement: "belowEditor" },
		);
		requestRender();
	};

	const openDashboard = (): void => {
		if (!ctx.hasUI || disposed || dashboardPromise) return;
		const customPromise = ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				overlayTui = tui;
				animationTimer = setInterval(() => tui.requestRender(), 120);
				let scrollOffset = 0;
				let panelWidth = Math.max(24, process.stdout.columns ?? 120);

				const renderBody = (width: number): string[] => {
					const dashboardWidth = Math.min(Math.max(48, Math.floor(width * 0.48)), Math.max(12, width));
					const leftPadding = " ".repeat(Math.max(0, width - dashboardWidth));
					return renderSwarmDashboardPanelLines(
						definition,
						stateTracker.state,
						dashboardWidth,
						theme,
						Math.floor(Date.now() / 120),
					).map(line => leftPadding + line);
				};

				closeDashboard = () => done(undefined);
				return {
					render(width: number): readonly string[] {
						panelWidth = Math.max(12, Math.floor(width));
						const terminalRows = process.stdout.rows ?? 40;
						const body = renderBody(panelWidth);
						const viewportRows = Math.max(6, terminalRows - 4);
						const maxScroll = Math.max(0, body.length - viewportRows);
						scrollOffset = Math.min(scrollOffset, maxScroll);
						const view = new ScrollView(body.slice(scrollOffset, scrollOffset + viewportRows), {
							height: viewportRows,
							scrollbar: "auto",
							totalRows: body.length,
							theme: {
								track: text => theme.fg("dim", text),
								thumb: text => theme.fg("accent", text),
							},
						});
						view.setScrollOffset(scrollOffset);
						return view.render(panelWidth);
					},
					handleInput(data: string): void {
						const terminalRows = process.stdout.rows ?? 40;
						const bodyLength = renderBody(panelWidth).length;
						const viewportRows = Math.max(6, terminalRows - 4);
						const maxScroll = Math.max(0, bodyLength - viewportRows);
						if (data === "c" || matchesKey(data, "ctrl+c")) {
							onCancel();
							ctx.ui.notify(`Cancellation requested for swarm '${definition.name}'.`, "info");
							done(undefined);
							return;
						}
						if (matchesKey(data, "escape") || matchesKey(data, "alt+w") || data === "q") {
							done(undefined);
							return;
						}
						if (matchesKey(data, "up") || data === "k") {
							scrollOffset = Math.max(0, scrollOffset - 1);
						} else if (matchesKey(data, "down") || data === "j") {
							scrollOffset = Math.min(maxScroll, scrollOffset + 1);
						} else if (matchesKey(data, "pageUp")) {
							scrollOffset = Math.max(0, scrollOffset - viewportRows);
						} else if (matchesKey(data, "pageDown")) {
							scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows);
						}
						tui.requestRender();
					},
					invalidate(): void {},
					dispose(): void {
						if (animationTimer) clearInterval(animationTimer);
						animationTimer = undefined;
						overlayTui = undefined;
						closeDashboard = undefined;
					},
				};
			},
			{ overlay: true },
		);
		dashboardPromise = customPromise.then(
			() => {
				dashboardPromise = undefined;
				closeDashboard = undefined;
			},
			() => {
				dashboardPromise = undefined;
				closeDashboard = undefined;
			},
		);
	};

	const unsubscribe = ctx.hasUI
		? ctx.ui.onTerminalInput(data => {
				if (!matchesKey(data, "alt+w")) return undefined;
				if (dashboardPromise) closeDashboard?.();
				else openDashboard();
				return { consume: true };
			})
		: () => {};

	update();

	return {
		update,
		async dispose(): Promise<void> {
			disposed = true;
			unsubscribe();
			closeDashboard?.();
			await dashboardPromise?.catch(() => {});
			if (ctx.hasUI) ctx.ui.setWidget(widgetKey, undefined);
		},
	};
}
