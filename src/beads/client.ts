import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasSwarmMetadata, normalizeMetadataObject, validateSwarmMetadata } from "../swarm/metadata";
export type BeadsCommandRunner = (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<string>;

export interface BeadsCommandResult {
	args: readonly string[];
	raw: unknown;
	data: unknown;
	text: string;
}

export interface BeadsIssueRecord {
	id: string;
	title?: string;
	description?: string;
	type?: string;
	status?: string;
	metadata?: unknown;
}

export function extractBeadsIssueRecord(data: unknown, issueId: string): BeadsIssueRecord | undefined {
	const candidates = Array.isArray(data) ? data : [data];
	const raw = candidates.find(
		(candidate): candidate is Record<string, unknown> =>
			isRecord(candidate) && typeof candidate.id === "string" && candidate.id === issueId,
	);
	if (!raw) return undefined;
	return {
		id: issueId,
		title: typeof raw.title === "string" ? raw.title : undefined,
		description: typeof raw.description === "string" ? raw.description : undefined,
		type: typeof raw.type === "string" ? raw.type : typeof raw.issue_type === "string" ? raw.issue_type : undefined,
		status: typeof raw.status === "string" ? raw.status : undefined,
		metadata: raw.metadata,
	};
}

export interface BeadsDependencyInput {
	issueId: string;
	type?: string;
}

export interface BeadsShowInput {
	ids: string[];
}

export interface BeadsListInput {
	parentId?: string;
	status?: string;
	assignee?: string;
	title?: string;
	type?: string;
	priority?: number;
	labels?: string[];
	limit?: number;
	ready?: boolean;
	noParent?: boolean;
}

export interface BeadsReadyInput {
	parentId?: string;
	type?: string;
	priority?: number;
	assignee?: string;
	labels?: string[];
	limit?: number;
	unassigned?: boolean;
}

export interface BeadsCreateInput {
	title: string;
	type?: string;
	description?: string;
	acceptance?: string;
	parentId?: string;
	priority?: number;
	assignee?: string;
	labels?: string[];
	notes?: string;
	deferUntil?: string;
	deps?: BeadsDependencyInput[];
	metadata?: Record<string, unknown>;
	metadataFile?: string;
}

export interface BeadsUpdateInput {
	issueId: string;
	title?: string;
	type?: string;
	description?: string;
	acceptance?: string;
	parentId?: string;
	status?: string;
	priority?: number;
	assignee?: string;
	labels?: string[];
	notes?: string;
	appendNotes?: string;
	deferUntil?: string;
	metadata?: Record<string, unknown>;
	metadataFile?: string;
}

export interface BeadsClaimInput {
	issueId: string;
}

export interface BeadsCloseInput {
	issueId: string;
	reason?: string;
}

export interface BeadsDependencyOperationInput {
	action: "add" | "remove" | "list";
	issueIds: string[];
	dependencyIssueId?: string;
	type?: string;
	direction?: "down" | "up";
}

export interface BeadsClientOptions {
	run?: BeadsCommandRunner;
	temporaryDirectory?: string;
}

export class BeadsCommandError extends Error {
	readonly name = "BeadsCommandError";
	readonly args: readonly string[];
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly missing: boolean;

	constructor(args: readonly string[], code: number, stdout: string, stderr: string) {
		const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
		super(`bd ${args.join(" ")} failed: ${detail}`);
		this.args = args;
		this.code = code;
		this.stdout = stdout;
		this.stderr = stderr;
		this.missing = /(?:not found|no issue|does not exist|unknown issue)/i.test(detail);
	}
}

export async function runBeadsCommand(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw abortError(signal);

	const processHandle = Bun.spawn(["bd", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const abortHandler = (): void => {
		try {
			processHandle.kill();
		} catch {
			// The process may already have exited; the exit result remains authoritative.
		}
	};
	signal?.addEventListener("abort", abortHandler, { once: true });
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(processHandle.stdout).text(),
			new Response(processHandle.stderr).text(),
			processHandle.exited,
		]);
		if (signal?.aborted) throw abortError(signal);
		if (code !== 0) throw new BeadsCommandError(args, code, stdout, stderr);
		return stdout;
	} finally {
		signal?.removeEventListener("abort", abortHandler);
	}
}

