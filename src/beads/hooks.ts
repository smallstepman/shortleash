import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AgentToolResult,
	BashRenderArgs,
	BashToolCallEvent,
	BashToolDetails,
	BashToolResultEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	UserBashEvent,
} from "@oh-my-pi/pi-coding-agent";
import { bashToolRenderer } from "@oh-my-pi/pi-coding-agent";
import type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { Component } from "@oh-my-pi/pi-tui";
import { hasSwarmMetadata, validateSwarmMetadata } from "../orchestration/definition/metadata";
import { type BeadsIssueRecord, extractBeadsData, extractBeadsIssueRecords } from "./client";
import {
	type BeadsRenderArgs,
	type BeadsRenderDetails,
	isBeadsRenderDetails,
	renderBeadsCall,
	renderBeadsResult,
} from "./render";

const BEADS_JSON_FLAG = "--json";
const BEADS_SHOW_CARD_TYPE = "shortleash-beads-show";
const BEADS_CLAIM_MESSAGE_TYPE = "shortleash-beads-claim";
const BEADS_COMMAND_TIMEOUT_MS = 10_000;
const MAX_CARD_VALUE_LENGTH = 2_000;
const MAX_CARD_OUTPUT_LENGTH = 12_000;

export type BeadsClaimHookHandler = (issueId: string, ctx: ExtensionContext, signal: AbortSignal) => Promise<unknown>;

export interface BeadsHookOptions {
	onClaim?: BeadsClaimHookHandler;
}

export interface ParsedBeadsCommand {
	args: string[];
}

interface PendingShow {
	command: string;
	args: string[];
}

interface PendingClaim {
	issueId: string;
	command: string;
}

interface BeadsHookState {
	pendingShows: Map<string, PendingShow>;
	pendingClaims: Map<string, PendingClaim>;
	runningClaims: Set<string>;
}

interface ClaimTarget {
	issueId: string;
}

interface ExecResultLike {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}
export function registerBeadsHooks(pi: ExtensionAPI, options: BeadsHookOptions = {}): void {
	const state: BeadsHookState = {
		pendingShows: new Map(),
		pendingClaims: new Map(),
		runningClaims: new Set(),
	};

	registerBeadsBashTool(pi);

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		return handleAgentBashCall(pi, state, options, event as BashToolCallEvent, ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		return handleAgentBashResult(pi, state, options, event as BashToolResultEvent, ctx);
	});

	pi.on("user_bash", async (event, ctx) => handleUserBash(pi, state, options, event, ctx));
}

function registerBeadsBashTool(pi: ExtensionAPI): void {
	if (typeof pi.registerTool !== "function" || typeof pi.zod?.object !== "function") return;
	const bashParameters = pi.zod
		.object({
			command: pi.zod.string(),
			env: pi.zod.record(pi.zod.string(), pi.zod.string()).optional(),
			timeout: pi.zod.number().optional(),
			cwd: pi.zod.string().optional(),
			pty: pi.zod.boolean().optional(),
			async: pi.zod.boolean().optional(),
		})
		.strict();
	const definition: ToolDefinition<typeof bashParameters, BeadsRenderDetails> & { mergeCallAndResult: true } = {
		name: "bash",
		label: "Bash",
		description: "Execute a shell command in the current workspace.",
		parameters: bashParameters,
		loadMode: "essential",
		strict: true,
		mergeCallAndResult: true,
		approval: "exec",
		renderCall: (args, renderOptions, theme) => {
			const parsed = parseBeadsCommand(args.command);
			if (parsed && isShowCommand(parsed.args)) {
				return renderBeadsCall(toBeadsRenderArgs(parsed.args), renderOptions, theme);
			}
			return bashToolRenderer.renderCall?.(args, renderOptions, theme) ?? EMPTY_COMPONENT;
		},
		renderResult: (result, renderOptions, theme, args) => {
			const parsed = parseBeadsCommand(args?.command ?? "");
			if (parsed && isShowCommand(parsed.args)) {
				const details = isBeadsRenderDetails(result.details)
					? result.details
					: {
							type: BEADS_SHOW_CARD_TYPE,
							operation: "show" as const,
							args: parsed.args,
							data: textContent(result.content),
						};
				return renderBeadsResult(
					{ ...result, details } as AgentToolResult<BeadsRenderDetails>,
					renderOptions,
					theme,
					toBeadsRenderArgs(parsed.args),
				);
			}
			return (
				bashToolRenderer.renderResult?.(
					result as AgentToolResult<BashToolDetails>,
					renderOptions,
					theme,
					args as BashRenderArgs,
				) ?? EMPTY_COMPONENT
			);
		},
		async execute(_toolCallId, input, signal, onUpdate, ctx) {
			if (!ctx.invokeTool) throw new Error("Bash native delegation is unavailable");
			return ctx.invokeTool(input as Record<string, unknown>, { signal, onUpdate });
		},
	};
	pi.registerTool(definition);
}

