import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import { type Component, Markdown, type MarkdownTheme, padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatAge } from "@oh-my-pi/pi-utils";

export type BeadsOperation = "show" | "list" | "ready" | "create" | "update" | "claim" | "close" | "dependencies";

export interface BeadsRenderArgs {
	op: BeadsOperation;
	issue_id?: string;
	issue_ids?: string[];
	parent_id?: string;
	title?: string;
	dependency_action?: string;
}

export interface BeadsRenderDetails {
	type?: string;
	operation: BeadsOperation;
	args: readonly string[];
	data: unknown;
}

type BeadsResult = AgentToolResult<BeadsRenderDetails>;
type FrameState = "pending" | "success" | "error";
type RecordValue = Record<string, unknown>;

const EMPTY_COMPONENT: Component = { render: () => [] };
const MAX_COLLAPSED_ISSUES = 3;
const MAX_RENDERED_ISSUES = 100;
const COLLAPSED_MARKDOWN_LIMIT = 1_200;
const ISSUE_DISPLAY_KEYS = new Set([
	"id",
	"title",
	"description",
	"acceptance",
	"acceptance_criteria",
	"status",
	"issue_type",
	"type",
	"priority",
	"assignee",
	"owner",
	"created_at",
	"updated_at",
	"closed_at",
	"started_at",
	"labels",
	"parent_id",
	"parent",
	"dependencies",
	"dependents",
	"deps",
	"notes",
	"close_reason",
	"metadata",
]);

const STATUS_LABELS: Record<string, string> = {
	open: "Lined Up",
	in_progress: "In Progress",
	closed: "Closed",
	blocked: "Blocked",
	deferred: "Deferred",
	cancelled: "Cancelled",
};

const PRIORITY_LABELS: Record<number, string> = {
	0: "Critical",
	1: "High",
	2: "Medium",
	3: "Low",
	4: "Backlog",
};

export function isBeadsRenderDetails(value: unknown): value is BeadsRenderDetails {
	return (
		isRecord(value) &&
		isBeadsOperation(value.operation) &&
		Array.isArray(value.args) &&
		value.args.every(argument => typeof argument === "string") &&
		Object.hasOwn(value, "data")
	);
}

function isBeadsOperation(value: unknown): value is BeadsOperation {
	return (
		value === "show" ||
		value === "list" ||
		value === "ready" ||
		value === "create" ||
		value === "update" ||
		value === "claim" ||
		value === "close" ||
		value === "dependencies"
	);
}

export function renderBeadsCall(args: BeadsRenderArgs, options: ToolRenderResultOptions, theme: Theme): Component {
	if (!options.isPartial) return EMPTY_COMPONENT;
	const header = renderHeader(args, theme, "pending", options.spinnerFrame);
	return framedComponent(theme, header, [], "pending");
}

export function renderBeadsResult(
	result: BeadsResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	args?: BeadsRenderArgs,
): Component {
	const details = isBeadsRenderDetails(result.details) ? result.details : undefined;
	const operation = details?.operation ?? args?.op ?? "show";
	const effectiveArgs = args ?? { op: operation };
	const state: FrameState = result.isError ? "error" : "success";
	const header = renderHeader(effectiveArgs, theme, state);

	if (result.isError) {
		const message = result.content?.find(content => content.type === "text")?.text?.trim() || "Unknown Beads error";
		return framedComponent(theme, header, [new TextComponent(theme.fg("error", message))], state);
	}

	const data = details?.data;
	const summary = summarizeResult(operation, data);
	const summaryLine = `${statusGlyph(theme, state)} ${theme.fg("success", `Completed${summary ? ` · ${summary}` : ""}`)}`;
	const markdown = buildResultMarkdown(data, options.expanded);
	return framedComponent(
		theme,
		header,
		[new TextComponent(summaryLine), new Markdown(markdown, 0, 0, createMarkdownTheme(theme))],
		state,
	);
}