export class BeadsClient {
	readonly #run: BeadsCommandRunner;
	readonly #temporaryDirectory: string;

	constructor(options: BeadsClientOptions = {}) {
		this.#run = options.run ?? runBeadsCommand;
		this.#temporaryDirectory = options.temporaryDirectory ?? os.tmpdir();
	}

	async show(input: BeadsShowInput, cwd: string, signal?: AbortSignal): Promise<BeadsCommandResult> {
		const ids = requireIds(input.ids, "show requires at least one issue ID");
		return this.#runJson(["show", ...ids], cwd, signal);
	}

	async list(input: BeadsListInput, cwd: string, signal?: AbortSignal): Promise<BeadsCommandResult> {
		const args = ["list"];
		if (input.parentId) args.push("--parent", requireValue(input.parentId, "parentId"));
		if (input.status) args.push("--status", requireValue(input.status, "status"));
		if (input.assignee) args.push("--assignee", requireValue(input.assignee, "assignee"));
		if (input.title) args.push("--title", requireValue(input.title, "title"));
		if (input.type) args.push("--type", requireValue(input.type, "type"));
		if (input.priority !== undefined) {
			args.push("--priority", String(requireNonNegativeInteger(input.priority, "priority")));
		}
		for (const label of input.labels ?? []) args.push("--label", requireValue(label, "labels entry"));
		if (input.limit !== undefined) args.push("--limit", String(requirePositiveInteger(input.limit, "limit")));
		if (input.ready === true) args.push("--ready");
		if (input.noParent === true) args.push("--no-parent");
		return this.#runJson(args, cwd, signal);
	}

	async ready(input: BeadsReadyInput, cwd: string, signal?: AbortSignal): Promise<BeadsCommandResult> {
		const args = ["ready"];
		if (input.parentId) args.push("--parent", requireValue(input.parentId, "parentId"));
		if (input.type) args.push("--type", requireValue(input.type, "type"));
		if (input.priority !== undefined) {
			args.push("--priority", String(requireNonNegativeInteger(input.priority, "priority")));
		}
		if (input.assignee) args.push("--assignee", requireValue(input.assignee, "assignee"));
		for (const label of input.labels ?? []) args.push("--label", requireValue(label, "labels entry"));
		if (input.limit !== undefined) args.push("--limit", String(requirePositiveInteger(input.limit, "limit")));
		if (input.unassigned === true) args.push("--unassigned");
		return this.#runJson(args, cwd, signal);
	}

