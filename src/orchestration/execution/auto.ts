import * as fs from "node:fs/promises";
import type { ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import { createShortleashBeadsProjector } from "../adapters/beads";
import { createShortleashRunManifest } from "../definition/manifest";
import { resolveShortleashPlan, type ShortleashPlan } from "../definition/plan";
import { fingerprintShortleashDefinition } from "../definition/schema";
import { attachShortleashDashboard } from "../presentation/dashboard";
import { PipelineController } from "./pipeline";
import type { PipelineStatus } from "./state";
import { StateTracker } from "./state";

export type ClaimedShortleashStatus =
	| "completed"
	| "failed"
	| "aborted"
	| "already-running"
	| "already-completed"
	| "not-started";

export interface ClaimedShortleashResult {
	status: ClaimedShortleashStatus;
	shortleashName?: string;
	errors?: string[];
	reason?: string;
}

export interface ClaimedShortleashRunnerOptions {
	ctx: ExtensionContext;
	settings: Settings;
	signal?: AbortSignal;
	/** Intentionally execute again when persisted state already exists. */
	restart?: boolean;
	/** Current-session direct runner supplied by the OMP adapter. */
	directRunner?: (plan: ShortleashPlan, options: { restart: boolean }) => Promise<ClaimedShortleashResult>;
}

/** Run the Shortleash definition attached to a claimed Bead, reusing persisted state unless restart is explicit. */
export async function runClaimedShortleash(
	issueId: string,
	options: ClaimedShortleashRunnerOptions,
): Promise<ClaimedShortleashResult> {
	const { ctx, settings, signal } = options;
	const plan = await resolveShortleashPlan(issueId, ctx.cwd);
	const { definition, workspace, waves, definitionPath, policyPaths, policyRegistry } = plan;
	const stateTracker = new StateTracker(workspace, definition.name);
	const existing = await stateTracker.load();
	if (existing && !options.restart) return existingRunResult(existing.status, definition.name);
	if (definition.agents.size === 0) {
		if (!options.directRunner) {
			throw new Error("Direct Shortleash definitions attached to Beads require the current OMP session runner.");
		}
		return options.directRunner(plan, { restart: options.restart === true });
	}

	await fs.mkdir(workspace, { recursive: true });
	const definitionHash = fingerprintShortleashDefinition(definition);
	const manifest = await createShortleashRunManifest(definition, {
		definitionPath,
		definitionHash,
		workspace,
		policyPaths,
		cwd: ctx.cwd,
	});

	try {
		await stateTracker.acquireRunLock(
			{ definitionHash, workspace },
			{ allowStaleRecovery: options.restart === true },
		);
		await stateTracker.init([...definition.agents.keys()], {
			definitionHash,
			workspace,
			definitionPath,
			manifest,
			restart: options.restart,
		});
	} catch (error) {
		await stateTracker.releaseRunLock().catch(() => {});
		if (isAlreadyRunningError(error)) {
			return {
				status: "already-running",
				shortleashName: definition.name,
				reason: errorMessage(error),
			};
		}
		throw error;
	}

	const parentMessages = ctx.sessionManager
		.getBranch()
		.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
	const runAbortController = new AbortController();
	const abortFromParent = (): void => {
		runAbortController.abort(signal?.reason);
	};
	if (signal?.aborted) abortFromParent();
	else signal?.addEventListener("abort", abortFromParent, { once: true });
	let dashboard: ReturnType<typeof attachShortleashDashboard> | undefined;
	try {
		dashboard = attachShortleashDashboard(ctx, definition, stateTracker, () => {
			runAbortController.abort(new Error("Cancelled from the Shortleash dashboard."));
		});
		const beadsProjector = plan.source.beadId
			? createShortleashBeadsProjector(plan.source.beadId, ctx.cwd)
			: undefined;
		const result = await new PipelineController(definition, waves, stateTracker).run({
			workspace,
			cwd: ctx.cwd,
			signal: runAbortController.signal,
			onProgress: () => dashboard?.update(),
			modelRegistry: ctx.modelRegistry,
			settings,
			parentMessages,
			policyRegistry,
			beadsProjector,
		});
		return {
			status: result.status,
			shortleashName: definition.name,
			errors: result.errors,
		};
	} finally {
		signal?.removeEventListener("abort", abortFromParent);
		await dashboard?.dispose();
		await stateTracker.releaseRunLock();
	}
}

function existingRunResult(status: PipelineStatus, shortleashName: string): ClaimedShortleashResult {
	if (status === "running")
		return { status: "already-running", shortleashName, reason: "A persisted Shortleash run is already running." };
	if (status === "completed")
		return {
			status: "already-completed",
			shortleashName,
			reason: "The persisted Shortleash run is already completed.",
		};
	return {
		status: "not-started",
		shortleashName,
		reason: `A persisted Shortleash run has status '${status}'; use an explicit /shortleash run --resume or --restart command.`,
	};
}

function isAlreadyRunningError(error: unknown): boolean {
	return /already running/i.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
