import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { type Canvas, canvas, formatCanvas, line, STYLE_THIN_ROUNDED, strokeRect, textLine } from "@thi.ng/text-canvas";
import { type Graph, graphConnect, type LayoutResult, shapeRect, sugiyama, tweakShape } from "d3-dag";
import type { SwarmDefinition } from "../definition/schema";
import type { SwarmState } from "../execution/state";

const GRAPH_NODE_HEIGHT = 3;
const MIN_GRAPH_NODE_WIDTH = 8;
const MAX_GRAPH_NODE_WIDTH = 24;
const DENSE_GRAPH_THRESHOLD = 8;

const GRAPH_FORMATS = {
	borderMuted: 1,
	success: 2,
	error: 3,
	warning: 4,
	accent: 5,
	dim: 6,
} as const;

type GraphColor = keyof typeof GRAPH_FORMATS;

type GraphTheme = {
	fg(color: string, text: string): string;
};

type GraphPoint = readonly [number, number];

type PositionedNode = {
	name: string;
	status: string;
	x: number;
	y: number;
	width: number;
};

/**
 * Render the execution dependency graph. Small graphs use the d3-dag canvas
 * layout; dense graphs use compact dependency rows to avoid connector overlap.
 * Both paths preserve status styling and width-bounded output.
 */
export function renderExecutionGraph(
	definition: SwarmDefinition,
	state: SwarmState,
	width: number,
	theme: GraphTheme,
	animationFrame: number,
): string[] {
	const names = orderedAgentNames(definition);
	if (names.length === 0) return [theme.fg("dim", truncateToWidth("  (no agents)", Math.max(1, Math.floor(width))))];

	const links: [string, string][] = [];
	const linkKeys = new Set<string>();
	let invalidSelfDependency: string | undefined;
	for (const name of names) {
		const agent = definition.agents.get(name);
		for (const dependency of agent?.waitsFor ?? []) {
			if (dependency === name) {
				invalidSelfDependency = name;
				continue;
			}
			if (!definition.agents.has(dependency)) continue;
			const key = `${dependency}\0${name}`;
			if (linkKeys.has(key)) continue;
			linkKeys.add(key);
			links.push([dependency, name]);
		}
	}

	if (invalidSelfDependency !== undefined) {
		return graphFailure(
			`Dependency cycle prevents graph layout: '${invalidSelfDependency}' waits for itself.`,
			width,
			theme,
		);
	}

	const linkedNames = new Set(links.flat());
	for (const name of names) {
		if (!linkedNames.has(name)) links.push([name, name]);
	}

	try {
		const graph = graphConnect().single(true)(links);
		if (!graph.acyclic()) {
			return graphFailure("Dependency cycle prevents graph layout.", width, theme);
		}
		if (names.length >= DENSE_GRAPH_THRESHOLD) {
			return renderDenseGraph(names, definition, state, width, theme, animationFrame);
		}

		const nodeWidth = graphNodeWidth(names, width);
		const nodeSize: readonly [number, number] = [nodeWidth, GRAPH_NODE_HEIGHT];
		const layout = sugiyama()
			.nodeSize(nodeSize)
			.gap([Math.max(1, Math.min(6, Math.floor(width / 12))), 2])
			.tweaks([tweakShape(nodeSize, shapeRect)]);
		const layoutGraph = layout as unknown as (input: Graph<string, [string, string]>) => LayoutResult;
		const dimensions = layoutGraph(graph);
		const scaleX = dimensions.width > width ? Math.max(0.5, (width - 1) / dimensions.width) : 1;
		const renderedNodeWidth = Math.max(MIN_GRAPH_NODE_WIDTH, Math.round(nodeWidth * scaleX));
		const graphWidth = dimensions.width * scaleX;
		const offsetX = Math.max(0, Math.floor((width - graphWidth) / 2));
		const toCanvasPoint = ([x, y]: GraphPoint): GraphPoint => [Math.round(x * scaleX + offsetX), Math.round(y)];
		const surface = canvas(
			Math.max(1, Math.floor(width)),
			Math.max(1, Math.ceil(dimensions.height) + 1),
			undefined,
			STYLE_THIN_ROUNDED,
		);
		const positionedNodes = new Map<string, PositionedNode>();

		for (const node of graph.nodes()) {
			const [x, y] = toCanvasPoint([node.x, node.y]);
			positionedNodes.set(node.data, {
				name: node.data,
				status: state.agents[node.data]?.status ?? "pending",
				x,
				y,
				width: renderedNodeWidth,
			});
		}

		for (const link of graph.links()) {
			const fromStatus = state.agents[link.source.data]?.status ?? "pending";
			const toStatus = state.agents[link.target.data]?.status ?? "pending";
			const color = edgeColor(fromStatus, toStatus, animationFrame);
			for (let index = 1; index < link.points.length; index++) {
				const from = toCanvasPoint(link.points[index - 1] as GraphPoint);
				const to = toCanvasPoint(link.points[index] as GraphPoint);
				line(surface, from[0], from[1], to[0], to[1], connectorGlyph(from, to), GRAPH_FORMATS[color]);
			}
		}

		for (const name of names) {
			const node = positionedNodes.get(name);
			if (!node) continue;
			renderNode(surface, node, animationFrame);
		}

		return colorizeCanvas(surface, theme);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return graphFailure(`Unable to lay out execution graph: ${detail}`, width, theme);
	}
}

function graphFailure(message: string, width: number, theme: GraphTheme): string[] {
	return [theme.fg("error", truncateToWidth(`  ${message}`, Math.max(1, Math.floor(width))))];
}

