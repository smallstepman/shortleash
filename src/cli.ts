#!/usr/bin/env bun
/**
 * Direct pipeline runner — executes a swarm pipeline outside of the TUI.
 *
 * Usage:
 *   omp-shortleash <path-to-json-or-yaml|issue-id> [--resume|--restart]
 *   omp-shortleash plan <path-to-json-or-yaml|issue-id>
 *   omp-shortleash status <name> [--json]
 *   omp-shortleash evaluate <path-to-json-or-yaml|issue-id> [--json]
 *   omp-shortleash reconcile <path-to-json-or-yaml|issue-id> [--json]
 */

import * as fs from "node:fs/promises";
import { discoverAuthStorage, type SingleResult } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSwarmBeadsProjector } from "./swarm/beads";
import { createSwarmRunManifest } from "./swarm/manifest";
import { PipelineController } from "./swarm/pipeline";
import { formatSwarmPlan, resolveSwarmPlan, type SwarmPlan } from "./swarm/plan";
import { renderSwarmDashboardPanelLines, renderSwarmProgress } from "./swarm/render";
import { fingerprintSwarmDefinition } from "./swarm/schema";
import { StateTracker } from "./swarm/state";

interface CliOptions {
	command: "run" | "plan" | "status" | "evaluate" | "reconcile" | "dashboard";
	input: string;
	resume: boolean;
	restart: boolean;
	json: boolean;
}

const dashboardTerminalTheme = {
	fg(color: string, text: string): string {
		const codes: Record<string, string> = {
			accent: "\x1b[36m",
			borderMuted: "\x1b[90m",
			dim: "\x1b[2m",
			error: "\x1b[31m",
			muted: "\x1b[37m",
			success: "\x1b[32m",
			warning: "\x1b[33m",
		};
		const prefix = codes[color] ?? "";
		return prefix ? `${prefix}${text}\x1b[0m` : text;
	},
};

function sleepMs(milliseconds: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, milliseconds);
	return promise;
}

const options = parseArgs(process.argv.slice(2));
if (!options) {
	printUsage();
	process.exit(1);
}

