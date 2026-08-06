import type { ExtensionContext, ToolApprovalDecision, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { hasSwarmMetadata, validateSwarmMetadata } from "../orchestration/definition/metadata";
import { BeadsClient, type BeadsCommandResult, type BeadsIssueRecord, extractBeadsIssueRecord } from "./client";
import { renderBeadsCall, renderBeadsResult } from "./render";

const dependencySchema = z.object({
	issue_id: z.string().min(1).describe("issue ID the new issue depends on"),
	type: z.string().min(1).describe("dependency type").optional(),
});

const beadsToolSchema = z
	.object({
		op: z.enum(["show", "list", "ready", "create", "update", "claim", "close", "dependencies"]),
		issue_id: z.string().min(1).describe("one issue ID").optional(),
		issue_ids: z.array(z.string()).describe("one or more issue IDs").optional(),
		dependency_issue_id: z.string().min(1).describe("issue ID that issue_id depends on").optional(),
		dependency_action: z.enum(["add", "remove", "list"]).describe("dependency edge operation").optional(),
		dependency_type: z.string().min(1).describe("dependency type").optional(),
		direction: z
			.enum(["down", "up"])
			.describe("dependency traversal: down = dependencies of issue_id; up = dependents of issue_id")
			.optional(),
		title: z.string().describe("issue title or list title filter").optional(),
		type: z.string().min(1).describe("Beads issue type").optional(),
		description: z.string().describe("issue description").optional(),
		acceptance: z.string().describe("acceptance criteria").optional(),
		parent_id: z.string().min(1).describe("parent issue ID").optional(),
		status: z.string().min(1).describe("issue status").optional(),
		assignee: z.string().describe("issue assignee").optional(),
		priority: z.number().int().describe("issue priority").optional(),
		labels: z.array(z.string()).describe("labels to set or filter").optional(),
		notes: z.string().describe("issue notes").optional(),
		append_notes: z.string().describe("notes to append").optional(),
		defer_until: z.string().describe("defer date or empty string to clear").optional(),
		limit: z.number().int().describe("maximum number of returned issues").optional(),
		ready: z.boolean().describe("restrict list results to ready issues").optional(),
		no_parent: z.boolean().describe("restrict list results to root issues").optional(),
		unassigned: z.boolean().describe("restrict ready results to unassigned issues").optional(),
		metadata: z
			.record(z.string(), z.unknown())
			.describe(
				"structured metadata; feature, bug, and task mutations require metadata.shortleash matching the standard swarm definition schema",
			)
			.optional(),
		metadata_file: z.string().min(1).describe("workspace-relative JSON metadata file").optional(),
		deps: z
			.array(dependencySchema)
			.describe("dependencies the new issue should depend on; each entry creates a new_issue -> dependency edge")
			.optional(),
		reason: z.string().describe("close reason").optional(),
	})
	.strict();

export type BeadsToolParams = z.infer<typeof beadsToolSchema>;

export interface BeadsToolDetails {
	operation: BeadsToolParams["op"];
	args: string[];
	data: unknown;
	delegation?: BeadsClaimDelegation;
}

export type BeadsClaimDelegationStatus =
	| "completed"
	| "failed"
	| "aborted"
	| "already-running"
	| "already-completed"
	| "not-started";

export interface BeadsClaimDelegation {
	status: BeadsClaimDelegationStatus;
	swarmName?: string;
	iterations?: number;
	errors?: string[];
	reason?: string;
}

export interface BeadsClaimHandlerInput {
	issueId: string;
	bead: BeadsIssueRecord;
	ctx: ExtensionContext;
	signal?: AbortSignal;
}

export type BeadsClaimHandler = (input: BeadsClaimHandlerInput) => Promise<BeadsClaimDelegation>;

export interface BeadsToolFactoryOptions {
	client?: BeadsClient;
	createClient?: (cwd: string) => BeadsClient;
	onClaim?: BeadsClaimHandler;
}

const READ_OPERATIONS = new Set(["show", "list", "ready"]);
const BEADS_TOOL_DESCRIPTION = [
	"Use this single bounded tool to inspect and update the workspace's Beads issue graph. Pass a structured object with `op` and snake_case fields; do not ask for or execute a raw `bd` command. Calls run in the current workspace and return JSON.",
	"",
	"Authority and safety: Beads is the externally visible work graph/projection, not the authoritative workflow runtime. Use this tool for meaningful milestones, blockers, human decisions, and discovered external work—not every internal activity. A Bead being closed does not prove a workflow milestone or epic is accepted. Claiming a configured Bead delegates it to the Shortleash executor; persisted swarm state remains authoritative.",
	"",
	"Operations:",
	"- `show`: inspect one or more issues; requires `issue_id` or non-empty `issue_ids`.",
	"- `list`: search or filter issues with `parent_id`, `status`, `assignee`, `title`, `type`, `priority` (0-4), `labels`, `limit` (positive integer), `ready`, or `no_parent`.",
	"- `ready`: find unblocked work; supports `parent_id`, `type`, `priority` (0-4), `assignee`, `labels`, `limit`, and `unassigned`.",
	"- `create`: create a meaningful issue; `title` is required. `type` defaults to `task`, and `feature`, `bug`, and `task` issues must include valid `metadata.shortleash` configuration. Use `parent_id` for hierarchy, `acceptance` for completion criteria, `notes` for durable context, `defer_until` for deferral, and `deps` for prerequisites—the new issue will depend on each listed issue.",
	"- `update`: change an existing issue; requires `issue_id` and at least one field to change: `title`, `type`, `description`, `acceptance`, `parent_id`, `status`, `priority`, `assignee`, `labels`, `notes`, `append_notes`, `defer_until`, `metadata`, or `metadata_file`. Feature, bug, and task updates must carry valid `metadata.shortleash`; updates without an explicit type validate the existing issue before mutation. Use `append_notes` when preserving existing notes matters.",
	"- `claim`: claim ownership of one issue with `issue_id`; if its metadata contains valid `shortleash`, the extension automatically delegates the claimed Bead to the swarm executor and reports the persisted run status.",
	"- `close`: close one issue with `issue_id`; include a durable `reason` explaining the externally meaningful completion.",
	"- `dependencies`: inspect or change graph edges. `dependency_action` is `list`, `add`, or `remove`. `list` requires `issue_id` or `issue_ids` and accepts `direction` (`down` by default = dependencies, or `up` = dependents) plus optional `dependency_type`; `add` and `remove` require exactly one `issue_id` (the dependent issue) and one `dependency_issue_id` (the issue it depends on); `add` defaults to `blocks`. `remove` rejects missing or reversed edges instead of reporting a false success.",
	"",
	"Input conventions:",
	"- Use issue IDs returned by `show`, `list`, or `ready`; do not substitute titles.",
	"- `priority` must be an integer from 0 through 4, and `limit` must be at least 1.",
	"- `deps` is an array of `{ issue_id, type? }`; each entry means the new issue depends on that issue. Use explicit types such as `blocks` or `discovered-from` when needed.",
	"- `metadata` must be a JSON object. `metadata` and `metadata_file` are mutually exclusive. `metadata_file` must be a workspace-relative JSON file, never an absolute path.",
	"- `metadata.shortleash` is the standard raw swarm definition: `name` and `workspace` are required; omit `agents` to execute directly in the current OMP session, or define agents with `role` and `task`.",
	"- Unknown fields and invalid operation-specific combinations are rejected; correct the structured input rather than retrying a raw command.",
	"",
	"Typical flow: `ready` -> `show` -> `claim` -> Shortleash delegation when configured -> inspect results -> `update` durable notes -> `close` after genuine completion.",
	"",
	'Examples: { "op": "ready", "limit": 10 }; { "op": "show", "issue_id": "bd-123" }; { "op": "update", "issue_id": "bd-123", "append_notes": "durable discovery" }; { "op": "dependencies", "dependency_action": "list", "issue_id": "bd-123", "direction": "up" }.',
].join("\n");

export function createBeadsTool(
	options: BeadsToolFactoryOptions = {},
): ToolDefinition<typeof beadsToolSchema, BeadsToolDetails> {
	return {
		name: "beads",
		label: "Beads",
		description: BEADS_TOOL_DESCRIPTION,
		parameters: beadsToolSchema,
		loadMode: "discoverable",
		strict: true,
		approval: approvalFor,
		renderCall: renderBeadsCall,
		renderResult: renderBeadsResult,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const validated = parseBeadsParams(params);
			const client = options.client ?? options.createClient?.(ctx.cwd) ?? new BeadsClient();
			const outcome = await executeBeadsOperation(client, validated, ctx, signal, options.onClaim);
			const data = outcome.delegation
				? { claim: outcome.result.data, swarm: outcome.delegation }
				: outcome.result.data;
			return {
				content: [{ type: "text", text: JSON.stringify(data, null, 2) ?? "null" }],
				details: {
					operation: validated.op,
					args: [...outcome.result.args],
					data,
					delegation: outcome.delegation,
				},
			};
		},
	};
}

