/**
 * TUI progress rendering for swarm pipeline status.
 */
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, truncate } from "@oh-my-pi/pi-utils";
import type { SwarmDefinition } from "./schema";
import type { AgentState, SwarmState } from "./state";

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

const ANIMATION_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type GraphCell = {
	char: string;
	color?: string;
};

type GraphNodeLayout = {
	name: string;
	layer: number;
	x: number;
	center: number;
	width: number;
	status: string;
};

type GraphEdge = {
	from: string;
	to: string;
};

type GraphLayout = {
	layers: GraphNodeLayout[][];
	nodes: Map<string, GraphNodeLayout>;
	edges: GraphEdge[];
	layerByName: Map<string, number>;
};

function renderExecutionGraph(
	definition: SwarmDefinition,
	state: SwarmState,
	width: number,
	theme: SwarmDashboardTheme,
	animationFrame: number,
): string[] {
	const layout = buildGraphLayout(definition, state, width);
	if (layout.layers.length === 0) return [theme.fg("dim", "  (no agents)")];

	const lines: string[] = [];
	for (let layerIndex = 0; layerIndex < layout.layers.length; layerIndex++) {
		lines.push(...renderNodeLayer(layout.layers[layerIndex], width, theme, animationFrame));
		if (layerIndex < layout.layers.length - 1) {
			lines.push(...renderConnectorRows(layout, layerIndex, width, theme, animationFrame));
		}
	}
	return lines;
}

function buildGraphLayout(definition: SwarmDefinition, state: SwarmState, width: number): GraphLayout {
	const names = [
		...definition.agentOrder.filter(name => definition.agents.has(name)),
		...[...definition.agents.keys()].filter(name => !definition.agentOrder.includes(name)),
	];
	const layerByName = new Map<string, number>();
	const visiting = new Set<string>();

	const depthFor = (name: string): number => {
		const existing = layerByName.get(name);
		if (existing !== undefined) return existing;
		if (visiting.has(name)) return 0;
		visiting.add(name);
		const agent = definition.agents.get(name);
		let depth = 0;
		for (const dependency of agent?.waitsFor ?? []) {
			if (definition.agents.has(dependency)) depth = Math.max(depth, depthFor(dependency) + 1);
		}
		visiting.delete(name);
		layerByName.set(name, depth);
		return depth;
	};

	for (const name of names) depthFor(name);
	const maxLayer = Math.max(-1, ...layerByName.values());
	const layers: GraphNodeLayout[][] = Array.from({ length: maxLayer + 1 }, () => []);
	const maxNodesInLayer = Math.max(
		0,
		...Array.from(
			{ length: maxLayer + 1 },
			(_, layer) => names.filter(name => layerByName.get(name) === layer).length,
		),
	);
	const longestName = Math.max(0, ...names.map(name => visibleWidth(name)));
	const preferredWidth = Math.min(24, Math.max(12, longestName + 4));
	const preferredGap = maxNodesInLayer > 1 ? Math.max(2, Math.min(8, Math.floor(width / (maxNodesInLayer + 1)))) : 0;
	const compactWidth =
		maxNodesInLayer > 0
			? Math.floor((width - preferredGap * (maxNodesInLayer - 1)) / maxNodesInLayer)
			: preferredWidth;
	const nodeWidth = Math.max(8, Math.min(preferredWidth, compactWidth));
	const gap =
		maxNodesInLayer > 1 ? Math.max(1, Math.floor((width - nodeWidth * maxNodesInLayer) / (maxNodesInLayer - 1))) : 0;
	const nodes = new Map<string, GraphNodeLayout>();

	for (let layer = 0; layer <= maxLayer; layer++) {
		const layerNames = names.filter(name => layerByName.get(name) === layer);
		const totalWidth = layerNames.length * nodeWidth + Math.max(0, layerNames.length - 1) * gap;
		const start = Math.max(0, Math.floor((width - totalWidth) / 2));
		layerNames.forEach((name, index) => {
			const x = start + index * (nodeWidth + gap);
			const node: GraphNodeLayout = {
				name,
				layer,
				x,
				center: x + Math.floor(nodeWidth / 2),
				width: nodeWidth,
				status: state.agents[name]?.status ?? "pending",
			};
			layers[layer].push(node);
			nodes.set(name, node);
		});
	}

	const edgeKeys = new Set<string>();
	const edges: GraphEdge[] = [];
	for (const name of names) {
		for (const dependency of definition.agents.get(name)?.waitsFor ?? []) {
			if (!nodes.has(dependency)) continue;
			const key = `${dependency}\0${name}`;
			if (edgeKeys.has(key)) continue;
			edgeKeys.add(key);
			edges.push({ from: dependency, to: name });
		}
	}
	return { layers, nodes, edges, layerByName };
}