const EMPTY_COMPONENT: Component = { render: () => [] };
function isShowCommand(args: readonly string[]): boolean {
	return args[0] === "show" && !args.includes("--watch");
}

function toBeadsRenderArgs(args: readonly string[]): BeadsRenderArgs {
	const issueIds = args.slice(1).filter(argument => !argument.startsWith("-"));
	return {
		op: "show",
		issue_id: issueIds[0],
		issue_ids: issueIds.length > 1 ? issueIds : undefined,
	};
}

/** Parse only a single, direct `bd ...` command; complex shell syntax is deliberately ignored. */
export function parseBeadsCommand(command: string): ParsedBeadsCommand | undefined {
	const tokens = tokenizeSimpleShell(command);
	if (!tokens || tokens.length === 0 || tokens[0] !== "bd") return undefined;
	return { args: tokens.slice(1) };
}

/** Format JSON returned by `bd show --json` as a compact, readable issue card. */
export function formatBeadsShowCard(data: unknown): string {
	const normalized = extractBeadsData(data);
	const records = extractBeadsIssueRecords(normalized);
	if (records.length === 0) {
		return truncateCard(`┌─ Beads show ─\n│ ${formatValue(normalized)}\n└─`);
	}

	const rawRecords = Array.isArray(normalized) ? normalized : [normalized];
	const cards = records.map((record, index) => formatIssueCard(record, rawRecords[index]));
	return truncateCard(cards.join("\n\n"));
}

function tokenizeSimpleShell(command: string): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let started = false;

	const push = (): void => {
		if (!started) return;
		tokens.push(current);
		current = "";
		started = false;
	};

	for (const character of command.trim()) {
		if (escaped) {
			current += character;
			started = true;
			escaped = false;
			continue;
		}
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			else current += character;
			started = true;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			started = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character)) {
			push();
			continue;
		}
		if (";&|<>`$(){}".includes(character) || character === "#" || "*?[]".includes(character)) {
			return undefined;
		}
		current += character;
		started = true;
	}

	if (quote !== undefined || escaped) return undefined;
	push();
	return tokens;
}