function approvalFor(raw: unknown): ToolApprovalDecision {
	if (isRecord(raw) && typeof raw.op === "string") {
		if (READ_OPERATIONS.has(raw.op)) return "read";
		if (raw.op === "dependencies" && raw.dependency_action === "list") return "read";
	}
	return "write";
}

type ValidatedDependencyParams =
	| (BeadsToolParams & {
			op: "dependencies";
			dependencyAction: "list";
			issueIds: string[];
			dependencyIssueId?: undefined;
	  })
	| (BeadsToolParams & {
			op: "dependencies";
			dependencyAction: "add" | "remove";
			issueIds: string[];
			issueId: string;
			dependencyIssueId: string;
	  });

type ValidatedBeadsParams =
	| (BeadsToolParams & { op: "show"; issueIds: string[] })
	| (BeadsToolParams & { op: "create"; title: string })
	| (BeadsToolParams & { op: "update"; issueId: string })
	| (BeadsToolParams & { op: "claim"; issueId: string })
	| (BeadsToolParams & { op: "close"; issueId: string })
	| ValidatedDependencyParams
	| (BeadsToolParams & { op: "list" | "ready" });

function parseBeadsParams(raw: unknown): ValidatedBeadsParams {
	const parsed = beadsToolSchema.safeParse(raw);
	if (!parsed.success) throw new Error(`Invalid beads operation: ${parsed.error.message}`);

	const params = parsed.data;
	const { op: _op, ...base } = params;
	switch (params.op) {
		case "show":
			return { ...base, op: "show", issueIds: requireIssueIds(params, "show requires issue_id or issue_ids") };
		case "list":
			validatePriority(params.priority);
			validateLimit(params.limit);
			return { ...base, op: "list" };
		case "ready":
			validatePriority(params.priority);
			validateLimit(params.limit);
			return { ...base, op: "ready" };
		case "create":
			validatePriority(params.priority);
			validateMetadata(params);
			validateCreateSwarmRequirement(params);
			return { ...base, op: "create", title: requireNonEmpty(params.title, "create requires title") };
		case "update":
			if (!hasUpdateField(params)) throw new Error("update requires at least one field to change");
			validatePriority(params.priority);
			validateMetadata(params);
			validateUpdateSwarmRequirement(params);
			return { ...base, op: "update", issueId: requireNonEmpty(params.issue_id, "update requires issue_id") };
		case "claim":
			return { ...base, op: "claim", issueId: requireNonEmpty(params.issue_id, "claim requires issue_id") };
		case "close":
			return { ...base, op: "close", issueId: requireNonEmpty(params.issue_id, "close requires issue_id") };
		case "dependencies":
			return { ...base, op: "dependencies", ...validateDependencyOperation(params) };
	}
}