function createMarkdownTheme(theme: Theme): MarkdownTheme {
	return {
		heading: text => theme.fg("mdHeading", text),
		link: text => theme.fg("mdLink", text),
		linkUrl: text => theme.fg("mdLinkUrl", text),
		code: text => theme.fg("mdCode", text),
		codeBlock: text => theme.fg("mdCodeBlock", text),
		codeBlockBorder: text => theme.fg("mdCodeBlockBorder", text),
		quote: text => theme.fg("mdQuote", text),
		quoteBorder: text => theme.fg("mdQuoteBorder", text),
		hr: text => theme.fg("mdHr", text),
		listBullet: text => theme.fg("mdListBullet", text),
		bold: text => theme.bold(text),
		italic: text => theme.italic(text),
		strikethrough: text => theme.strikethrough(text),
		underline: text => theme.underline(text),
		symbols: {
			cursor: theme.nav.cursor,
			inputCursor: theme.getSymbolPreset() === "ascii" ? "|" : "▏",
			boxRound: theme.boxRound,
			boxSharp: theme.boxSharp,
			table: theme.boxSharp,
			quoteBorder: theme.md.quoteBorder,
			hrChar: theme.md.hrChar,
			colorSwatch: theme.md.colorSwatch,
			spinnerFrames: theme.getSpinnerFrames("activity"),
		},
	};
}

function renderHeader(args: BeadsRenderArgs, theme: Theme, state: FrameState, spinnerFrame?: number): string {
	const operation = formatOperation(args);
	const bullet = theme.format.bullet || "•";
	const stateColor = state === "error" ? "error" : state === "success" ? "success" : "borderAccent";
	const marker = state === "pending" ? spinner(theme, spinnerFrame) : bullet;
	return `${theme.fg(stateColor, marker)} ${theme.fg("toolTitle", theme.bold(`Beads ${operation}`))}`;
}

function spinner(theme: Theme, frame?: number): string {
	const frames = theme.spinnerFrames;
	if (frames.length === 0) return theme.format.bullet || "•";
	return (frames[Math.max(0, frame ?? 0) % frames.length] ?? theme.format.bullet) || "•";
}

function statusGlyph(theme: Theme, state: FrameState): string {
	if (state === "error") return theme.fg("error", theme.status.error);
	if (state === "success") return theme.fg("success", theme.status.success);
	return theme.fg("borderAccent", theme.status.pending);
}

function formatOperation(args: BeadsRenderArgs): string {
	switch (args.op) {
		case "show":
			return `${args.op} ${formatIssueIds(args)}`;
		case "list":
			return `${args.op}${args.parent_id ? ` under ${args.parent_id}` : args.title ? ` ${quote(args.title)}` : ""}`;
		case "ready":
			return `${args.op}${args.parent_id ? ` under ${args.parent_id}` : ""}`;
		case "create":
			return `${args.op}${args.title ? ` ${quote(args.title)}` : ""}`;
		case "update":
		case "claim":
		case "close":
			return args.op;
		case "dependencies":
			return `${args.op}${args.dependency_action ? ` ${args.dependency_action}` : ""}`;
	}
}

function formatIssueIds(args: BeadsRenderArgs): string {
	const ids = args.issue_ids?.length ? args.issue_ids : args.issue_id ? [args.issue_id] : [];
	return ids.length > 0 ? ids.join(", ") : "issues";
}

function quote(value: string): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return JSON.stringify(compact.length > 80 ? `${compact.slice(0, 77)}…` : compact);
}

function summarizeResult(operation: BeadsOperation, data: unknown): string {
	if (Array.isArray(data)) return `${data.length} ${data.length === 1 ? "record" : "records"}`;
	if (isRecord(data)) {
		if (typeof data.id === "string") return data.id;
		if (operation === "dependencies" && typeof data.issue_id === "string") return data.issue_id;
		return "1 record";
	}
	return data == null ? "no data" : "1 value";
}

