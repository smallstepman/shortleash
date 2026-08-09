import * as path from "node:path";
import { validateShortleashMetadata } from "../definition/metadata";
import { parseShortleash, type ShortleashDefinition } from "../definition/schema";
import type { PipelineStatus } from "../execution/state";

export interface ShortleashBeadRecord {
	id: string;
	title: string;
	description?: string;
	metadata?: unknown;
}

export type ShortleashBeadReader = (id: string, cwd: string) => Promise<ShortleashBeadRecord>;

export interface ShortleashInputOptions {
	readBead?: ShortleashBeadReader;
}

export interface ResolvedShortleashInput {
	definition: ShortleashDefinition;
	definitionPath: string;
	definitionDir: string;
	beadId?: string;
}

export function isIssueReference(value: string): boolean {
	return value.trim().startsWith("issue://");
}

export async function resolveShortleashInput(
	input: string,
	cwd: string,
	options: ShortleashInputOptions = {},
): Promise<ResolvedShortleashInput> {
	const requested = input.trim();
	if (requested.length === 0) throw new Error("A Shortleash definition path or Beads issue ID is required.");

	if (!isIssueReference(requested)) {
		const resolvedPath = path.isAbsolute(requested) ? requested : path.resolve(cwd, requested);
		if (await Bun.file(resolvedPath).exists()) {
			const content = await Bun.file(resolvedPath).text();
			return {
				definition: parseShortleash(content),
				definitionPath: resolvedPath,
				definitionDir: path.dirname(resolvedPath),
			};
		}
		if (looksLikeDefinitionPath(requested)) {
			throw new Error(`Cannot read Shortleash definition file: ${resolvedPath}`);
		}
	}

	const beadId = normalizeIssueReference(requested);
	const reader = options.readBead ?? readBeadFromBd;
	const bead = await reader(beadId, cwd);
	return {
		definition: shortleashDefinitionFromBead(bead),
		definitionPath: `issue://${beadId}`,
		definitionDir: cwd,
		beadId,
	};
}

export function shortleashDefinitionFromBead(bead: ShortleashBeadRecord): ShortleashDefinition {
	const metadata = normalizeMetadata(bead.metadata);
	if (!isRecord(metadata.shortleash)) {
		throw new Error(
			"Bead metadata must contain an object at 'metadata.shortleash' using the standard Shortleash definition schema.",
		);
	}

	try {
		return validateShortleashMetadata(metadata);
	} catch (error) {
		throw new Error(`metadata.shortleash is not a valid Shortleash definition: ${errorMessage(error)}`);
	}
}