type BeadsExecutionOutcome = {
	result: BeadsCommandResult;
	delegation?: BeadsClaimDelegation;
};

async function executeBeadsOperation(
	client: BeadsClient,
	params: ValidatedBeadsParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	onClaim: BeadsClaimHandler | undefined,
): Promise<BeadsExecutionOutcome> {
	switch (params.op) {
		case "show":
			return { result: await client.show({ ids: params.issueIds }, ctx.cwd, signal) };
		case "list":
			return {
				result: await client.list(
					{
						parentId: params.parent_id,
						status: params.status,
						assignee: params.assignee,
						title: params.title,
						type: params.type,
						priority: params.priority,
						labels: params.labels,
						limit: params.limit,
						ready: params.ready,
						noParent: params.no_parent,
					},
					ctx.cwd,
					signal,
				),
			};
		case "ready":
			return {
				result: await client.ready(
					{
						parentId: params.parent_id,
						type: params.type,
						priority: params.priority,
						assignee: params.assignee,
						labels: params.labels,
						limit: params.limit,
						unassigned: params.unassigned,
					},
					ctx.cwd,
					signal,
				),
			};
		case "create":
			return {
				result: await client.create(
					{
						title: params.title,
						type: params.type,
						description: params.description,
						acceptance: params.acceptance,
						parentId: params.parent_id,
						priority: params.priority,
						assignee: params.assignee,
						labels: params.labels,
						notes: params.notes,
						deferUntil: params.defer_until,
						deps: params.deps?.map(dep => ({ issueId: dep.issue_id, type: dep.type })),
						metadata: params.metadata,
						metadataFile: params.metadata_file,
					},
					ctx.cwd,
					signal,
				),
			};
		case "update":
			return {
				result: await client.update(
					{
						issueId: params.issueId,
						title: params.title,
						type: params.type,
						description: params.description,
						acceptance: params.acceptance,
						parentId: params.parent_id,
						status: params.status,
						priority: params.priority,
						assignee: params.assignee,
						labels: params.labels,
						notes: params.notes,
						appendNotes: params.append_notes,
						deferUntil: params.defer_until,
						metadata: params.metadata,
						metadataFile: params.metadata_file,
					},
					ctx.cwd,
					signal,
				),
			};
		case "claim": {
			const result = await client.claim({ issueId: params.issueId }, ctx.cwd, signal);
			if (!onClaim) return { result };
			const shown = await client.show({ ids: [params.issueId] }, ctx.cwd, signal);
			const bead = extractBeadsIssueRecord(shown.data, params.issueId);
			if (!bead || !hasSwarmMetadata(bead.metadata)) return { result };
			try {
				validateSwarmMetadata(bead.metadata);
				const delegation = await onClaim({
					issueId: bead.id,
					bead,
					ctx,
					signal,
				});
				return { result, delegation };
			} catch (error) {
				return {
					result,
					delegation: {
						status: "failed",
						reason: error instanceof Error ? error.message : String(error),
					},
				};
			}
		}
		case "close":
			return {
				result: await client.close({ issueId: params.issueId, reason: params.reason }, ctx.cwd, signal),
			};
		case "dependencies":
			return {
				result: await client.dependencies(
					{
						action: params.dependencyAction,
						issueIds: params.issueIds,
						dependencyIssueId: params.dependencyIssueId,
						type: params.dependency_type,
						direction: params.direction,
					},
					ctx.cwd,
					signal,
				),
			};
	}
}