function buildResultMarkdown(data: unknown, expanded: boolean): string {
	const values = Array.isArray(data) ? data : [data];
	const issueValues = values.filter(isIssueRecord);
	if (issueValues.length > 0 && issueValues.length === values.length) {
		const visible = expanded ? issueValues.slice(0, MAX_RENDERED_ISSUES) : issueValues.slice(0, MAX_COLLAPSED_ISSUES);
		const cards = visible.map(value => formatIssueCard(value, expanded));
		const omitted = issueValues.length - visible.length;
		if (omitted > 0) cards.push(`> ${omitted} more issue${omitted === 1 ? "" : "s"}. Press **Ctrl+O** to expand.`);
		if (issueValues.length > MAX_RENDERED_ISSUES) cards.push(`> Output capped at ${MAX_RENDERED_ISSUES} issues.`);
		return cards.join("\n\n---\n\n");
	}

	if (values.length === 1 && typeof values[0] === "string") return values[0];
	return fencedJson(data);
}

function formatIssueCard(issue: RecordValue, expanded: boolean): string {
	const title = stringValue(issue.title) || stringValue(issue.id) || "Bead";
	const lines = [`# ${title}`, ""];
	const facts: string[] = [];
	const id = stringValue(issue.id);
	if (id) facts.push(`**ID:** \`${id}\``);
	const status = stringValue(issue.status);
	if (status) facts.push(`**Status:** ${statusLabel(status)} (\`${status}\`)`);
	const type = stringValue(issue.issue_type) || stringValue(issue.type);
	if (type) facts.push(`**Type:** \`${type}\``);
	const priority = numberValue(issue.priority);
	if (priority !== undefined) facts.push(`**Priority:** P${priority} — ${PRIORITY_LABELS[priority] ?? "Custom"}`);
	const owner = stringValue(issue.assignee) || stringValue(issue.owner);
	if (owner) facts.push(`**Owner:** ${owner}`);
	const createdAt = stringValue(issue.created_at);
	if (createdAt) {
		const age = formatAge(Math.max(0, (Date.now() - Date.parse(createdAt)) / 1000));
		if (age) facts.push(`**Age:** ${age}`);
	}
	if (facts.length > 0) lines.push(facts.join("  \n"), "");

	let detailsCollapsed = false;
	const description = stringValue(issue.description);
	if (description) {
		const renderedDescription = expanded ? description : collapseMarkdown(description);
		detailsCollapsed ||= renderedDescription !== description;
		lines.push("### DESCRIPTION", "", renderedDescription, "");
	}
	const acceptance = stringValue(issue.acceptance_criteria) || stringValue(issue.acceptance);
	if (acceptance) {
		const renderedAcceptance = expanded ? acceptance : collapseMarkdown(acceptance);
		detailsCollapsed ||= renderedAcceptance !== acceptance;
		lines.push("### ACCEPTANCE CRITERIA", "", renderedAcceptance, "");
	}
	const notes = stringValue(issue.notes);
	if (notes) {
		const renderedNotes = expanded ? notes : collapseMarkdown(notes);
		detailsCollapsed ||= renderedNotes !== notes;
		lines.push("### NOTES", "", renderedNotes, "");
	}
	const closeReason = stringValue(issue.close_reason);
	if (closeReason) lines.push("### CLOSE REASON", "", closeReason, "");

	const dependencies = issue.dependencies ?? issue.deps ?? issue.dependents;
	if (Array.isArray(dependencies) && dependencies.length > 0) {
		lines.push("### DEPENDENCIES", "", ...dependencies.map(dependency => `- ${formatDependency(dependency)}`), "");
	}

	const metadata = collectMetadata(issue);
	if (Object.keys(metadata).length > 0) lines.push("### METADATA", "", fencedJson(metadata), "");
	if (detailsCollapsed) lines.push("> Press **Ctrl+O** to expand full details.", "");
	return lines.join("\n").trim();
}

