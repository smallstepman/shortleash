import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Text as TextComponent } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, ScrollView, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { SwarmDefinition } from "../definition/schema";
import type { StateTracker } from "../execution/state";
import { renderSwarmDashboardLines, renderSwarmWidgetLine } from "./render";

export interface SwarmDashboardHandle {
	update(): void;
	dispose(): Promise<void>;
}

/** Attach the live widget and a centered fullscreen Alt+W dashboard to any active swarm execution. */
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
				let panelWidth = Math.max(12, process.stdout.columns ?? 120);

				const getLayout = (width: number) => {
					const availableWidth = Math.max(12, Math.floor(width));
					const dashboardWidth = Math.min(availableWidth, Math.max(64, Math.floor(availableWidth * 0.94)));
					const viewportRows = Math.max(8, process.stdout.rows ?? 40);
					const contentWidth = Math.max(8, dashboardWidth - 2);
					const innerHeight = Math.max(1, viewportRows - 2);
					const leftPadding = Math.max(0, Math.floor((availableWidth - dashboardWidth) / 2));
					const rightPadding = Math.max(0, availableWidth - dashboardWidth - leftPadding);
					return {
						availableWidth,
						dashboardWidth,
						viewportRows,
						contentWidth,
						innerHeight,
						leftPadding,
						rightPadding,
					};
				};

				const createViewport = (width: number) => {
					const layout = getLayout(width);
					const content = renderSwarmDashboardLines(
						definition,
						stateTracker.state,
						layout.contentWidth,
						theme,
						Math.floor(Date.now() / 120),
						{ cancelShortcut: true },
					);
					const view = new ScrollView(content, {
						height: layout.innerHeight,
						scrollbar: "auto",
						totalRows: content.length,
						theme: {
							track: text => theme.fg("dim", text),
							thumb: text => theme.fg("accent", text),
						},
					});
					view.setScrollOffset(scrollOffset);
					return { layout, view };
				};

				const frameLine = (line: string, layout: ReturnType<typeof getLayout>): string => {
					const clipped = truncateToWidth(line, layout.contentWidth);
					const padding = " ".repeat(Math.max(0, layout.contentWidth - visibleWidth(clipped)));
					return `${theme.fg("borderMuted", "│")}${clipped}${padding}${theme.fg("borderMuted", "│")}`;
				};

				const renderBody = (width: number): string[] => {
					const { layout, view } = createViewport(width);
					scrollOffset = view.getScrollOffset();
					const horizontal = "─".repeat(Math.max(0, layout.dashboardWidth - 2));
					const border = theme.fg("borderMuted", `╭${horizontal}╮`);
					const bottom = theme.fg("borderMuted", `╰${horizontal}╯`);
					const panel = [border, ...view.render(layout.contentWidth).map(line => frameLine(line, layout)), bottom];
					return panel.map(line => `${" ".repeat(layout.leftPadding)}${line}${" ".repeat(layout.rightPadding)}`);
				};

				closeDashboard = () => done(undefined);
				return {
					render(width: number): readonly string[] {
						panelWidth = Math.max(12, Math.floor(width));
						return renderBody(panelWidth);
					},
					handleInput(data: string): void {
						if (data === "x") {
							onCancel();
							ctx.ui.notify(`Cancellation requested for swarm '${definition.name}'.`, "warning");
							done(undefined);
							return;
						}
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

						const { view } = createViewport(panelWidth);
						let moved = false;
						if (data === "k") {
							view.scroll(-1);
							moved = true;
						} else if (data === "j") {
							view.scroll(1);
							moved = true;
						} else if (data === "h") {
							view.page(-1);
							moved = true;
						} else if (data === "l") {
							view.page(1);
							moved = true;
						} else {
							moved = view.handleScrollKey(data);
						}
						if (moved) {
							scrollOffset = view.getScrollOffset();
							tui.requestRender();
						}
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