async function handleAgentBashCall(
	pi: ExtensionAPI,
	state: BeadsHookState,
	options: BeadsHookOptions,
	event: BashToolCallEvent,
	ctx: ExtensionContext,
): Promise<{ block?: boolean; reason?: string; input?: Record<string, unknown> } | undefined> {
	if (event.input.pty === true || event.input.async === true) return undefined;
	const parsed = parseBeadsCommand(event.input.command);
	if (!parsed) return undefined;
	const cwd = event.input.cwd ?? ctx.cwd;
	const metadataError = await validateMetadataMutation(parsed.args, cwd);
	if (metadataError) return block(metadataError);

	if (isShowCommand(parsed.args)) {
		state.pendingShows.set(event.toolCallId, { command: event.input.command, args: parsed.args });
		return undefined;
	}

	if (options.onClaim && isClaimCommand(parsed.args)) {
		const target = await inspectClaimTarget(pi, parsed.args, cwd);
		if (typeof target === "string") return block(target);
		if (target) {
			state.pendingClaims.set(event.toolCallId, { issueId: target.issueId, command: event.input.command });
			return {
				input: {
					...event.input,
					command: parsed.args.includes(BEADS_JSON_FLAG)
						? event.input.command
						: appendJsonFlag(event.input.command),
				},
			};
		}
	}

	return undefined;
}
async function handleAgentBashResult(
	pi: ExtensionAPI,
	state: BeadsHookState,
	options: BeadsHookOptions,
	event: BashToolResultEvent,
	ctx: ExtensionContext,
): Promise<{ content?: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean } | undefined> {
	const show = state.pendingShows.get(event.toolCallId);
	if (show) {
		state.pendingShows.delete(event.toolCallId);
		const cwd = typeof event.input.cwd === "string" ? event.input.cwd : ctx.cwd;
		const result = await executeDirectBd(pi, show.args, cwd);
		if (result.code !== 0) {
			return {
				content: [
					{
						type: "text",
						text: combineExecOutput(result) || `bd exited with ${result.code}`,
					},
				],
				isError: true,
			};
		}
		const data = parseJson(result.stdout);
		if (data === undefined) {
			return {
				content: [{ type: "text", text: combineExecOutput(result) || textContent(event.content) }],
			};
		}
		const normalized = extractBeadsData(data);
		return {
			content: [{ type: "text", text: formatBeadsShowCard(data) }],
			details: {
				type: BEADS_SHOW_CARD_TYPE,
				operation: "show",
				args: show.args,
				data: normalized,
			} satisfies BeadsRenderDetails,
		};
	}

	const claim = state.pendingClaims.get(event.toolCallId);
	if (!claim) return undefined;
	state.pendingClaims.delete(event.toolCallId);
	if (event.isError || !options.onClaim) return undefined;

	launchClaim(pi, state, options.onClaim, claim.issueId, ctx);
	const commandOutput = textContent(event.content);
	return {
		content: [
			{
				type: "text",
				text: `${commandOutput || `Beads claim accepted for ${claim.issueId}.`}\n\nShortleash autorun started for '${claim.issueId}'. The final run result will be reported separately.`,
			},
		],
		details: {
			...(isRecord(event.details) ? event.details : {}),
			type: BEADS_CLAIM_MESSAGE_TYPE,
			issueId: claim.issueId,
			command: claim.command,
		},
	};
}

async function handleUserBash(
	pi: ExtensionAPI,
	state: BeadsHookState,
	options: BeadsHookOptions,
	event: UserBashEvent,
	ctx: ExtensionContext,
): Promise<{ result?: BashResult } | undefined> {
	const parsed = parseBeadsCommand(event.command);
	if (!parsed) return undefined;
	const metadataError = await validateMetadataMutation(parsed.args, event.cwd);
	if (metadataError) return { result: failedBashResult(event.cwd, metadataError) };

	if (parsed.args[0] === "show" && !parsed.args.includes(BEADS_JSON_FLAG) && !parsed.args.includes("--watch")) {
		const result = await executeDirectBd(pi, parsed.args, event.cwd);
		return { result: formatDirectShowResult(event.cwd, result) };
	}

	if (!options.onClaim || !isClaimCommand(parsed.args)) return undefined;
	const target = await inspectClaimTarget(pi, parsed.args, event.cwd);
	if (typeof target === "string") return { result: failedBashResult(event.cwd, target) };
	if (!target) return undefined;

	const result = await executeDirectBd(pi, parsed.args, event.cwd);
	if (result.code !== 0)
		return { result: bashResultFromExec(event.cwd, combineExecOutput(result), result.code, result.killed) };
	launchClaim(pi, state, options.onClaim, target.issueId, ctx);
	const output = combineExecOutput(result);
	return {
		result: bashResultFromExec(
			event.cwd,
			`${output || `Beads claim accepted for ${target.issueId}.`}\n\nShortleash autorun started for '${target.issueId}'.`,
			0,
			result.killed,
		),
	};
}