function renderDenseGraph(
	names: readonly string[],
	definition: SwarmDefinition,
	state: SwarmState,
	width: number,
	theme: GraphTheme,
	animationFrame: number,
): string[] {
	const boundedWidth = Math.max(1, Math.floor(width));
	const depths = new Map<string, number>();
	const depthOf = (name: string): number => {
		const cached = depths.get(name);
		if (cached !== undefined) return cached;
		const dependencies =
			definition.agents.get(name)?.waitsFor.filter(dependency => definition.agents.has(dependency)) ?? [];
		const depth =
			dependencies.length === 0 ? 0 : Math.max(...dependencies.map(dependency => depthOf(dependency))) + 1;
		depths.set(name, depth);
		return depth;
	};

	for (const name of names) depthOf(name);

	const lines = [theme.fg("dim", truncateToWidth(`  Dense dependency map · ${names.length} agents`, boundedWidth))];
	const maxDepth = Math.max(...names.map(name => depths.get(name) ?? 0));
	for (let depth = 0; depth <= maxDepth; depth++) {
		const layer = names.filter(name => depths.get(name) === depth);
		if (layer.length === 0) continue;
		lines.push(theme.fg("dim", truncateToWidth(`  Layer ${depth + 1}`, boundedWidth)));
		for (const [index, name] of layer.entries()) {
			const agent = definition.agents.get(name);
			const dependencies = agent?.waitsFor.filter(dependency => definition.agents.has(dependency)) ?? [];
			const status = state.agents[name]?.status ?? "pending";
			const branch = depth === 0 ? "  " : index === layer.length - 1 ? "  └─ " : "  ├─ ";
			const node = theme.fg(
				nodeColor(status, animationFrame),
				`${branch}${statusGlyph(status, animationFrame)} ${name}`,
			);
			const dependencyText = dependencies.length > 0 ? theme.fg("dim", ` ← ${dependencies.join(", ")}`) : "";
			lines.push(truncateToWidth(`${node}${dependencyText}`, boundedWidth));
		}
	}
	return lines;
}

function orderedAgentNames(definition: SwarmDefinition): string[] {
	const ordered = definition.agentOrder.filter(name => definition.agents.has(name));
	const remaining = [...definition.agents.keys()]
		.filter(name => !definition.agentOrder.includes(name))
		.sort((a, b) => a.localeCompare(b));
	return [...ordered, ...remaining];
}

function graphNodeWidth(names: readonly string[], width: number): number {
	const longestName = Math.max(0, ...names.map(name => visibleWidth(name)));
	return Math.min(
		MAX_GRAPH_NODE_WIDTH,
		Math.max(MIN_GRAPH_NODE_WIDTH, Math.min(Math.max(1, Math.floor(width)), longestName + 4)),
	);
}

function renderNode(surface: Canvas, node: PositionedNode, animationFrame: number): void {
	const color = nodeColor(node.status, animationFrame);
	const format = GRAPH_FORMATS[color];
	const x = node.x - Math.floor(node.width / 2);
	const y = node.y - Math.floor(GRAPH_NODE_HEIGHT / 2);
	strokeRect(surface, x, y, node.width, GRAPH_NODE_HEIGHT, format);
	const label = centerGraphText(`${statusGlyph(node.status, animationFrame)} ${node.name}`, node.width - 2);
	textLine(surface, x + 1, y + 1, label, format);
}

function colorizeCanvas(surface: Canvas, theme: GraphTheme): string[] {
	const plainRows = formatCanvas(surface).split("\n");
	if (plainRows.at(-1) === "") plainRows.pop();
	return plainRows.map((plain, rowIndex) => {
		const chunks: string[] = [];
		let activeColor: GraphColor | undefined;
		let chunk = "";
		const flush = () => {
			if (chunk.length === 0) return;
			chunks.push(activeColor ? theme.fg(activeColor, chunk) : chunk);
			chunk = "";
		};
		for (let column = 0; column < surface.width; column++) {
			const encoded = surface.data[column + rowIndex * surface.width] ?? 0;
			const color = graphColor(encoded >>> 16);
			if (color !== activeColor) {
				flush();
				activeColor = color;
			}
			chunk += plain[column] ?? " ";
		}
		flush();
		return chunks.join("");
	});
}

function graphColor(format: number): GraphColor | undefined {
	for (const [color, value] of Object.entries(GRAPH_FORMATS)) {
		if (value === format) return color as GraphColor;
	}
	return undefined;
}

function connectorGlyph(from: GraphPoint, to: GraphPoint): string {
	if (Math.abs(to[0] - from[0]) < 0.5) return "│";
	return to[0] > from[0] ? "╲" : "╱";
}

function nodeColor(status: string, animationFrame: number): GraphColor {
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

function edgeColor(fromStatus: string, toStatus: string, animationFrame: number): GraphColor {
	if (fromStatus === "failed" || toStatus === "failed" || fromStatus === "aborted" || toStatus === "aborted") {
		return "error";
	}
	if (fromStatus === "running" || toStatus === "running") {
		return animationFrame % 2 === 0 ? "warning" : "accent";
	}
	if (fromStatus === "completed" && toStatus === "completed") return "success";
	return "borderMuted";
}

function centerGraphText(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(1, width));
	const remaining = Math.max(0, width - visibleWidth(clipped));
	const left = Math.floor(remaining / 2);
	return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
}

function statusGlyph(status: string | undefined, animationFrame = 0): string {
	switch (status) {
		case "completed":
			return "✓";
		case "running":
			return ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][Math.abs(animationFrame) % 10] ?? "⠋";
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
