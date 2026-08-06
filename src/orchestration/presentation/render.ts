/**
 * TUI progress rendering for swarm pipeline status.
 */
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, truncate } from "@oh-my-pi/pi-utils";
import type { SwarmDefinition } from "../definition/schema";
import type { AgentState, SwarmState } from "../execution/state";
import { renderExecutionGraph } from "./graph";

const STATUS_LABELS: Record<string, string> = {
	completed: "[done]",
	running: "[....]",
	failed: "[FAIL]",
	pending: "[    ]",
	waiting: "[wait]",
	idle: "[idle]",
	aborted: "[stop]",
};

export function renderSwarmProgress(state: SwarmState): string[] {
	const lines: string[] = [];

	const statusLabel = state.status.toUpperCase();
	lines.push(`Swarm: ${state.name} [${statusLabel}]`);
	lines.push(`Mode: ${state.mode} | Iteration: ${state.iteration + 1}/${state.targetCount}`);
	lines.push("");

	const agents: AgentState[] = Object.values(state.agents);
	if (agents.length === 0) {
		lines.push("  (no agents)");
		return lines;
	}

	for (const agent of agents) {
		const icon = STATUS_LABELS[agent.status] ?? "[????]";
		const duration = formatAgentDuration(agent);
		const errorSuffix = agent.error ? ` - ${truncate(agent.error, 60)}` : "";
		lines.push(`  ${icon} ${agent.name}: ${agent.status}${duration}${errorSuffix}`);
	}

	// Summary line
	const completed = agents.filter(a => a.status === "completed").length;
	const failed = agents.filter(a => a.status === "failed").length;
	const running = agents.filter(a => a.status === "running").length;
	if (state.policy) {
		lines.push("");
		lines.push(`  Policy: ${state.policy.accepted ? "accepted" : "BLOCKED"} at ${state.policy.boundary}`);
		for (const failure of state.policy.failures) {
			lines.push(`  Policy failure: ${failure.source} ${failure.id} - ${truncate(failure.message, 80)}`);
		}
	}

	lines.push("");
	const parts = [`${completed}/${agents.length} done`];
	if (running > 0) parts.push(`${running} running`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (state.startedAt) {
		parts.push(`elapsed: ${formatDuration(Date.now() - state.startedAt)}`);
	}
	lines.push(`  ${parts.join(" | ")}`);

	return lines;
}

function formatAgentDuration(agent: { startedAt?: number; completedAt?: number; status: string }): string {
	if (agent.startedAt && agent.completedAt) {
		return ` (${formatDuration(agent.completedAt - agent.startedAt)})`;
	}
	if (agent.startedAt && (agent.status === "running" || agent.status === "waiting")) {
		return ` (${formatDuration(Date.now() - agent.startedAt)}...)`;
	}
	return "";
}

export function renderSwarmWidgetLine(
	definition: SwarmDefinition,
	state: SwarmState,
	theme: SwarmDashboardTheme,
): string {
	const agents = Object.values(state.agents);
	const completed = agents.filter(agent => agent.status === "completed").length;
	const running = agents.filter(agent => agent.status === "running").length;
	const failed = agents.filter(agent => agent.status === "failed").length;
	const status = styleStatus(state.status, theme);
	const parts = [
		theme.fg("accent", `swarm:${definition.name}`),
		status,
		theme.fg("muted", ` ${completed}/${agents.length}`),
	];
	if (running > 0) parts.push(theme.fg("warning", ` ${running} running`));
	if (failed > 0) parts.push(theme.fg("error", ` ${failed} failed`));
	parts.push(theme.fg("dim", " · Alt+W dashboard"));
	return parts.join("");
}

/** Minimal styling seam so dashboard rendering is testable without a live TUI. */
export interface SwarmDashboardTheme {
	fg(color: string, text: string): string;
}

/**
 * Render the dashboard as a bordered panel. The caller can place this panel
 * anywhere an overlay supports; the graph itself is independent of placement.
 */
export function renderSwarmDashboardPanelLines(
	definition: SwarmDefinition,
	state: SwarmState,
	width: number,
	theme: SwarmDashboardTheme,
	animationFrame = 0,
): string[] {
	const panelWidth = Math.max(12, Math.floor(width));
	const contentWidth = Math.max(8, panelWidth - 2);
	const content = renderSwarmDashboardLines(definition, state, contentWidth, theme, animationFrame);
	const horizontal = "─".repeat(Math.max(0, panelWidth - 2));
	const border = (text: string) => theme.fg("borderMuted", text);
	return [
		border(`╭${horizontal}╮`),
		...content.map(line => {
			const clipped = truncateToWidth(line, contentWidth);
			const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
			return `${border("│")}${clipped}${padding}${border("│")}`;
		}),
		border(`╰${horizontal}╯`),
	];
}

/**
 * Render a compact, layered execution graph followed by live agent details.
 * Nodes are laid out by dependency depth rather than printed as a flat list.
 */
export function renderSwarmDashboardLines(
	definition: SwarmDefinition,
	state: SwarmState,
	width: number,
	theme: SwarmDashboardTheme,
	animationFrame = 0,
): string[] {
	const lines: string[] = [];
	const boundedWidth = Math.max(10, Math.floor(width));
	const title = ` Swarm ${definition.name} `;
	const status = styleStatus(state.status, theme);
	lines.push(truncateToWidth(`${theme.fg("accent", title)} ${status}`, boundedWidth));
	lines.push(
		truncateToWidth(
			theme.fg(
				"dim",
				` mode=${definition.mode} iteration=${Math.min(state.iteration + 1, state.targetCount)}/${state.targetCount}`,
			),
			boundedWidth,
		),
	);
	lines.push(theme.fg("borderMuted", "─".repeat(Math.min(boundedWidth, 80))));
	lines.push(theme.fg("accent", " Execution graph"));
	lines.push(...renderExecutionGraph(definition, state, boundedWidth, theme, animationFrame));

	lines.push("");
	lines.push(theme.fg("accent", " Recent native actions"));
	let actionCount = 0;
	for (const name of definition.agentOrder) {
		const agent = state.agents[name];
		if (!agent) continue;
		const actions = agent.recentTools ?? [];
		if (actions.length === 0 && !agent.currentTool) continue;
		lines.push(
			`  ${theme.fg("muted", name)}${agent.currentTool ? ` ${theme.fg("warning", `· ${agent.currentTool} running`)}` : ""}`,
		);
		for (const action of actions.slice(0, 5)) {
			const args = action.args.trim().length > 0 ? `(${truncate(action.args.trim(), 56)})` : "";
			lines.push(truncateToWidth(`    ${theme.fg("dim", "•")} ${action.tool}${args}`, boundedWidth));
			actionCount++;
		}
	}
	if (actionCount === 0) lines.push(theme.fg("dim", "  No completed tool actions yet."));

	if (state.policy) {
		lines.push("");
		const policyStatus = state.policy.accepted ? "accepted" : "BLOCKED";
		lines.push(
			theme.fg(state.policy.accepted ? "success" : "error", ` Policy ${policyStatus} at ${state.policy.boundary}`),
		);
		for (const failure of state.policy.failures) {
			lines.push(
				truncateToWidth(
					`  ${theme.fg("error", "×")} ${failure.source} ${failure.id}: ${failure.message}`,
					boundedWidth,
				),
			);
		}
	}

	lines.push("");
	lines.push(theme.fg("dim", " q/Esc/Alt+W close · ↑/↓ scroll · live graph"));
	return lines;
}

function styleStatus(status: string, theme: SwarmDashboardTheme): string {
	const color =
		status === "completed"
			? "success"
			: status === "failed" || status === "aborted"
				? "error"
				: status === "running"
					? "warning"
					: status === "waiting"
						? "accent"
						: "dim";
	return theme.fg(color, status);
}