async function readBeadFromBd(id: string, cwd: string): Promise<ShortleashBeadRecord> {
	if (typeof Bun === "undefined") {
		throw new Error("Beads-backed Shortleash input requires the Bun runtime.");
	}

	const processHandle = Bun.spawn(["bd", "show", id, "--json"], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	if (code !== 0) {
		const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
		throw new Error(`bd show ${id} failed: ${detail}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error(`bd show ${id} returned invalid JSON: ${errorMessage(error)}`);
	}

	const records = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : parsed;
	const candidates = Array.isArray(records) ? records : [records];
	const raw = candidates.find(
		(candidate): candidate is Record<string, unknown> => isRecord(candidate) && candidate.id === id,
	);
	if (!raw) throw new Error(`bd show returned no item for '${id}'.`);
	return toBeadRecord(raw);
}

function toBeadRecord(value: Record<string, unknown>): ShortleashBeadRecord {
	if (typeof value.id !== "string" || value.id.trim().length === 0) {
		throw new Error("bd show returned an item without an id.");
	}
	return {
		id: value.id,
		title: typeof value.title === "string" && value.title.trim().length > 0 ? value.title : value.id,
		description: typeof value.description === "string" ? value.description : undefined,
		metadata: value.metadata,
	};
}

function normalizeIssueReference(value: string): string {
	const id = isIssueReference(value) ? value.slice("issue://".length).trim() : value.trim();
	if (id.length === 0) throw new Error("The issue:// reference must include a Beads issue ID.");
	if (/\s/.test(id)) throw new Error("Beads issue IDs must not contain whitespace.");
	return id;
}

function looksLikeDefinitionPath(value: string): boolean {
	return path.isAbsolute(value) || value.includes("/") || value.startsWith(".") || /\.(?:json|ya?ml)$/i.test(value);
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
	if (isRecord(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed)) return parsed;
		} catch {
			// Fall through to the actionable metadata error below.
		}
		throw new Error("Bead metadata must be a JSON object.");
	}
	throw new Error("Bead metadata must be an object containing a 'shortleash' field.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class MissingShortleashBeadError extends Error {
	readonly name = "MissingShortleashBeadError";
}

export type ShortleashProjectionEventType = "started" | "blocked" | "failed" | "aborted" | "completed";

export interface ShortleashProjectionEvent {
	type: ShortleashProjectionEventType;
	shortleashName: string;
	status: PipelineStatus;
	detail?: string;
}

export interface ShortleashBeadsReconciliation {
	beadId: string;
	beadStatus?: string;
	authoritativeStatus: PipelineStatus;
	drift: boolean;
	missing?: boolean;
	reason?: string;
}

export type ShortleashBeadsCommandRunner = (args: string[], cwd: string) => Promise<string>;

export interface ShortleashBeadsProjector {
	targetId: string;
	project(event: ShortleashProjectionEvent): Promise<void>;
	reconcile(authoritativeStatus: PipelineStatus): Promise<ShortleashBeadsReconciliation>;
}

/** Project lifecycle milestones into the input Bead without closing it authoritatively. */
export function createShortleashBeadsProjector(
	beadId: string,
	cwd: string,
	options: { run?: ShortleashBeadsCommandRunner } = {},
): ShortleashBeadsProjector {
	const run = options.run ?? runBd;
	return {
		targetId: beadId,
		async project(event: ShortleashProjectionEvent): Promise<void> {
			const detail = event.detail ? ` — ${event.detail}` : "";
			const note = `[shortleash:${event.shortleashName}] ${event.type}: ${event.status}${detail}`;
			const bead = await readBead(beadId, cwd, run);
			if (!bead) throw new Error(`Bead '${beadId}' no longer exists.`);
			if (bead.notes?.split("\n").some(line => line.trim() === note)) return;
			const notes = [bead.notes?.trim(), note].filter(Boolean).join("\n");
			await run(["update", beadId, "--notes", notes], cwd);
		},
		async reconcile(authoritativeStatus: PipelineStatus): Promise<ShortleashBeadsReconciliation> {
			const bead = await readBead(beadId, cwd, run);
			if (!bead) {
				return {
					beadId,
					authoritativeStatus,
					drift: true,
					missing: true,
					reason: "Projected Bead is missing.",
				};
			}
			const drift = bead.status === "closed" && authoritativeStatus !== "completed";
			return {
				beadId,
				beadStatus: bead.status,
				authoritativeStatus,
				drift,
				...(drift ? { reason: "Bead is closed while the authoritative Shortleash run is not completed." } : {}),
			};
		},
	};
}

async function runBd(args: string[], cwd: string): Promise<string> {
	const processHandle = Bun.spawn(["bd", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	if (code !== 0) {
		const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
		if (/(?:not found|no issue|does not exist|unknown issue)/i.test(detail)) {
			throw new MissingShortleashBeadError(`Bead '${args[1] ?? "unknown"}' was not found.`);
		}
		throw new Error(`bd ${args.join(" ")} failed: ${detail}`);
	}
	return stdout;
}

interface ShortleashBeadSnapshot {
	status?: string;
	notes?: string;
}

async function readBead(
	id: string,
	cwd: string,
	run: ShortleashBeadsCommandRunner,
): Promise<ShortleashBeadSnapshot | undefined> {
	let stdout: string;
	try {
		stdout = await run(["show", id, "--json"], cwd);
	} catch (error) {
		if (error instanceof MissingShortleashBeadError) return undefined;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error(`bd show ${id} returned invalid JSON: ${errorMessage(error)}`);
	}
	const records = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : parsed;
	const candidates = Array.isArray(records) ? records : [records];
	const raw = candidates.find(
		(candidate): candidate is Record<string, unknown> => isRecord(candidate) && candidate.id === id,
	);
	if (!raw) return undefined;
	return {
		status: typeof raw.status === "string" ? raw.status : undefined,
		notes: typeof raw.notes === "string" ? raw.notes : undefined,
	};
}
