import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import {
	type Canvas,
	canvas,
	formatCanvas,
	line,
	STYLE_THIN_ROUNDED,
	setAt,
	strokeRect,
	textLine,
} from "@thi.ng/text-canvas";
import { type Graph, graphConnect, type LayoutResult, shapeRect, sugiyama, tweakShape } from "d3-dag";
import type { SwarmDefinition } from "../definition/schema";
import type { SwarmState } from "../execution/state";

const GRAPH_NODE_HEIGHT = 3;
const MIN_GRAPH_NODE_WIDTH = 8;
const MAX_GRAPH_NODE_WIDTH = 24;
const DENSE_GRAPH_THRESHOLD = 8;
const DENSE_GRAPH_GAP_Y = 3;
const DIRECTION_NORTH = 1;
const DIRECTION_SOUTH = 2;
const DIRECTION_WEST = 4;
const DIRECTION_EAST = 8;

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
type DenseConnectorCell = {
	directions: number;
	format: GraphColor;
	priority: number;
	order: number;
};

/**
 * Render the execution dependency graph with a d3-dag layout and a text canvas.
 * Dense graphs use merged rounded orthogonal connectors so shared paths remain
 * continuous and active links remain visually distinct.
 */
export function renderExecutionGraph(
	definition: SwarmDefinition,
	state: SwarmState,
	width: number,
	theme: GraphTheme,
	animationFrame: number,
): string[] {
	const names = orderedAgentNames(definition);
	const denseGraph = names.length >= DENSE_GRAPH_THRESHOLD;
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

		const nodeWidth = graphNodeWidth(names, width);
		const nodeSize: readonly [number, number] = [nodeWidth, GRAPH_NODE_HEIGHT];
		const layout = sugiyama()
			.nodeSize(nodeSize)
			.gap([Math.max(1, Math.min(6, Math.floor(width / 12))), denseGraph ? DENSE_GRAPH_GAP_Y : 2])
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

		if (denseGraph) {
			const connectorCells = new Map<number, DenseConnectorCell>();
			let edgeOrder = 0;
			for (const link of graph.links()) {
				if (link.source.data === link.target.data) continue;
				const source = positionedNodes.get(link.source.data);
				const target = positionedNodes.get(link.target.data);
				if (!source || !target) continue;
				const fromStatus = state.agents[link.source.data]?.status ?? "pending";
				const toStatus = state.agents[link.target.data]?.status ?? "pending";
				const edgeId = `${link.source.data}\0${link.target.data}`;
				const color = edgeColor(fromStatus, toStatus, animationFrame, edgeId);
				addDenseConnector(
					connectorCells,
					denseConnectorRoute(source, target),
					color,
					isActiveEdge(fromStatus, toStatus) ? 2 : 1,
					edgeOrder++,
					surface.width,
					surface.height,
				);
			}
			renderDenseConnectors(surface, connectorCells);
		} else {
			for (const link of graph.links()) {
				const fromStatus = state.agents[link.source.data]?.status ?? "pending";
				const toStatus = state.agents[link.target.data]?.status ?? "pending";
				const edgeId = `${link.source.data}\0${link.target.data}`;
				const color = edgeColor(fromStatus, toStatus, animationFrame, edgeId);
				for (let index = 1; index < link.points.length; index++) {
					const from = toCanvasPoint(link.points[index - 1] as GraphPoint);
					const to = toCanvasPoint(link.points[index] as GraphPoint);
					line(surface, from[0], from[1], to[0], to[1], connectorGlyph(from, to), GRAPH_FORMATS[color]);
				}
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
	const color = nodeColor(node.status, animationFrame, node.name);
	const format = GRAPH_FORMATS[color];
	const x = node.x - Math.floor(node.width / 2);
	const y = node.y - Math.floor(GRAPH_NODE_HEIGHT / 2);
	strokeRect(surface, x, y, node.width, GRAPH_NODE_HEIGHT, format);
	const label = centerGraphText(`${statusGlyph(node.status, animationFrame, node.name)} ${node.name}`, node.width - 2);
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

function denseConnectorRoute(source: PositionedNode, target: PositionedNode): GraphPoint[] {
	const sourceY = source.y + Math.floor(GRAPH_NODE_HEIGHT / 2) + 1;
	const targetY = target.y - Math.floor(GRAPH_NODE_HEIGHT / 2) - 1;
	if (source.x === target.x)
		return [
			[source.x, sourceY],
			[target.x, targetY],
		];
	const laneY = Math.round((sourceY + targetY) / 2);
	return [
		[source.x, sourceY],
		[source.x, laneY],
		[target.x, laneY],
		[target.x, targetY],
	];
}

function addDenseConnector(
	cells: Map<number, DenseConnectorCell>,
	route: readonly GraphPoint[],
	format: GraphColor,
	priority: number,
	order: number,
	width: number,
	height: number,
): void {
	for (let index = 1; index < route.length; index++) {
		addDenseSegment(cells, route[index - 1], route[index], format, priority, order, width, height);
	}
}

function addDenseSegment(
	cells: Map<number, DenseConnectorCell>,
	from: GraphPoint,
	to: GraphPoint,
	format: GraphColor,
	priority: number,
	order: number,
	width: number,
	height: number,
): void {
	const dx = Math.sign(to[0] - from[0]);
	const dy = Math.sign(to[1] - from[1]);
	if (dx !== 0 && dy !== 0) {
		const bend: GraphPoint = [from[0], to[1]];
		addDenseSegment(cells, from, bend, format, priority, order, width, height);
		addDenseSegment(cells, bend, to, format, priority, order, width, height);
		return;
	}
	const length = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]));
	if (length === 0) return;
	for (let step = 0; step <= length; step++) {
		const x = Math.round(from[0] + dx * step);
		const y = Math.round(from[1] + dy * step);
		if (x < 0 || y < 0 || x >= width || y >= height) continue;
		let directions = 0;
		if (step > 0)
			directions |= dx > 0 ? DIRECTION_WEST : dx < 0 ? DIRECTION_EAST : dy > 0 ? DIRECTION_NORTH : DIRECTION_SOUTH;
		if (step < length)
			directions |= dx > 0 ? DIRECTION_EAST : dx < 0 ? DIRECTION_WEST : dy > 0 ? DIRECTION_SOUTH : DIRECTION_NORTH;
		addDenseCell(cells, x + y * width, directions, format, priority, order);
	}
}