	async create(input: BeadsCreateInput, cwd: string, signal?: AbortSignal): Promise<BeadsCommandResult> {
		const title = requireValue(input.title, "title");
		const requestedType = input.type === undefined ? "task" : requireValue(input.type, "type");
		const type = normalizeIssueType(requestedType);
		const metadata = await this.#readMetadataInput(input.metadata, input.metadataFile, cwd);
		validateCreateMetadata(type, metadata);

		const args = ["create", "--title", title, "--type", requestedType];
		if (input.description !== undefined) args.push("--description", input.description);
		if (input.acceptance !== undefined) args.push("--acceptance", input.acceptance);
		if (input.parentId) args.push("--parent", requireValue(input.parentId, "parentId"));
		if (input.priority !== undefined) {
			args.push("--priority", String(requireNonNegativeInteger(input.priority, "priority")));
		}
		if (input.assignee) args.push("--assignee", requireValue(input.assignee, "assignee"));
		if (input.labels && input.labels.length > 0)
			args.push("--labels", input.labels.map(label => requireValue(label, "labels entry")).join(","));
		if (input.notes !== undefined) args.push("--notes", input.notes);
		if (input.deferUntil !== undefined) args.push("--defer", input.deferUntil);

		const result = await this.#runWithMetadata(args, input.metadata, input.metadataFile, cwd, signal);
		const dependencies = input.deps ?? [];
		if (dependencies.length === 0) return result;

		const issueId = requireCreatedIssueId(result.data);
		for (const dep of dependencies) {
			const dependencyType = dep.type === undefined ? "blocks" : requireValue(dep.type, "dependency type");
			await this.#runJson(
				["dep", "add", issueId, requireValue(dep.issueId, "dependency issueId"), "--type", dependencyType],
				cwd,
				signal,
			);
		}
		return result;
	}

	async update(input: BeadsUpdateInput, cwd: string, signal?: AbortSignal): Promise<BeadsCommandResult> {
		const issueId = requireValue(input.issueId, "issueId");
		const requestedType = input.type === undefined ? undefined : requireValue(input.type, "type");
		const type = requestedType === undefined ? undefined : normalizeIssueType(requestedType);
		const metadata = await this.#readMetadataInput(input.metadata, input.metadataFile, cwd);
		await validateUpdateMetadata(issueId, type, metadata, cwd, signal, this);

		const args = ["update", issueId];
		if (requestedType !== undefined) args.push("--type", requestedType);
		if (input.title !== undefined) args.push("--title", input.title);
		if (input.description !== undefined) args.push("--description", input.description);
		if (input.acceptance !== undefined) args.push("--acceptance", input.acceptance);
		if (input.parentId !== undefined) args.push("--parent", input.parentId);
		if (input.status !== undefined) args.push("--status", input.status);
		if (input.priority !== undefined) {
			args.push("--priority", String(requireNonNegativeInteger(input.priority, "priority")));
		}
		if (input.assignee !== undefined) args.push("--assignee", input.assignee);
		if (input.labels !== undefined) {
			for (const label of input.labels) args.push("--set-labels", requireValue(label, "labels entry"));
		}
		if (input.notes !== undefined) args.push("--notes", input.notes);
		if (input.appendNotes !== undefined) args.push("--append-notes", input.appendNotes);
		if (input.deferUntil !== undefined) args.push("--defer", input.deferUntil);
		return this.#runWithMetadata(args, input.metadata, input.metadataFile, cwd, signal);
	}

	async claim(input: BeadsClaimInput, cwd: string, signal?: AbortSignal): Promise<BeadsCommandResult> {
		return this.#runJson(["update", requireValue(input.issueId, "issueId"), "--claim"], cwd, signal);
	}

	async close(input: BeadsCloseInput, cwd: string, signal?: AbortSignal): Promise<BeadsCommandResult> {
		const args = ["close", requireValue(input.issueId, "issueId")];
		if (input.reason !== undefined) args.push("--reason", input.reason);
		return this.#runJson(args, cwd, signal);
	}

	async dependencies(
		input: BeadsDependencyOperationInput,
		cwd: string,
		signal?: AbortSignal,
	): Promise<BeadsCommandResult> {
		const ids = requireIds(input.issueIds, "dependencies requires at least one issue ID");
		switch (input.action) {
			case "add":
				if (ids.length !== 1 || !input.dependencyIssueId) {
					throw new Error("dependency add requires exactly one issueId and dependencyIssueId");
				}
				return this.#runJson(
					[
						"dep",
						"add",
						ids[0],
						requireValue(input.dependencyIssueId, "dependencyIssueId"),
						"--type",
						input.type ?? "blocks",
					],
					cwd,
					signal,
				);
			case "remove": {
				if (ids.length !== 1 || !input.dependencyIssueId) {
					throw new Error("dependency remove requires exactly one issueId and dependencyIssueId");
				}
				const issueId = requireValue(ids[0], "issueId");
				const dependencyIssueId = requireValue(input.dependencyIssueId, "dependencyIssueId");
				const existing = await this.#runJson(["dep", "list", issueId, "--direction", "down"], cwd, signal);
				if (!hasDependencyId(existing.data, dependencyIssueId)) {
					const reversed = await this.#runJson(
						["dep", "list", dependencyIssueId, "--direction", "down"],
						cwd,
						signal,
					);
					if (hasDependencyId(reversed.data, issueId)) {
						throw new Error(
							`dependency edge is reversed: ${dependencyIssueId} depends on ${issueId}; swap issue_id and dependency_issue_id`,
						);
					}
					throw new Error(`dependency edge not found: ${issueId} does not depend on ${dependencyIssueId}`);
				}

				const result = await this.#runJson(["dep", "remove", issueId, dependencyIssueId], cwd, signal);
				const remaining = await this.#runJson(["dep", "list", issueId, "--direction", "down"], cwd, signal);
				if (hasDependencyId(remaining.data, dependencyIssueId)) {
					throw new Error(
						`dependency removal did not remove edge: ${issueId} still depends on ${dependencyIssueId}`,
					);
				}
				return result;
			}
			case "list": {
				const args = ["dep", "list", ...ids, "--direction", input.direction ?? "down"];
				if (input.type) args.push("--type", input.type);
				return this.#runJson(args, cwd, signal);
			}
		}
	}

	async #readMetadataInput(
		metadata: Record<string, unknown> | undefined,
		metadataFile: string | undefined,
		cwd: string,
	): Promise<Record<string, unknown> | undefined> {
		if (metadata !== undefined && metadataFile !== undefined) {
			throw new Error("metadata and metadataFile are mutually exclusive");
		}
		if (metadata !== undefined) return normalizeMetadataObject(metadata);
		if (metadataFile === undefined) return undefined;
		const metadataPath = await resolveMetadataFile(cwd, metadataFile);
		const content = await fs.readFile(metadataPath, "utf8");
		return normalizeMetadataObject(JSON.parse(content), "metadataFile");
	}

	async #runJson(args: string[], cwd: string, signal?: AbortSignal): Promise<BeadsCommandResult> {
		const stdout = await this.#run([...args, "--json"], cwd, signal);
		let raw: unknown;
		try {
			raw = JSON.parse(stdout);
		} catch (error) {
			throw new Error(`bd ${args.join(" ")} returned invalid JSON: ${errorMessage(error)}`);
		}
		const data = isRecord(raw) && Object.hasOwn(raw, "data") ? raw.data : raw;
		return {
			args,
			raw,
			data,
			text: JSON.stringify(data, null, 2) ?? "null",
		};
	}

	async #runWithMetadata(
		args: string[],
		metadata: Record<string, unknown> | undefined,
		metadataFile: string | undefined,
		cwd: string,
		signal?: AbortSignal,
	): Promise<BeadsCommandResult> {
		if (metadata !== undefined && metadataFile !== undefined) {
			throw new Error("metadata and metadataFile are mutually exclusive");
		}
		if (metadata === undefined && metadataFile === undefined) return this.#runJson(args, cwd, signal);

		let temporaryPath: string | undefined;
		let metadataPath: string;
		if (metadataFile !== undefined) {
			metadataPath = await resolveMetadataFile(cwd, metadataFile);
		} else {
			if (!isRecord(metadata)) throw new Error("metadata must be a JSON object");
			let serialized: string;
			try {
				serialized = JSON.stringify(metadata);
			} catch (error) {
				throw new Error(`metadata could not be serialized: ${errorMessage(error)}`);
			}
			const temporaryDirectory = await fs.mkdtemp(path.join(this.#temporaryDirectory, "omp-beads-"));
			temporaryPath = path.join(temporaryDirectory, "metadata.json");
			await fs.writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
			metadataPath = temporaryPath;
		}

		try {
			return await this.#runJson([...args, "--metadata", `@${metadataPath}`], cwd, signal);
		} finally {
			if (temporaryPath) await fs.rm(path.dirname(temporaryPath), { recursive: true, force: true });
		}
	}
}

async function resolveMetadataFile(cwd: string, metadataFile: string): Promise<string> {
	if (path.isAbsolute(metadataFile)) throw new Error("metadataFile must be relative to the workspace");
	const resolved = path.resolve(cwd, metadataFile);
	const relative = path.relative(cwd, resolved);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("metadataFile must stay within the workspace");
	}
	const stat = await fs.stat(resolved);
	if (!stat.isFile()) throw new Error(`metadataFile is not a file: ${metadataFile}`);
	const content = await fs.readFile(resolved, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(`metadataFile is not valid JSON: ${errorMessage(error)}`);
	}
	if (!isRecord(parsed)) throw new Error("metadataFile must contain a JSON object");
	return resolved;
}