try {
	if (options.command === "status") await runStatus(options);
	else if (options.command === "plan") await runPlan(options);
	else if (options.command === "evaluate") await runEvaluate(options);
	else if (options.command === "reconcile") await runReconcile(options);
	else if (options.command === "dashboard") await runDashboard(options);
	else await runPipeline(options);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

function parseArgs(args: string[]): CliOptions | undefined {
	if (args.length === 0) return undefined;
	const first = args[0];
	const command =
		first === "dashboard" ||
		first === "plan" ||
		first === "inspect" ||
		first === "status" ||
		first === "evaluate" ||
		first === "reconcile"
			? first === "inspect"
				? "plan"
				: first
			: "run";
	const positional = command === "run" ? args : args.slice(1);
	const input = positional.find(arg => !arg.startsWith("--"));
	if (!input) return undefined;
	const resume = args.includes("--resume");
	const restart = args.includes("--restart");
	if (resume && restart) throw new Error("--resume and --restart cannot be used together.");
	const json = args.includes("--json");
	const knownFlags = new Set(["--resume", "--restart", "--json"]);
	const unknown = args.filter(arg => arg.startsWith("--") && !knownFlags.has(arg));
	if (unknown.length > 0) throw new Error(`Unknown option '${unknown[0]}'.`);
	return { command, input, resume, restart, json };
}

async function runPlan(options: CliOptions): Promise<void> {
	const plan = await resolveSwarmPlan(options.input, process.cwd());
	if (options.json) {
		console.log(
			JSON.stringify(
				{
					input: plan.input,
					definitionPath: plan.definitionPath,
					workspace: plan.workspace,
					waves: plan.waves,
					pluginPaths: plan.pluginPaths,
					definition: plan.definition,
				},
				replacerForPlan,
				2,
			),
		);
		return;
	}
	console.log(formatSwarmPlan(plan).join("\n"));
}

async function runStatus(options: CliOptions): Promise<void> {
	const stateTracker = new StateTracker(process.cwd(), options.input);
	const state = await stateTracker.load();
	if (!state) throw new Error(`No state found for swarm '${options.input}' in ${process.cwd()}`);
	if (options.json) {
		console.log(JSON.stringify(state, null, 2));
		return;
	}

	console.log(renderSwarmProgress(state).join("\n"));
}

async function runDashboard(options: CliOptions): Promise<void> {
	const plan = await resolveSwarmPlan(options.input, process.cwd());
	const stateTracker = new StateTracker(plan.workspace, plan.definition.name);
	let stopped = false;
	const stop = (): void => {
		stopped = true;
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	try {
		process.stdout.write("\x1b[?25l");
		let animationFrame = 0;
		while (!stopped) {
			const state = await stateTracker.load();
			const lines = state
				? renderSwarmDashboardPanelLines(plan.definition, state, 118, dashboardTerminalTheme, animationFrame++)
				: [`Waiting for swarm '${plan.definition.name}' state in ${plan.workspace}...`];
			process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`);
			if (state && state.status !== "running") break;
			await sleepMs(250);
		}
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		process.stdout.write("\x1b[0m\x1b[?25h");
	}
}

async function runEvaluate(options: CliOptions): Promise<void> {
	const plan = await resolveSwarmPlan(options.input, process.cwd());
	const definitionHash = fingerprintSwarmDefinition(plan.definition);
	const stateTracker = new StateTracker(plan.workspace, plan.definition.name);
	await stateTracker.acquireRunLock({
		definitionHash,
		workspace: plan.workspace,
	});
	try {
		const state = await stateTracker.load();
		if (!state) throw new Error(`No state found for swarm '${plan.definition.name}' in ${plan.workspace}`);
		assertDefinitionHash(state.definitionHash, definitionHash, plan.definition.name);

		const latestResults = new Map<string, SingleResult>();
		const history = new Map<string, readonly SingleResult[]>();
		for (const [agentName, records] of Object.entries(state.results)) {
			const results = records.map(record => record.result);
			history.set(agentName, results);
			const latest = results.at(-1);
			if (latest) latestResults.set(agentName, latest);
		}
		const iteration = Math.max(0, state.nextIteration - 1);
		const decision = await plan.policyRegistry.evaluate(plan.definition, {
			definition: plan.definition,
			cwd: process.cwd(),
			workspace: plan.workspace,
			swarmDir: stateTracker.swarmDir,
			boundary: "complete",
			iteration,
			params: {},
			latestResults,
			history,
			state,
		});
		await stateTracker.updatePolicy(decision, { iteration });

		if (options.json) {
			console.log(JSON.stringify(decision, null, 2));
		} else {
			console.log(`Evaluation: ${decision.accepted ? "accepted" : "blocked"}`);
			for (const evaluation of decision.evaluations) {
				console.log(`  ${evaluation.id}@${evaluation.version}: ${evaluation.outcome} — ${evaluation.explanation}`);
			}
			for (const failure of decision.failures) {
				console.log(`  ${failure.source} ${failure.id}: ${failure.message}`);
			}
		}
		if (!decision.accepted) process.exitCode = 1;
	} finally {
		await stateTracker.releaseRunLock();
	}
}
async function runReconcile(options: CliOptions): Promise<void> {
	const plan = await resolveSwarmPlan(options.input, process.cwd());
	if (!plan.source.beadId) {
		throw new Error("Reconciliation requires a Beads issue ID or issue:// reference.");
	}
	const definitionHash = fingerprintSwarmDefinition(plan.definition);
	const stateTracker = new StateTracker(plan.workspace, plan.definition.name);
	const state = await stateTracker.load();
	if (!state) throw new Error(`No state found for swarm '${plan.definition.name}' in ${plan.workspace}`);
	assertDefinitionHash(state.definitionHash, definitionHash, plan.definition.name);
	const reconciliation = await createSwarmBeadsProjector(plan.source.beadId, process.cwd()).reconcile(state.status);
	if (options.json) {
		console.log(JSON.stringify(reconciliation, null, 2));
	} else {
		console.log(`Bead: ${reconciliation.beadId}`);
		console.log(`Authoritative status: ${reconciliation.authoritativeStatus}`);
		console.log(`Bead status: ${reconciliation.beadStatus ?? "unknown"}`);
		console.log(`Drift: ${reconciliation.drift ? "yes" : "no"}`);
		if (reconciliation.reason) console.log(`Reason: ${reconciliation.reason}`);
	}
	if (reconciliation.drift) process.exitCode = 1;
}

async function runPipeline(options: CliOptions): Promise<void> {
	const plan: SwarmPlan = await resolveSwarmPlan(options.input, process.cwd());
	const { definition: def, workspace, waves, definitionPath, pluginPaths, policyRegistry } = plan;
	if (def.agents.size === 0) {
		throw new Error(
			"Direct Shortleash definitions must be run from the OMP session with /shortleash run; the standalone CLI has no current session.",
		);
	}
	await fs.mkdir(workspace, { recursive: true });
	const beadsProjector = plan.source.beadId ? createSwarmBeadsProjector(plan.source.beadId, process.cwd()) : undefined;
	console.log(`Reading: ${options.input}`);
	console.log(`Shortleash: ${def.name}`);
	console.log(`Mode: ${def.mode}`);
	console.log(`Failure policy: ${def.failurePolicy}`);
	console.log(`Target count: ${def.targetCount}`);
	console.log(`Agents: ${[...def.agents.keys()].join(", ")}`);
	console.log(`Waves: ${waves.map((wave, index) => `W${index + 1}:[${wave.join(",")}]`).join(" -> ")}`);
	console.log(`Workspace: ${workspace}`);

	const stateTracker = new StateTracker(workspace, def.name);
	const definitionHash = fingerprintSwarmDefinition(def);
	const manifest = await createSwarmRunManifest(def, {
		definitionPath,
		definitionHash,
		workspace,
		pluginPaths,
		cwd: process.cwd(),
	});
	try {
		await stateTracker.acquireRunLock(
			{ definitionHash, workspace },
			{ allowStaleRecovery: options.resume || options.restart },
		);
		await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode, {
			definitionHash,
			workspace,
			definitionPath,
			manifest,
			resume: options.resume,
			restart: options.restart,
		});
	} catch (error) {
		await stateTracker.releaseRunLock().catch(() => {});
		throw error;
	}

	let modelRegistry: ModelRegistry;
	let settings: Settings;
	try {
		const authStorage = await discoverAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
		settings = Settings.isolated();
	} catch (error) {
		await stateTracker.releaseRunLock().catch(() => {});
		throw error;
	}
	const abortController = new AbortController();
	const onInterrupt = () => {
		if (abortController.signal.aborted) return;
		console.error("Cancellation requested; waiting for active agents to stop...");
		abortController.abort(new Error("Cancelled by SIGINT."));
	};
	process.on("SIGINT", onInterrupt);

	let lastProgressDump = 0;
	const PROGRESS_INTERVAL_MS = 5000;
	try {
		console.log("\n--- Pipeline starting ---\n");
		const controller = new PipelineController(def, waves, stateTracker);
		const result = await controller.run({
			workspace,
			cwd: plan.definitionDir,
			signal: abortController.signal,
			resume: options.resume,
			onProgress: () => {
				const now = Date.now();
				if (now - lastProgressDump <= PROGRESS_INTERVAL_MS) return;
				lastProgressDump = now;
				console.log(renderSwarmProgress(stateTracker.state).join("\n"));
				console.log();
			},
			modelRegistry,
			settings,
			policyRegistry,
			beadsProjector,
		});

		console.log("\n--- Pipeline finished ---\n");
		console.log(`Status: ${result.status}`);
		console.log(`Iterations completed: ${result.iterations}/${def.targetCount}`);
		if (result.errors.length > 0) {
			console.log(`Errors (${result.errors.length}):`);
			for (const error of result.errors) console.log(`  - ${error}`);
		}
		console.log(`\nState saved to: ${stateTracker.swarmDir}`);
		console.log(renderSwarmProgress(stateTracker.state).join("\n"));
		if (options.json) console.log(JSON.stringify({ result, state: stateTracker.state }, replacerForPlan, 2));
		if (result.status !== "completed") process.exitCode = 1;
	} finally {
		process.off("SIGINT", onInterrupt);
		await stateTracker.releaseRunLock();
	}
}

function replacerForPlan(_key: string, value: unknown): unknown {
	if (value instanceof Map) return Object.fromEntries(value);
	return value;
}

function assertDefinitionHash(actual: string, expected: string, name: string): void {
	if (actual !== "unknown" && actual !== "legacy" && actual !== expected) {
		throw new Error(`Persisted state for shortleash '${name}' was created from a different definition.`);
	}
}

function printUsage(): void {
	console.error(
		[
			"Usage:",
			"  omp-shortleash <path-to-json-or-yaml|issue-id> [--resume|--restart]",
			"  omp-shortleash plan <path-to-json-or-yaml|issue-id> [--json]",
			"  omp-shortleash status <name> [--json]",
			"  omp-shortleash evaluate <path-to-json-or-yaml|issue-id> [--json]",
			"  omp-shortleash dashboard <path-to-json-or-yaml|issue-id>       Render a live dashboard in a terminal pane",
		].join("\n"),
	);
}