function addDenseCell(
	cells: Map<number, DenseConnectorCell>,
	index: number,
	directions: number,
	format: GraphColor,
	priority: number,
	order: number,
): void {
	const existing = cells.get(index);
	if (!existing) {
		cells.set(index, { directions, format, priority, order });
		return;
	}
	existing.directions |= directions;
	if (priority > existing.priority || (priority === existing.priority && order > existing.order)) {
		existing.format = format;
		existing.priority = priority;
		existing.order = order;
	}
}

function renderDenseConnectors(surface: Canvas, cells: ReadonlyMap<number, DenseConnectorCell>): void {
	for (const [index, cell] of cells) {
		const x = index % surface.width;
		const y = Math.floor(index / surface.width);
		const glyph = denseConnectorGlyph(cell.directions);
		if (glyph) setAt(surface, x, y, glyph, GRAPH_FORMATS[cell.format]);
	}
}

function denseConnectorGlyph(directions: number): string {
	switch (directions) {
		case DIRECTION_NORTH:
		case DIRECTION_SOUTH:
		case DIRECTION_NORTH | DIRECTION_SOUTH:
			return "│";
		case DIRECTION_WEST:
		case DIRECTION_EAST:
		case DIRECTION_WEST | DIRECTION_EAST:
			return "─";
		case DIRECTION_NORTH | DIRECTION_EAST:
			return "╰";
		case DIRECTION_NORTH | DIRECTION_WEST:
			return "╯";
		case DIRECTION_SOUTH | DIRECTION_EAST:
			return "╭";
		case DIRECTION_SOUTH | DIRECTION_WEST:
			return "╮";
		case DIRECTION_NORTH | DIRECTION_SOUTH | DIRECTION_EAST:
			return "├";
		case DIRECTION_NORTH | DIRECTION_SOUTH | DIRECTION_WEST:
			return "┤";
		case DIRECTION_WEST | DIRECTION_EAST | DIRECTION_SOUTH:
			return "┬";
		case DIRECTION_WEST | DIRECTION_EAST | DIRECTION_NORTH:
			return "┴";
		case DIRECTION_NORTH | DIRECTION_SOUTH | DIRECTION_WEST | DIRECTION_EAST:
			return "┼";
		default:
			return "";
	}
}

function isActiveEdge(fromStatus: string, toStatus: string): boolean {
	return fromStatus === "running" || toStatus === "running";
}

function animationOffset(identity: string): number {
	let hash = 2166136261;
	for (let index = 0; index < identity.length; index++) {
		hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
	}
	return hash >>> 0;
}

function animationTick(animationFrame: number, identity: string): number {
	return animationFrame + (animationOffset(identity) % 10);
}

function nodeColor(status: string, animationFrame: number, identity = ""): GraphColor {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
		case "aborted":
			return "error";
		case "running":
			return activeAnimationColor(animationFrame, `node:${identity}`);
		case "waiting":
			return "accent";
		default:
			return "borderMuted";
	}
}

function edgeColor(fromStatus: string, toStatus: string, animationFrame: number, identity: string): GraphColor {
	if (fromStatus === "failed" || toStatus === "failed" || fromStatus === "aborted" || toStatus === "aborted") {
		return "error";
	}
	if (isActiveEdge(fromStatus, toStatus)) {
		return activeAnimationColor(animationFrame, `edge:${identity}`);
	}
	if (fromStatus === "completed" && toStatus === "completed") return "success";
	return "borderMuted";
}

function activeAnimationColor(animationFrame: number, identity: string): GraphColor {
	const offset = animationOffset(identity);
	const cadence = 2 + (offset % 3);
	return Math.floor((animationFrame + offset) / cadence) % 2 === 0 ? "warning" : "accent";
}

function centerGraphText(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(1, width));
	const remaining = Math.max(0, width - visibleWidth(clipped));
	const left = Math.floor(remaining / 2);
	return `${" ".repeat(left)}${clipped}${" ".repeat(remaining - left)}`;
}

function statusGlyph(status: string | undefined, animationFrame = 0, identity = ""): string {
	switch (status) {
		case "completed":
			return "✓";
		case "running":
			return (
				["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][
					animationTick(animationFrame, `node:${identity}`) % 10
				] ?? "⠋"
			);
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
