import * as path from "node:path";
import type { ResolvedSwarmInput } from "../adapters/beads";
import { resolveSwarmInput } from "../adapters/beads";
import { buildDependencyGraph, buildExecutionWaves, detectCycles } from "../execution/dag";
import {
	discoverSwarmPluginPaths,
	loadSwarmPlugins,
	type SwarmPluginLogger,
	type SwarmPolicyRegistry,
} from "../policy/plugins";
import { type SwarmDefinition, serializeSwarmDefinition, validateSwarmDefinition } from "./schema";

export interface SwarmPlan {
	input: string;
	source: ResolvedSwarmInput;
	definition: SwarmDefinition;
	definitionDir: string;
	definitionPath: string;
	workspace: string;
	waves: string[][];
	pluginPaths: string[];
	policyErrors: string[];
	policyRegistry: SwarmPolicyRegistry;
}

export async function resolveSwarmPlan(
	input: string,
	cwd: string,
	options: { logger?: SwarmPluginLogger } = {},
): Promise<SwarmPlan> {
	const source = await resolveSwarmInput(input, cwd);
	const { definition, definitionDir, definitionPath } = source;
	const validationErrors = validateSwarmDefinition(definition);
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
	const discoveredPlugins = await discoverSwarmPluginPaths({
		cwd,
		definitionDir,
		configuredPaths: definition.plugins,
	});
	if (discoveredPlugins.errors.length > 0) {
		throw new Error(
			`Swarm plugin discovery errors:\n${discoveredPlugins.errors.map(error => `  - ${error}`).join("\n")}`,
		);
	}
	const loadedPlugins = await loadSwarmPlugins({
		paths: discoveredPlugins.paths,
		cwd,
		workspace,
		definitionPath,
		definition,
		logger: options.logger,
	});
	if (loadedPlugins.errors.length > 0) {
		throw new Error(`Swarm plugin load errors:\n${loadedPlugins.errors.map(error => `  - ${error}`).join("\n")}`);
	}
	const policyErrors = loadedPlugins.registry.validateDefinition(definition);
	if (policyErrors.length > 0) {
		throw new Error(`Swarm policy errors:\n${policyErrors.map(error => `  - ${error}`).join("\n")}`);
	}
	return {
		input,
		source,
		definition,
		definitionDir,
		definitionPath,
		workspace,
		waves,
		pluginPaths: discoveredPlugins.paths,
		policyErrors,
		policyRegistry: loadedPlugins.registry,
	};
}

export function formatSwarmPlan(plan: SwarmPlan): string[] {
	const definition = serializeSwarmDefinition(plan.definition);
	return [
		`Swarm: ${plan.definition.name}`,
		`Definition: ${plan.definitionPath}`,
		`Workspace: ${plan.workspace}`,
		`Mode: ${plan.definition.mode}`,
		`Agent execution: ${plan.definition.agentExecution}`,
		`Failure policy: ${plan.definition.failurePolicy}`,
		`Target count: ${plan.definition.targetCount}`,
		`Max concurrency: ${plan.definition.maxConcurrency ?? "unlimited"}`,
		`Agent timeout: ${plan.definition.agentTimeoutMs ? `${plan.definition.agentTimeoutMs}ms` : "none"}`,
		`Waves: ${plan.waves.map((wave, index) => `W${index + 1}:[${wave.join(", ")}]`).join(" -> ") || "direct current session"}`,
		`Plugins: ${plan.pluginPaths.length > 0 ? plan.pluginPaths.join(", ") : "none"}`,
		`Direct task: ${plan.definition.task ?? "continue the current objective"}`,
		`Agents: ${JSON.stringify(definition.agents)}`,
	];
}