function isClaimCommand(args: readonly string[]): boolean {
	return args[0] === "update" && args.some(argument => argument === "--claim" || argument === "--claim=true");
}

async function inspectClaimTarget(
	pi: ExtensionAPI,
	args: readonly string[],
	cwd: string,
): Promise<ClaimTarget | string | undefined> {
	const issueIds = updateIssueIds(args);
	const showArgs = ["show", ...(issueIds.length > 0 ? issueIds : ["--current"]), BEADS_JSON_FLAG];
	const result = await executeBd(pi, showArgs, cwd);
	if (result.code !== 0) {
		return `Cannot inspect the Bead before claiming it: ${combineExecOutput(result) || `bd exited with ${result.code}`}`;
	}
	const data = parseJson(result.stdout);
	if (data === undefined) return "Cannot inspect the Bead before claiming it: bd show returned invalid JSON.";
	const records = extractBeadsIssueRecords(data);
	const configured: ClaimTarget[] = [];
	for (const record of records) {
		if (!hasSwarmMetadata(record.metadata)) continue;
		try {
			validateSwarmMetadata(record.metadata, `Bead '${record.id}' metadata`);
		} catch (error) {
			return errorMessage(error);
		}
		configured.push({ issueId: record.id });
	}
	if (configured.length > 0 && (configured.length > 1 || issueIds.length > 1)) {
		return "Claim one Shortleash Bead at a time; a single OMP session cannot autorun multiple claims concurrently.";
	}
	return configured[0];
}

function updateIssueIds(args: readonly string[]): string[] {
	const issueIds: string[] = [];
	for (const argument of args.slice(1)) {
		if (argument === "--claim" || argument === "--claim=true") continue;
		if (argument.startsWith("-")) break;
		issueIds.push(argument);
	}
	return issueIds;
}

async function validateMetadataMutation(args: readonly string[], cwd: string): Promise<string | undefined> {
	if (args[0] !== "create" && args[0] !== "update") return undefined;
	const metadataValue = findOptionValue(args, "--metadata");
	if (metadataValue === undefined) return undefined;
	let metadata: unknown;
	try {
		metadata = await readMetadataValue(metadataValue, cwd);
	} catch (error) {
		return errorMessage(error);
	}
	if (!hasSwarmMetadata(metadata)) return undefined;
	try {
		validateSwarmMetadata(metadata);
		return undefined;
	} catch (error) {
		return errorMessage(error);
	}
}

function findOptionValue(args: readonly string[], option: string): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === option) return args[index + 1];
		if (argument.startsWith(`${option}=`)) return argument.slice(option.length + 1);
	}
	return undefined;
}

async function readMetadataValue(value: string, cwd: string): Promise<unknown> {
	if (!value) throw new Error("bd metadata option requires a JSON object or @file path");
	if (value === "@-") throw new Error("cannot validate metadata read from stdin");
	const raw = value.startsWith("@") ? await fs.readFile(path.resolve(cwd, value.slice(1)), "utf8") : value;
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`metadata is not valid JSON: ${errorMessage(error)}`);
	}
}

function appendJsonFlag(command: string): string {
	return `${command.trim()} ${BEADS_JSON_FLAG}`;
}

async function executeDirectBd(pi: ExtensionAPI, args: readonly string[], cwd: string): Promise<ExecResultLike> {
	const commandArgs = args.includes(BEADS_JSON_FLAG) ? [...args] : [...args, BEADS_JSON_FLAG];
	return executeBd(pi, commandArgs, cwd);
}

async function executeBd(pi: ExtensionAPI, args: readonly string[], cwd: string): Promise<ExecResultLike> {
	const result = await pi.exec("bd", [...args], { cwd, timeout: BEADS_COMMAND_TIMEOUT_MS });
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.code,
		killed: result.killed,
	};
}

function formatDirectShowResult(cwd: string, result: ExecResultLike): BashResult {
	if (result.code !== 0) return bashResultFromExec(cwd, combineExecOutput(result), result.code, result.killed);
	const data = parseJson(result.stdout);
	return bashResultFromExec(cwd, data === undefined ? combineExecOutput(result) : formatBeadsShowCard(data));
}

