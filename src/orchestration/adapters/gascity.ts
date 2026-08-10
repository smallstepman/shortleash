import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BeadsCommandRunner,
	type BeadsIssueRecord,
	extractBeadsIssueRecords,
	runBeadsCommand,
	runBeadsJson,
} from "../../beads/client";
import type { ShortleashPlan } from "../definition/plan";
import {
	fingerprintShortleashDefinition,
	type ShortleashAgent,
	serializeShortleashDefinition,
} from "../definition/schema";
import { buildDependencyGraph } from "../execution/dag";
import type { ShortleashPolicyReferences } from "../policy/policies";
import type { GasCityPolicyBridgeConfig, GasCityPolicyModuleSnapshot } from "./gascity-check";

export type GasCityCommandRunner = (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<string>;

export interface GasCityCommandResult {
	args: readonly string[];
	raw: unknown;
	text: string;
}

export class GasCityCommandError extends Error {
	readonly name = "GasCityCommandError";
	readonly args: readonly string[];
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;

	constructor(args: readonly string[], code: number, stdout: string, stderr: string) {
		const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
		super(`gc ${args.join(" ")} failed: ${detail}`);
		this.args = args;
		this.code = code;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

export interface GasCityWorkflowOptions {
	/** Working directory used for `gc` and `bd` discovery. */
	cwd: string;
	run?: GasCityCommandRunner;
	beadsRun?: BeadsCommandRunner;
	restart?: boolean;
	resume?: boolean;
	/** Total Gas City check attempts, including the initial worker attempt. */
	maxCheckAttempts?: number;
	/** Qualified Gas City agent or pool that receives the cooked workflow root. */
	routeTarget?: string;
}

export interface GasCityWorkflowResult {
	cityPath: string;
	formulaName: string;
	rootId: string;
	created: number;
	attachBeadId?: string;
	bridgeBeadId?: string;
	definitionHash: string;
	policyBundleHash: string;
	runtimePath: string;
	routedTo?: string;
	warnings: readonly string[];
}

interface GasCityJsonObject {
	[key: string]: unknown;
}

interface GasCityStep {
	id: string;
	agentName: string;
	needs: readonly string[];
	policyKey?: string;
	boundary: "agent" | "complete";
	agent?: ShortleashAgent;
	checks: ShortleashPolicyReferences;
}

interface GasCityRuntimePaths {
	root: string;
	configs: string;
	checks: string;
	histories: string;
	results: string;
}

interface GasCityBridgeSpec {
	key: string;
	configPath: string;
	scriptPath: string;
	historyPath: string;
	step: GasCityStep;
}

const DEFAULT_GAS_CITY_CHECK_ATTEMPTS = 4;
const GAS_CITY_FORMULA_COMPILER = ">=2.0.0";

export function parseGasCityJson(text: string, args: readonly string[] = []): GasCityCommandResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new Error(`gc ${args.join(" ")} returned invalid JSON: ${errorMessage(error)}`);
	}
	if (isGasCityJsonObject(raw) && raw.ok === false) {
		const failure = isGasCityJsonObject(raw.error) ? raw.error.message : undefined;
		throw new Error(`gc ${args.join(" ")} failed: ${typeof failure === "string" ? failure : "unknown error"}`);
	}
	return {
		args,
		raw,
		text: JSON.stringify(raw, null, 2) ?? "null",
	};
}

export async function runGasCityJson(
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
	runner: GasCityCommandRunner = runGasCityCommand,
): Promise<GasCityCommandResult> {
	const commandArgs = args.includes("--json") ? [...args] : [...args, "--json"];
	return parseGasCityJson(await runner(commandArgs, cwd, signal), args);
}

export async function runGasCityCommand(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw abortError(signal);
	const processHandle = Bun.spawn(["gc", ...args], {
		cwd,
		// Gas City parses legacy root-level bd JSON responses internally. Keep
		// the host's envelope preference from changing that subprocess contract.
		env: { ...process.env, PWD: cwd, BD_JSON_ENVELOPE: "0" },
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
		if (code !== 0) throw new GasCityCommandError(args, code, stdout, stderr);
		return stdout;
	} finally {
		signal?.removeEventListener("abort", abortHandler);
	}
}

export async function compileShortleashToGasCity(
	plan: ShortleashPlan,
	options: GasCityWorkflowOptions,
): Promise<GasCityWorkflowResult> {
	const run = options.run ?? runGasCityCommand;
	const beadsRun = options.beadsRun ?? runBeadsCommand;
	const cityPath = await discoverCityPath(options.cwd, run);
	const definitionHash = fingerprintShortleashDefinition(plan.definition);
	const formulaName = `shortleash-${plan.definition.name}-${definitionHash.slice(0, 12)}`;
	const runtimePaths = createRuntimePaths(cityPath, formulaName);
	const policyModules = await policyModuleSnapshots(plan.policyPaths);
	const policyBundleHash = hashJson(policyModules);
	const warnings = collectWarnings(plan, options);
	const workflowPath = path.join(runtimePaths.root, "workflow.json");
	const existing =
		options.resume && !options.restart
			? await readExistingGasCityWorkflow(runtimePaths, cityPath, formulaName, definitionHash, policyBundleHash)
			: undefined;
	if (existing) return await ensureGasCityWorkflowRouted(existing, workflowPath, options, run);
	if (options.resume && !options.restart) {
		warnings.push("No persisted Gas City workflow matched this definition; materialized a new workflow.");
	}
	const steps = buildGasCitySteps(plan);
	const specs = await writeBridgeFiles(plan, cityPath, runtimePaths, steps, policyModules, definitionHash);
	const formulaPath = path.join(cityPath, "formulas", `${formulaName}.toml`);
	const formula = renderGasCityFormula(
		plan,
		cityPath,
		formulaName,
		steps,
		specs,
		definitionHash,
		policyBundleHash,
		options.maxCheckAttempts ?? DEFAULT_GAS_CITY_CHECK_ATTEMPTS,
	);
	await fs.mkdir(path.dirname(formulaPath), { recursive: true });
	await fs.writeFile(formulaPath, formula, "utf8");

	let attachBeadId: string | undefined;
	let bridgeBeadId: string | undefined;
	try {
		if (plan.source.beadId) {
			const target = await prepareGasCityAttachment(
				plan.source.beadId,
				plan.definition.name,
				formulaName,
				definitionHash,
				options.cwd,
				beadsRun,
				Boolean(options.restart),
			);
			attachBeadId = target.attachBeadId;
			bridgeBeadId = target.bridgeBeadId;
		}
		const args = ["formula", "cook", formulaName, "--json"];
		if (attachBeadId) args.push(`--attach=${attachBeadId}`);
		const cooked = await runGasCityJson(args, options.cwd, undefined, run);
		const data = gasCityData(cooked.raw);
		const rootId = requiredString(data.root_id, "gc formula cook root_id");
		const created = requiredNumber(data.created, "gc formula cook created");
		const workflow = {
			schemaVersion: 1,
			definitionHash,
			formulaName,
			formulaPath,
			rootId,
			created,
			attachBeadId,
			bridgeBeadId,
			policyBundleHash,
			policyModules,
			warnings,
			createdAt: Date.now(),
		};
		await writeJsonAtomically(workflowPath, workflow);
		const routedTo = options.routeTarget
			? await routeGasCityWorkflow(options.routeTarget, rootId, options.cwd, run)
			: undefined;
		if (routedTo) await writeJsonAtomically(workflowPath, { ...workflow, routedTo });
		return {
			cityPath,
			formulaName,
			rootId,
			created,
			attachBeadId,
			bridgeBeadId,
			definitionHash,
			policyBundleHash,
			runtimePath: runtimePaths.root,
			routedTo,
			warnings,
		};
	} finally {
		await fs.rm(formulaPath, { force: true });
	}
}

async function discoverCityPath(cwd: string, run: GasCityCommandRunner): Promise<string> {
	const result = await runGasCityJson(["formula", "list"], cwd, undefined, run);
	const data = gasCityData(result.raw);
	return requiredString(data.city_path, "gc formula list city_path");
}

function createRuntimePaths(cityPath: string, formulaName: string): GasCityRuntimePaths {
	const root = path.join(cityPath, ".omp", "shortleash", "gascity", formulaName);
	return {
		root,
		configs: path.join(root, "configs"),
		checks: path.join(root, "checks"),
		histories: path.join(root, "histories"),
		results: path.join(root, "results"),
	};
}
async function readExistingGasCityWorkflow(
	runtimePaths: GasCityRuntimePaths,
	cityPath: string,
	formulaName: string,
	definitionHash: string,
	policyBundleHash: string,
): Promise<GasCityWorkflowResult | undefined> {
	const workflowPath = path.join(runtimePaths.root, "workflow.json");
	let raw: unknown;
	try {
		raw = JSON.parse(await fs.readFile(workflowPath, "utf8"));
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw new Error(`Cannot read persisted Gas City workflow '${workflowPath}': ${errorMessage(error)}`);
	}
	if (!isGasCityJsonObject(raw) || raw.schemaVersion !== 1) {
		throw new Error(`Persisted Gas City workflow '${workflowPath}' has an unsupported schema.`);
	}
	const storedFormulaName = requiredString(raw.formulaName, "persisted Gas City formulaName");
	if (storedFormulaName !== formulaName) {
		throw new Error(`Persisted Gas City workflow formula '${storedFormulaName}' does not match '${formulaName}'.`);
	}
	const storedDefinitionHash = requiredString(raw.definitionHash, "persisted Gas City definitionHash");
	if (storedDefinitionHash !== definitionHash) {
		throw new Error("Persisted Gas City workflow definition hash changed; use --restart.");
	}
	const warnings = Array.isArray(raw.warnings)
		? raw.warnings.filter((warning): warning is string => typeof warning === "string")
		: [];
	return {
		cityPath,
		formulaName,
		rootId: requiredString(raw.rootId, "persisted Gas City rootId"),
		created: requiredNumber(raw.created, "persisted Gas City created"),
		attachBeadId: optionalString(raw.attachBeadId),
		bridgeBeadId: optionalString(raw.bridgeBeadId),
		definitionHash,
		policyBundleHash,
		runtimePath: runtimePaths.root,
		routedTo: optionalString(raw.routedTo),
		warnings,
	};
}

async function ensureGasCityWorkflowRouted(
	result: GasCityWorkflowResult,
	workflowPath: string,
	options: GasCityWorkflowOptions,
	run: GasCityCommandRunner,
): Promise<GasCityWorkflowResult> {
	if (!options.routeTarget || result.routedTo === options.routeTarget) return result;
	if (result.routedTo) {
		throw new Error(
			`Persisted Gas City workflow is already routed to '${result.routedTo}'; use --restart to route a new workflow to '${options.routeTarget}'.`,
		);
	}
	const routedTo = await routeGasCityWorkflow(options.routeTarget, result.rootId, options.cwd, run);
	let persisted: unknown;
	try {
		persisted = JSON.parse(await fs.readFile(workflowPath, "utf8"));
	} catch (error) {
		throw new Error(`Cannot update persisted Gas City workflow '${workflowPath}': ${errorMessage(error)}`);
	}
	if (!isGasCityJsonObject(persisted)) {
		throw new Error(`Persisted Gas City workflow '${workflowPath}' is not a JSON object.`);
	}
	await writeJsonAtomically(workflowPath, { ...persisted, routedTo });
	return { ...result, routedTo };
}

async function routeGasCityWorkflow(
	target: string,
	rootId: string,
	cwd: string,
	run: GasCityCommandRunner,
): Promise<string> {
	const normalizedTarget = target.trim();
	if (!normalizedTarget) throw new Error("Gas City route target must not be empty.");
	await runGasCityJson(["sling", normalizedTarget, rootId, "--no-formula"], cwd, undefined, run);
	return normalizedTarget;
}

function buildGasCitySteps(plan: ShortleashPlan): GasCityStep[] {
	const dependencies = buildDependencyGraph(plan.definition);
	const idByAgent = new Map<string, string>();
	for (const [index, name] of plan.definition.agentOrder.entries()) {
		idByAgent.set(name, `agent-${index}-${slug(name)}`);
	}
	const steps: GasCityStep[] = [];
	if (plan.definition.agents.size === 0) {
		steps.push({
			id: "current-session",
			agentName: "current",
			needs: [],
			boundary: "complete",
			checks: { checks: plan.definition.checks, evals: plan.definition.evals },
		});
		return steps;
	}
	for (const agentName of plan.definition.agentOrder) {
		const agent = plan.definition.agents.get(agentName);
		if (!agent) throw new Error(`Shortleash agent '${agentName}' disappeared while compiling Gas City workflow.`);
		const stepId = idByAgent.get(agentName);
		if (!stepId) throw new Error(`Missing Gas City step ID for Shortleash agent '${agentName}'.`);
		steps.push({
			id: stepId,
			agentName,
			needs: [...(dependencies.get(agentName) ?? [])].map(dependency => idByAgent.get(dependency)!).filter(Boolean),
			boundary: "agent",
			agent,
			checks: { checks: agent.checks, evals: agent.evals },
		});
	}
	if (plan.definition.checks.length > 0 || plan.definition.evals.length > 0) {
		const dependent = new Set(steps.flatMap(step => step.needs));
		const sinks = steps.filter(step => !dependent.has(step.id)).map(step => step.id);
		steps.push({
			id: "completion-policy",
			agentName: "completion",
			needs: sinks,
			boundary: "complete",
			checks: { checks: plan.definition.checks, evals: plan.definition.evals },
		});
	}
	return steps;
}

async function writeBridgeFiles(
	plan: ShortleashPlan,
	cityPath: string,
	runtimePaths: GasCityRuntimePaths,
	steps: readonly GasCityStep[],
	policyModules: readonly GasCityPolicyModuleSnapshot[],
	definitionHash: string,
): Promise<GasCityBridgeSpec[]> {
	await fs.mkdir(runtimePaths.configs, { recursive: true });
	await fs.mkdir(runtimePaths.checks, { recursive: true });
	await fs.mkdir(runtimePaths.histories, { recursive: true });
	await fs.mkdir(runtimePaths.results, { recursive: true });
	const historyPaths: Record<string, string> = {};
	const agentHistoryKeys: Record<string, string> = {};
	for (const [index, step] of steps.entries()) {
		const key = `step-${index}`;
		historyPaths[key] = path.join(runtimePaths.histories, `${key}.json`);
		if (step.boundary === "agent") agentHistoryKeys[step.agentName] = key;
	}
	const specs: GasCityBridgeSpec[] = [];
	for (const [index, step] of steps.entries()) {
		const key = `step-${index}`;
		const configPath = path.join(runtimePaths.configs, `${key}.json`);
		const scriptPath = path.join(runtimePaths.checks, `${key}.sh`);
		const historyPath = historyPaths[key];
		const config: GasCityPolicyBridgeConfig = {
			schemaVersion: 1,
			key,
			boundary: step.boundary,
			agentName: step.boundary === "agent" ? step.agentName : undefined,
			definition: serializeShortleashDefinition(plan.definition),
			definitionDir: plan.definitionDir,
			definitionHash,
			cwd: cityPath,
			workspace: plan.workspace,
			shortleashDir: path.join(plan.workspace, `.shortleash_${plan.definition.name}`),
			policyModules,
			references: step.checks,
			historyPath,
			allHistoryPaths: historyPaths,
			agentHistoryKeys,
			resultsDir: runtimePaths.results,
		};
		await writeJsonAtomically(configPath, config);
		await fs.writeFile(scriptPath, renderCheckScript(configPath), { encoding: "utf8", mode: 0o755 });
		await fs.chmod(scriptPath, 0o755);
		specs.push({ key, configPath, scriptPath, historyPath, step });
	}
	return specs;
}

function renderGasCityFormula(
	plan: ShortleashPlan,
	cityPath: string,
	formulaName: string,
	steps: readonly GasCityStep[],
	specs: readonly GasCityBridgeSpec[],
	definitionHash: string,
	policyBundleHash: string,
	maxCheckAttempts: number,
): string {
	const specsById = new Map(specs.map(spec => [spec.step.id, spec]));
	const lines = [
		`formula = ${tomlString(formulaName)}`,
		`description = ${tomlString(`Shortleash '${plan.definition.name}' workflow compiled for Gas City.`)}`,
		`type = "workflow"`,
		"",
		"[requires]",
		`formula_compiler = ${tomlString(GAS_CITY_FORMULA_COMPILER)}`,
		"",
	];
	for (const step of steps) {
		const spec = specsById.get(step.id);
		if (!spec) throw new Error(`Missing Gas City bridge specification for '${step.id}'.`);
		lines.push("[[steps]]");
		lines.push(`id = ${tomlString(step.id)}`);
		lines.push(`title = ${tomlString(stepTitle(plan, step))}`);
		lines.push(`description = ${tomlString(stepDescription(plan, step))}`);
		if (step.needs.length > 0) lines.push(`needs = [${step.needs.map(tomlString).join(", ")}]`);
		lines.push("[steps.metadata]");
		lines.push(`shortleash_agent = ${tomlString(step.agentName)}`);
		lines.push(`shortleash_boundary = ${tomlString(step.boundary)}`);
		lines.push(`shortleash_definition_hash = ${tomlString(definitionHash)}`);
		lines.push(`shortleash_policy_bundle_hash = ${tomlString(policyBundleHash)}`);
		lines.push(`shortleash_failure_policy = ${tomlString(plan.definition.failurePolicy)}`);
		lines.push(`"gc.continuation_group" = ${tomlString(`shortleash-${definitionHash}-${step.id}`)}`);
		if (step.agent?.agent) lines.push(`"gc.run_target" = ${tomlString(step.agent.agent)}`);
		const model = step.agent?.model ?? plan.definition.model;
		if (model) lines.push(`opt_model = ${tomlString(model)}`);
		if (step.checks.checks.length > 0 || step.checks.evals.length > 0) {
			lines.push("[steps.check]");
			lines.push(`max_attempts = ${maxCheckAttempts}`);
			lines.push("[steps.check.check]");
			lines.push('mode = "exec"');
			lines.push(`path = ${tomlString(relativeToCity(cityPath, spec.scriptPath))}`);
		}
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}

function stepTitle(plan: ShortleashPlan, step: GasCityStep): string {
	if (step.agent) return `${step.agent.name}: ${step.agent.role}`;
	if (step.boundary === "complete") return `Shortleash '${plan.definition.name}' completion policy`;
	return `Shortleash '${plan.definition.name}' implementation`;
}

function stepDescription(plan: ShortleashPlan, step: GasCityStep): string {
	if (step.agent) {
		return [
			`Role: ${step.agent.role}`,
			step.agent.extraContext,
			step.agent.task,
			"Complete the assigned work in the configured Shortleash workspace.",
		]
			.filter((part): part is string => Boolean(part?.trim()))
			.join("\n\n");
	}
	return [
		`Review the completed Shortleash '${plan.definition.name}' workflow.`,
		plan.definition.task,
		"Inspect the implementation and leave the workspace ready for the completion policy check.",
	]
		.filter((part): part is string => Boolean(part?.trim()))
		.join("\n\n");
}

function relativeToCity(cityPath: string, filePath: string): string {
	return path.relative(cityPath, filePath) || path.basename(filePath);
}

async function prepareGasCityAttachment(
	beadId: string,
	definitionName: string,
	formulaName: string,
	definitionHash: string,
	cwd: string,
	run: BeadsCommandRunner,
	restart: boolean,
): Promise<{ attachBeadId: string; bridgeBeadId?: string }> {
	const bead = await readBeadRecord(beadId, cwd, run);
	const type = bead.type ?? "";
	if (type !== "epic") return { attachBeadId: beadId };
	const children = await runBeadsJson(["list", "--parent", beadId, "--all"], cwd, undefined, run);
	const existing = extractBeadsIssueRecords(children.data).find(child => {
		const metadata = metadataObject(child.metadata);
		return (
			metadata.shortleash_gascity_formula === formulaName &&
			metadata.shortleash_definition_hash === definitionHash &&
			(!restart || child.status !== "closed")
		);
	});
	if (existing) return { attachBeadId: existing.id, bridgeBeadId: existing.id };
	const title = `Run Shortleash '${definitionName}' in Gas City`;
	const created = await runBeadsJson(
		[
			"create",
			"--type=task",
			`--parent=${beadId}`,
			`--title=${title}`,
			`--description=Gas City workflow '${formulaName}' is the executable implementation guardrail for this epic.`,
			`--metadata=${JSON.stringify({
				shortleash_gascity_formula: formulaName,
				shortleash_definition_hash: definitionHash,
				shortleash_backend: "gascity",
			})}`,
		],
		cwd,
		undefined,
		run,
	);
	const record = extractBeadsIssueRecords(created.data)[0];
	if (!record) throw new Error(`bd create did not return the Gas City bridge issue for '${beadId}'.`);
	return { attachBeadId: record.id, bridgeBeadId: record.id };
}

async function readBeadRecord(id: string, cwd: string, run: BeadsCommandRunner): Promise<BeadsIssueRecord> {
	const result = await runBeadsJson(["show", id], cwd, undefined, run);
	const record = extractBeadsIssueRecords(result.data).find(candidate => candidate.id === id);
	if (!record) throw new Error(`bd show returned no issue '${id}'.`);
	return record;
}

async function policyModuleSnapshots(paths: readonly string[]): Promise<GasCityPolicyModuleSnapshot[]> {
	return Promise.all(
		paths.map(async modulePath => ({
			path: modulePath,
			sha256: createHash("sha256")
				.update(await fs.readFile(modulePath))
				.digest("hex"),
		})),
	);
}

function hashJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function renderCheckScript(configPath: string): string {
	const bunPath = shellQuote(process.execPath);
	const bridgePath = shellQuote(fileURLToPath(new URL("./gascity-check.ts", import.meta.url)));
	return `#!/bin/sh\nset -eu\nexec ${bunPath} ${bridgePath} --config ${shellQuote(configPath)}\n`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function slug(value: string): string {
	const result = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return result || "agent";
}

function metadataObject(value: unknown): Record<string, unknown> {
	if (isGasCityJsonObject(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return isGasCityJsonObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function gasCityData(value: unknown): GasCityJsonObject {
	if (!isGasCityJsonObject(value)) throw new Error("Gas City returned a non-object JSON response.");
	return value;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new Error(`${field} was missing from Gas City output.`);
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function requiredNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error(`${field} was missing from Gas City output.`);
	return value;
}

function isGasCityJsonObject(value: unknown): value is GasCityJsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function abortError(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	return new Error("Gas City command aborted");
}

function collectWarnings(plan: ShortleashPlan, options: GasCityWorkflowOptions): string[] {
	const warnings: string[] = [];
	if (options.restart)
		warnings.push(
			"Gas City owns durable workflow state; --restart only creates a fresh epic bridge when the prior bridge is closed.",
		);
	if (
		plan.definition.workspaceIsolation !== "none" ||
		[...plan.definition.agents.values()].some(
			agent => agent.workspaceIsolation !== undefined && agent.workspaceIsolation !== "none",
		)
	) {
		warnings.push(
			"Gas City backend does not translate Shortleash worktree isolation; agents run in the configured Gas City workspace.",
		);
	}
	if (plan.definition.inheritHistory || [...plan.definition.agents.values()].some(agent => agent.inheritHistory)) {
		warnings.push("Gas City backend does not inherit the interactive parent OMP transcript.");
	}
	if (plan.definition.agentTimeoutMs !== undefined) {
		warnings.push(
			"Shortleash agent_timeout_ms is not forwarded to Gas City worker sessions; configure the Gas City provider timeout separately.",
		);
	}
	if (plan.definition.failurePolicy === "skip_dependents") {
		warnings.push(
			"Gas City dependency closure is authoritative; verify the city's failure/skip policy matches Shortleash skip_dependents semantics.",
		);
	}
	if (options.restart === false)
		warnings.push(
			"Use gc status, gc ready, or gc dashboard to monitor the materialized workflow; /shortleash status reads only the in-process backend state.",
		);
	return warnings;
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await fs.rename(temporaryPath, filePath);
}
