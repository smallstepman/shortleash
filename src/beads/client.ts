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

/** Unwrap the JSON envelope emitted by the installed `bd` CLI. */
export function extractBeadsData(value: unknown): unknown {
	if (!isRecord(value) || !Object.hasOwn(value, "data")) return value;
	return value.data;
}

export function extractBeadsIssueRecords(data: unknown): BeadsIssueRecord[] {
	const candidates = extractBeadsData(data);
	const values = Array.isArray(candidates) ? candidates : [candidates];
	return values.flatMap(candidate => {
		if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0) return [];
		return [
			{
				id: candidate.id,
				title: typeof candidate.title === "string" ? candidate.title : undefined,
				description: typeof candidate.description === "string" ? candidate.description : undefined,
				type:
					typeof candidate.type === "string"
						? candidate.type
						: typeof candidate.issue_type === "string"
							? candidate.issue_type
							: undefined,
				status: typeof candidate.status === "string" ? candidate.status : undefined,
				metadata: candidate.metadata,
			},
		];
	});
}

export function parseBeadsJson(text: string, args: readonly string[] = []): BeadsCommandResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(`bd ${args.join(" ")} returned invalid JSON: ${errorMessage(error)}`);
	}
	const data = extractBeadsData(raw);
	return {
		args,
		raw,
		data,
		text: JSON.stringify(data, null, 2) ?? "null",
	};
}

export async function runBeadsJson(
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
	runner: BeadsCommandRunner = runBeadsCommand,
): Promise<BeadsCommandResult> {
	const commandArgs = args.includes("--json") ? [...args] : [...args, "--json"];
	return parseBeadsJson(await runner(commandArgs, cwd, signal), args);
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
		env: { ...process.env, PWD: cwd },
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
