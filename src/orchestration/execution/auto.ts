import * as fs from "node:fs/promises";
import type { ExtensionContext, Settings } from "@oh-my-pi/pi-coding-agent";
import { createSwarmBeadsProjector } from "../adapters/beads";
import { createHerdrSwarmSession, type HerdrControl } from "../adapters/herdr";
import { createSwarmRunManifest } from "../definition/manifest";
import { resolveSwarmPlan, type SwarmPlan } from "../definition/plan";
import { fingerprintSwarmDefinition } from "../definition/schema";
import type { SwarmPluginLogger } from "../policy/plugins";
import { attachSwarmDashboard } from "../presentation/dashboard";
import { PipelineController } from "./pipeline";
import type { PipelineStatus } from "./state";
import { StateTracker } from "./state";

export type ClaimedSwarmStatus =
	| "completed"
	| "failed"
	| "aborted"
	| "already-running"
	| "already-completed"
	| "not-started";

export interface ClaimedSwarmResult {
	status: ClaimedSwarmStatus;
	swarmName?: string;
	iterations?: number;
	errors?: string[];
	reason?: string;
}

export interface ClaimedSwarmRunnerOptions {
	ctx: ExtensionContext;
	settings: Settings;
	signal?: AbortSignal;
	logger?: SwarmPluginLogger;
	/** Intentionally execute again when persisted state already exists. */
	restart?: boolean;
	/** Current-session direct runner supplied by the OMP adapter. */
	directRunner?: (plan: SwarmPlan, options: { restart: boolean }) => Promise<ClaimedSwarmResult>;
	/** Optional control seam for deterministic host integration tests. */
	herdrControl?: HerdrControl;
}

/** Run the swarm definition attached to a claimed Bead, reusing persisted state unless restart is explicit. */
export async function runClaimedSwarm(
	issueId: string,
	options: ClaimedSwarmRunnerOptions,
): Promise<ClaimedSwarmResult> {
	const { ctx, settings, signal, logger } = options;
	const plan = await resolveSwarmPlan(issueId, ctx.cwd, { logger });
	const { definition, workspace, waves, definitionPath, pluginPaths, policyRegistry } = plan;
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
	const definitionHash = fingerprintSwarmDefinition(definition);
	const manifest = await createSwarmRunManifest(definition, {
		definitionPath,
		definitionHash,
		workspace,
		pluginPaths,
		cwd: ctx.cwd,
	});

	try {
		await stateTracker.acquireRunLock(
			{ definitionHash, workspace },
			{ allowStaleRecovery: options.restart === true },
		);
		await stateTracker.init([...definition.agents.keys()], definition.targetCount, definition.mode, {
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
				swarmName: definition.name,
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
	let dashboard: ReturnType<typeof attachSwarmDashboard> | undefined;
	let herdrSession: Awaited<ReturnType<typeof createHerdrSwarmSession>>;
	try {
		dashboard = attachSwarmDashboard(ctx, definition, stateTracker, () => {
			runAbortController.abort(new Error("Cancelled from the Shortleash dashboard."));
		});
		herdrSession =
			definition.agentExecution === "herdr"
				? await createHerdrSwarmSession({
						client: options.herdrControl,
						definition,
						definitionInput: definitionPath,
						workspace,
						cwd: ctx.cwd,
						logger,
					})
				: undefined;
		const beadsProjector = plan.source.beadId ? createSwarmBeadsProjector(plan.source.beadId, ctx.cwd) : undefined;
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
			agentRunner: herdrSession?.runAgent,
		});
		return {
			status: result.status,
			swarmName: definition.name,
			iterations: result.iterations,
			errors: result.errors,
		};
	} finally {
		signal?.removeEventListener("abort", abortFromParent);
		await dashboard?.dispose();
		await herdrSession?.dispose();
		await stateTracker.releaseRunLock();
	}
}

function existingRunResult(status: PipelineStatus, swarmName: string): ClaimedSwarmResult {
	if (status === "running")
		return { status: "already-running", swarmName, reason: "A persisted Shortleash run is already running." };
	if (status === "completed")
		return { status: "already-completed", swarmName, reason: "The persisted Shortleash run is already completed." };
	return {
		status: "not-started",
		swarmName,
		reason: `A persisted Shortleash run has status '${status}'; use an explicit /shortleash run --resume or --restart command.`,
	};
}

function isAlreadyRunningError(error: unknown): boolean {
	return /already running/i.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