function launchClaim(
	pi: ExtensionAPI,
	state: BeadsHookState,
	onClaim: BeadsClaimHookHandler,
	issueId: string,
	ctx: ExtensionContext,
): void {
	if (state.runningClaims.has(issueId)) return;
	state.runningClaims.add(issueId);
	const signal = new AbortController().signal;
	void Promise.resolve()
		.then(() => onClaim(issueId, ctx, signal))
		.then(result => {
			pi.sendMessage(
				{
					customType: BEADS_CLAIM_MESSAGE_TYPE,
					content: `Shortleash autorun for '${issueId}' finished:\n${formatValue(result)}`,
					details: { issueId, result },
				},
				{ deliverAs: "followUp" },
			);
		})
		.catch(error => {
			pi.sendMessage(
				{
					customType: BEADS_CLAIM_MESSAGE_TYPE,
					content: `Shortleash autorun for '${issueId}' failed: ${errorMessage(error)}`,
					details: { issueId, error: errorMessage(error) },
				},
				{ deliverAs: "followUp" },
			);
		})
		.finally(() => state.runningClaims.delete(issueId));
}

function parseJson(value: string): unknown | undefined {
	try {
		return JSON.parse(value.trim());
	} catch {
		return undefined;
	}
}

function textContent(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map(item => item.text)
		.join("\n");
}

function formatIssueCard(record: BeadsIssueRecord, raw: unknown): string {
	const value = isRecord(raw) ? raw : undefined;
	const lines = [`┌─ Beads issue: ${record.id} ─`];
	appendCardField(lines, "Title", record.title ?? value?.title);
	appendCardField(lines, "Status", record.status ?? value?.status);
	appendCardField(lines, "Type", record.type ?? value?.issue_type ?? value?.type);
	appendCardField(lines, "Priority", value?.priority === undefined ? undefined : `P${String(value.priority)}`);
	appendCardField(lines, "Assignee", value?.assignee ?? value?.owner);
	appendCardSection(lines, "Description", record.description ?? value?.description);
	appendCardSection(lines, "Acceptance", value?.acceptance_criteria ?? value?.acceptance);
	appendCardSection(lines, "Notes", value?.notes);
	appendCardSection(lines, "Metadata", value?.metadata);
	lines.push("└─");
	return lines.join("\n");
}

function appendCardField(lines: string[], label: string, value: unknown): void {
	if (value === undefined || value === null || value === "") return;
	lines.push(`│ ${label}: ${truncateValue(value)}`);
}

function appendCardSection(lines: string[], label: string, value: unknown): void {
	if (value === undefined || value === null || value === "") return;
	lines.push(`│ ${label}:`);
	const formatted = truncateValue(value).split("\n");
	for (const line of formatted) lines.push(`│   ${line}`);
}

function truncateValue(value: unknown): string {
	const formatted = formatValue(value);
	return formatted.length <= MAX_CARD_VALUE_LENGTH ? formatted : `${formatted.slice(0, MAX_CARD_VALUE_LENGTH - 1)}…`;
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function truncateCard(value: string): string {
	return value.length <= MAX_CARD_OUTPUT_LENGTH ? value : `${value.slice(0, MAX_CARD_OUTPUT_LENGTH - 1)}…`;
}
function combineExecOutput(result: ExecResultLike): string {
	return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}
function bashResultFromExec(cwd: string, output: string, exitCode = 0, killed = false): BashResult {
	const totalBytes = Buffer.byteLength(output, "utf8");
	const totalLines = output.length === 0 ? 0 : output.split("\n").length;
	return {
		output,
		exitCode,
		cancelled: killed,
		truncated: false,
		totalLines,
		totalBytes,
		outputLines: totalLines,
		outputBytes: totalBytes,
		workingDir: cwd,
	};
}

function failedBashResult(cwd: string, message: string): BashResult {
	return bashResultFromExec(cwd, message, 2);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function block(reason: string): { block: true; reason: string } {
	return { block: true, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