function validateDependencyOperation(
	params: BeadsToolParams,
):
	| { dependencyAction: "list"; issueIds: string[]; dependencyIssueId?: undefined }
	| { dependencyAction: "add" | "remove"; issueIds: string[]; issueId: string; dependencyIssueId: string } {
	if (!params.dependency_action) throw new Error("dependencies requires dependency_action");
	if (params.dependency_action === "list") {
		return {
			dependencyAction: "list",
			issueIds: requireIssueIds(params, "dependency list requires issue_id or issue_ids"),
		};
	}
	if (!params.issue_id || params.issue_ids) {
		if (params.issue_ids && params.issue_ids.length > 0) {
			throw new Error("dependency add/remove accepts exactly one issue_id");
		}
		throw new Error("dependency add/remove requires issue_id");
	}
	return {
		dependencyAction: params.dependency_action,
		issueIds: [requireNonEmpty(params.issue_id, "dependency add/remove requires issue_id")],
		issueId: requireNonEmpty(params.issue_id, "dependency add/remove requires issue_id"),
		dependencyIssueId: requireNonEmpty(
			params.dependency_issue_id,
			"dependency add/remove requires dependency_issue_id",
		),
	};
}

function normalizeIssueIds(params: BeadsToolParams): string[] {
	return (
		params.issue_ids && params.issue_ids.length > 0 ? params.issue_ids : params.issue_id ? [params.issue_id] : []
	).map(id => id.trim());
}