function renderNodeLayer(
	nodes: GraphNodeLayout[],
	width: number,
	theme: SwarmDashboardTheme,
	animationFrame: number,
): string[] {
	const rows = [createGraphRow(width), createGraphRow(width), createGraphRow(width)];
	for (const node of nodes) {
		const color = nodeColor(node.status, animationFrame);
		writeGraphText(rows[0], node.x, `╭${"─".repeat(Math.max(0, node.width - 2))}╮`, color);
		writeGraphText(rows[1], node.x, "│", color);
		writeGraphText(rows[1], node.x + node.width - 1, "│", color);
		const label = centerGraphText(`${statusGlyph(node.status, animationFrame)} ${node.name}`, node.width - 2);
		writeGraphText(rows[1], node.x + 1, label, color);
		writeGraphText(rows[2], node.x, `╰${"─".repeat(Math.max(0, node.width - 2))}╯`, color);
	}
	return rows.map(row => renderGraphRow(row, theme));
}

function renderConnectorRows(
	layout: GraphLayout,
	layerIndex: number,
	width: number,
	theme: SwarmDashboardTheme,
	animationFrame: number,
): string[] {
	const rows = [createGraphRow(width), createGraphRow(width)];
	for (const edge of layout.edges) {
		const from = layout.nodes.get(edge.from);
		const to = layout.nodes.get(edge.to);
		if (!from || !to || from.layer > layerIndex || to.layer <= layerIndex) continue;
		const span = Math.max(1, to.layer - from.layer);
		const startProgress = (layerIndex - from.layer) / span;
		const endProgress = (layerIndex + 1 - from.layer) / span;
		const startX = interpolate(from.center, to.center, startProgress);
		const endX = interpolate(from.center, to.center, endProgress);
		const color = edgeColor(from.status, to.status, animationFrame);
		for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
			const progress = (rowIndex + 1) / (rows.length + 1);
			const x = Math.round(interpolate(startX, endX, progress));
			const glyph = connectorGlyph(startX, endX);
			placeGraphCell(rows[rowIndex], x, glyph, color);
		}
	}
	return rows.map(row => renderGraphRow(row, theme));
}

function createGraphRow(width: number): GraphCell[] {
	return Array.from({ length: Math.max(1, width) }, () => ({ char: " " }));
}

function writeGraphText(row: GraphCell[], start: number, text: string, color?: string): void {
	let column = start;
	for (const glyph of Array.from(text)) {
		const glyphWidth = visibleWidth(glyph);
		if (glyphWidth !== 1) continue;
		placeGraphCell(row, column, glyph, color, true);
		column++;
	}
}

function placeGraphCell(row: GraphCell[], column: number, char: string, color?: string, overwrite = false): void {
	if (column < 0 || column >= row.length) return;
	const current = row[column];
	if (overwrite || current.char === " ") {
		row[column] = { char, color };
		return;
	}
	if (current.char === char) {
		current.color = color ?? current.color;
		return;
	}
	current.char = current.char === "│" || char === "│" ? "┼" : "╳";
	current.color = color ?? current.color;
}

function renderGraphRow(row: GraphCell[], theme: SwarmDashboardTheme): string {
	return row
		.map(cell => (cell.char === " " ? cell.char : cell.color ? theme.fg(cell.color, cell.char) : cell.char))
		.join("");
}

function centerGraphText(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(1, width));
	const remaining = Math.max(0, width - visibleWidth(clipped));
	const left = Math.floor(remaining / 2);
	return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
}

function interpolate(from: number, to: number, progress: number): number {
	return from + (to - from) * progress;
}

function connectorGlyph(from: number, to: number): string {
	if (Math.abs(to - from) < 0.5) return "│";
	return to > from ? "╲" : "╱";
}

function nodeColor(status: string, animationFrame: number): string {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
		case "aborted":
			return "error";
		case "running":
			return animationFrame % 2 === 0 ? "warning" : "accent";
		case "waiting":
			return "accent";
		default:
			return "borderMuted";
	}
}

function edgeColor(fromStatus: string, toStatus: string, animationFrame: number): string {
	if (fromStatus === "failed" || toStatus === "failed" || fromStatus === "aborted" || toStatus === "aborted") {
		return "error";
	}
	if (fromStatus === "running" || toStatus === "running") {
		return animationFrame % 2 === 0 ? "warning" : "accent";
	}
	if (fromStatus === "completed" && toStatus === "completed") return "success";
	return "borderMuted";
}

function statusGlyph(status: string | undefined, animationFrame = 0): string {
	switch (status) {
		case "completed":
			return "✓";
		case "running":
			return ANIMATION_FRAMES[Math.abs(animationFrame) % ANIMATION_FRAMES.length] ?? "⠋";
		case "failed":
			return "×";
		case "waiting":
			return "◇";
		case "aborted":
			return "■";
		default:
			return "○";
	}
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
