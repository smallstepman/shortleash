import * as path from "node:path";
import type { ResolvedShortleashInput } from "../adapters/beads";
import { resolveShortleashInput } from "../adapters/beads";
import { buildDependencyGraph, buildExecutionWaves, detectCycles } from "../execution/dag";
import { loadShortleashPolicyModules, type ShortleashPolicyRegistry } from "../policy/policies";
import { type ShortleashDefinition, serializeShortleashDefinition, validateShortleashDefinition } from "./schema";

function collectPolicyPaths(definition: ShortleashDefinition, definitionDir: string): string[] {
	const paths = new Set<string>();
	const add = (reference: ShortleashDefinition["checks"][number]): void => {
		const configuredPath = typeof reference === "string" ? reference : reference.path;
		paths.add(path.resolve(definitionDir, configuredPath));
	};
	for (const reference of definition.checks) add(reference);
	for (const reference of definition.evals) add(reference);
	for (const agent of definition.agents.values()) {
		for (const reference of agent.checks) add(reference);
		for (const reference of agent.evals) add(reference);
	}
	return [...paths];
}

export interface ShortleashPlan {
	input: string;
	source: ResolvedShortleashInput;
	definition: ShortleashDefinition;
	definitionDir: string;
	definitionPath: string;
	workspace: string;
	waves: string[][];
	policyPaths: string[];
	policyErrors: string[];
	policyRegistry: ShortleashPolicyRegistry;
}

export async function resolveShortleashPlan(input: string, cwd: string): Promise<ShortleashPlan> {
	const source = await resolveShortleashInput(input, cwd);
	const { definition, definitionDir, definitionPath } = source;
	const validationErrors = validateShortleashDefinition(definition);
	if (validationErrors.length > 0) {
		throw new Error(`Validation errors:\n${validationErrors.map(error => `  - ${error}`).join("\n")}`);
	}

	const dependencies = buildDependencyGraph(definition);
	const cycles = detectCycles(dependencies);
	if (cycles) throw new Error(`Cycle detected in agent dependencies: [${cycles.join(", ")}]`);
	const waves = buildExecutionWaves(dependencies);
	const workspace = path.isAbsolute(definition.workspace)
		? definition.workspace
		: path.resolve(definitionDir, definition.workspace);
	const policyPaths = collectPolicyPaths(definition, definitionDir);
	const loadedPolicies = await loadShortleashPolicyModules({
		paths: policyPaths,
		definitionDir,
	});
	if (loadedPolicies.errors.length > 0) {
		throw new Error(
			`Shortleash policy module load errors:\n${loadedPolicies.errors.map(error => `  - ${error}`).join("\n")}`,
		);
	}
	const policyErrors = loadedPolicies.registry.validateDefinition(definition);
	if (policyErrors.length > 0) {
		throw new Error(`Shortleash policy errors:\n${policyErrors.map(error => `  - ${error}`).join("\n")}`);
	}
	return {
		input,
		source,
		definition,
		definitionDir,
		definitionPath,
		workspace,
		waves,
		policyPaths,
		policyErrors,
		policyRegistry: loadedPolicies.registry,
	};
}

export function formatShortleashPlan(plan: ShortleashPlan): string[] {
	const definition = serializeShortleashDefinition(plan.definition);
	return [
		`Shortleash: ${plan.definition.name}`,
		`Definition: ${plan.definitionPath}`,
		`Workspace: ${plan.workspace}`,
		`Failure policy: ${plan.definition.failurePolicy}`,
		`Agent timeout: ${plan.definition.agentTimeoutMs ? `${plan.definition.agentTimeoutMs}ms` : "none"}`,
		`Waves: ${plan.waves.map((wave, index) => `W${index + 1}:[${wave.join(", ")}]`).join(" -> ") || "direct current session"}`,
		`Policy modules: ${plan.policyPaths.length > 0 ? plan.policyPaths.join(", ") : "none"}`,
		`Direct task: ${plan.definition.task ?? "continue the current objective"}`,
		`Agents: ${JSON.stringify(definition.agents)}`,
	];
}