function requireIssueIds(params: BeadsToolParams, message: string): string[] {
	const ids = normalizeIssueIds(params);
	if (ids.length === 0 || ids.some(id => id.length === 0)) throw new Error(message);
	return ids;
}

function requireNonEmpty(value: string | undefined, message: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(message);
	return value.trim();
}

function validateLimit(value: number | undefined): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
		throw new Error("limit must be a positive integer");
	}
}

function validatePriority(value: number | undefined): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 4)) {
		throw new Error("priority must be an integer from 0 through 4");
	}
}

function validateMetadata(params: BeadsToolParams): void {
	if (params.metadata !== undefined && params.metadata_file !== undefined) {
		throw new Error("metadata and metadata_file are mutually exclusive");
	}
	if (params.metadata !== undefined && hasSwarmMetadata(params.metadata)) {
		validateSwarmMetadata(params.metadata);
	}
}

function validateCreateSwarmRequirement(params: BeadsToolParams): void {
	const type = normalizeIssueType(params.type ?? "task");
	if (!isSwarmRequiredType(type)) return;
	if (params.metadata === undefined && params.metadata_file === undefined) {
		throw new Error(
			`create of ${type} issues requires metadata.shortleash using the standard swarm definition schema`,
		);
	}
	if (params.metadata !== undefined && !hasSwarmMetadata(params.metadata)) {
		throw new Error(
			`create of ${type} issues requires metadata.shortleash using the standard swarm definition schema`,
		);
	}
}

function validateUpdateSwarmRequirement(params: BeadsToolParams): void {
	if (params.type === undefined || !isSwarmRequiredType(normalizeIssueType(params.type))) return;
	if (params.metadata === undefined && params.metadata_file === undefined) {
		throw new Error(
			`update of ${normalizeIssueType(params.type)} issues requires metadata.shortleash using the standard swarm definition schema`,
		);
	}
	if (params.metadata !== undefined && !hasSwarmMetadata(params.metadata)) {
		throw new Error(
			`update of ${normalizeIssueType(params.type)} issues requires metadata.shortleash using the standard swarm definition schema`,
		);
	}
}

function normalizeIssueType(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (normalized === "enhancement" || normalized === "feat") return "feature";
	return normalized;
}

function isSwarmRequiredType(value: string): boolean {
	return value === "bug" || value === "feature" || value === "task";
}

function hasUpdateField(params: BeadsToolParams): boolean {
	return [
		"title",
		"type",
		"description",
		"acceptance",
		"parent_id",
		"status",
		"priority",
		"assignee",
		"labels",
		"notes",
		"append_notes",
		"defer_until",
		"metadata",
		"metadata_file",
	].some(field => Object.hasOwn(params, field));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