function collectMetadata(issue: RecordValue): RecordValue {
	const metadata: RecordValue = {};
	if (isRecord(issue.metadata)) Object.assign(metadata, issue.metadata);
	for (const [key, value] of Object.entries(issue)) {
		if (!ISSUE_DISPLAY_KEYS.has(key)) metadata[key] = value;
	}
	for (const key of ["created_at", "updated_at", "closed_at", "started_at", "parent_id", "parent", "labels"]) {
		if (issue[key] !== undefined) metadata[key] = issue[key];
	}
	return metadata;
}

function formatDependency(value: unknown): string {
	if (typeof value === "string") return `\`${value}\``;
	if (!isRecord(value)) return `\`${String(value)}\``;
	const id = stringValue(value.id) || stringValue(value.issue_id) || stringValue(value.depends_on_id) || "dependency";
	const type = stringValue(value.type) || stringValue(value.dependency_type);
	return type ? `\`${id}\` (${type})` : `\`${id}\``;
}

function collapseMarkdown(value: string): string {
	if (value.length <= COLLAPSED_MARKDOWN_LIMIT) return value;
	let shortened = `${value.slice(0, COLLAPSED_MARKDOWN_LIMIT).trimEnd()}\n\n…`;
	if ((shortened.match(/```/g)?.length ?? 0) % 2 !== 0) shortened += "\n\n```";
	return shortened;
}

function fencedJson(value: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value, null, 2) ?? "null";
	} catch {
		serialized = JSON.stringify(String(value), null, 2);
	}
	return `\`\`\`json\n${serialized}\n\`\`\``;
}

function statusLabel(status: string): string {
	return STATUS_LABELS[status] ?? status.replace(/[_-]+/g, " ").replace(/\b\w/g, character => character.toUpperCase());
}

function isIssueRecord(value: unknown): value is RecordValue {
	return (
		isRecord(value) &&
		["id", "title", "description", "acceptance_criteria", "issue_type", "status", "priority"].some(
			key => key in value,
		)
	);
}

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

class TextComponent implements Component {
	readonly #text: string;

	constructor(text: string) {
		this.#text = text;
	}

	render(): readonly string[] {
		return [this.#text];
	}
}

function framedComponent(theme: Theme, header: string, children: Component[], state: FrameState): Component {
	return {
		render(width: number): readonly string[] {
			const safeWidth = Math.max(8, width);
			const innerWidth = Math.max(1, safeWidth - 4);
			const bodyLines = children.flatMap(child => child.render(innerWidth));
			const horizontal = theme.boxRound.horizontal || "─";
			const vertical = theme.boxRound.vertical;
			const borderColor = state === "error" ? "error" : state === "success" ? "borderAccent" : "borderMuted";
			const paintBorder = (text: string) => theme.fg(borderColor, text);
			const available = safeWidth - 2;
			const rawTitle = truncateToWidth(header, available, "");
			const title = rawTitle.length > 0 ? ` ${rawTitle} ` : rawTitle;
			const titleWidth = Math.min(visibleWidth(title), available);
			const remaining = Math.max(0, available - titleWidth);
			const leftRule = remaining > 0 ? Math.min(3, Math.max(1, Math.floor(remaining / 2))) : 0;
			const rightRule = Math.max(0, remaining - leftRule);
			const top = `${paintBorder(theme.boxRound.topLeft + horizontal.repeat(leftRule))}${title}${paintBorder(horizontal.repeat(rightRule) + theme.boxRound.topRight)}`;
			const rows = [top];
			for (const line of bodyLines) {
				const content = truncateToWidth(line, innerWidth, "", true);
				const contentWidth = visibleWidth(content);
				rows.push(
					`${paintBorder(vertical)}${padding(1)}${content}${padding(Math.max(0, innerWidth - contentWidth))}${padding(1)}${paintBorder(vertical)}`,
				);
			}
			rows.push(paintBorder(theme.boxRound.bottomLeft + horizontal.repeat(available) + theme.boxRound.bottomRight));
			return rows;
		},
		invalidate(): void {
			for (const child of children) child.invalidate?.();
		},
	};
}