const SWARM_REQUIRED_ISSUE_TYPES = new Set(["bug", "feature", "task"]);

function normalizeIssueType(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "enhancement" || normalized === "feat") return "feature";
	return normalized;
}

function isSwarmRequiredIssueType(value: string | undefined): boolean {
	return value !== undefined && SWARM_REQUIRED_ISSUE_TYPES.has(value);
}

function validateCreateMetadata(type: string | undefined, metadata: Record<string, unknown> | undefined): void {
	const hasSwarm = metadata !== undefined && hasSwarmMetadata(metadata);
	if (hasSwarm) validateSwarmMetadata(metadata);
	if (isSwarmRequiredIssueType(type) && !hasSwarm) {
		throw new Error(
			`create of ${type} issues requires metadata.shortleash using the standard swarm definition schema`,
		);
	}
}

async function validateUpdateMetadata(
	issueId: string,
	type: string | undefined,
	metadata: Record<string, unknown> | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	client: BeadsClient,
): Promise<void> {
	const hasSwarm = metadata !== undefined && hasSwarmMetadata(metadata);
	if (hasSwarm) validateSwarmMetadata(metadata);
	if (isSwarmRequiredIssueType(type)) {
		if (!hasSwarm) {
			throw new Error(
				`update of ${type} issues requires metadata.shortleash using the standard swarm definition schema`,
			);
		}
		return;
	}
	if (type !== undefined || hasSwarm) return;

	const existing = await client.show({ ids: [issueId] }, cwd, signal);
	const record = extractBeadsIssueRecord(existing.data, issueId);
	if (!record) throw new Error(`bd show returned no item for '${issueId}'`);
	const existingType = normalizeIssueType(record.type);
	if (!isSwarmRequiredIssueType(existingType)) return;
	if (metadata !== undefined) {
		throw new Error(
			`update of ${existingType} issue '${issueId}' requires metadata.shortleash using the standard swarm definition schema`,
		);
	}
	if (!hasSwarmMetadata(record.metadata)) {
		throw new Error(`existing ${existingType} issue '${issueId}' must contain metadata.shortleash`);
	}
	validateSwarmMetadata(record.metadata, `existing issue '${issueId}' metadata`);
}

function requireCreatedIssueId(data: unknown): string {
	if (!isRecord(data) || typeof data.id !== "string" || data.id.trim().length === 0) {
		throw new Error("bd create did not return a created issue ID; cannot attach dependencies");
	}
	return data.id.trim();
}

function hasDependencyId(data: unknown, issueId: string): boolean {
	if (!Array.isArray(data)) throw new Error("bd dep list returned invalid dependency data");
	return data.some(entry => {
		if (!isRecord(entry)) return false;
		return [entry.id, entry.issue_id, entry.depends_on_id, entry.dependency_id].some(
			candidate => candidate === issueId,
		);
	});
}

function requireIds(value: string[] | undefined, message: string): string[] {
	if (!value || value.length === 0) throw new Error(message);
	return value.map(id => requireValue(id, "issueId"));
}

function requireValue(value: string, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must not be empty`);
	return value.trim();
}

function requirePositiveInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
	return value;
}

function requireNonNegativeInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
	return value;
}

function abortError(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	return new Error("Beads command aborted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
