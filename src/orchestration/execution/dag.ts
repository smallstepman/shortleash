/**
 * Directed Acyclic Graph operations for swarm agent dependencies.
 *
 * Builds a dependency graph from waits_for / reports_to relationships,
 * detects cycles, and produces execution waves via topological sort.
 */
import type { SwarmDefinition } from "../definition/schema";

/**
 * Build a dependency map: agent name → set of agents it depends on.
 *
 * Dependencies come from:
 * 1. Explicit `waits_for` declarations
 * 2. Implicit from `reports_to` (if A reports_to B, then B depends on A)
 * 3. For pipeline/sequential mode with no explicit deps: chain by definition declaration order
 */
export function buildDependencyGraph(def: SwarmDefinition): Map<string, Set<string>> {
	const deps = new Map<string, Set<string>>();

	for (const name of def.agents.keys()) deps.set(name, new Set());

	// Explicit waits_for
	for (const [name, agent] of def.agents) {
		for (const dep of agent.waitsFor) {
			const dependencySet = deps.get(name);
			if (!dependencySet) throw new Error(`Dependency graph is missing agent '${name}'.`);
			dependencySet.add(dep);
		}
	}

	// reports_to implies the target waits for the reporter
	for (const [name, agent] of def.agents) {
		for (const target of agent.reportsTo) {
			const dependencySet = deps.get(target);
			if (!dependencySet) throw new Error(`Dependency graph is missing agent '${target}'.`);
			dependencySet.add(name);
		}
	}

	// For pipeline/sequential with no explicit deps, chain by declaration order
	if ((def.mode === "pipeline" || def.mode === "sequential") && !hasExplicitDeps(deps)) {
		for (let i = 1; i < def.agentOrder.length; i++) {
			const name = def.agentOrder[i];
			const previous = def.agentOrder[i - 1];
			if (name === undefined || previous === undefined) {
				throw new Error("Dependency graph contains an invalid declaration order.");
			}
			const dependencySet = deps.get(name);
			if (!dependencySet) throw new Error(`Dependency graph is missing declared agent '${name}'.`);
			dependencySet.add(previous);
		}
	}

	return deps;
}

function hasExplicitDeps(deps: Map<string, Set<string>>): boolean {
	for (const s of deps.values()) {
		if (s.size > 0) return true;
	}
	return false;
}

/**
 * Detect cycles in the dependency graph.
 * Returns the names of agents involved in cycles, or null if acyclic.
 */
export function detectCycles(deps: Map<string, Set<string>>): string[] | null {
	// Kahn's algorithm: if topological sort doesn't include all nodes, cycles exist
	const inDegree = new Map<string, number>();
	const forward = new Map<string, string[]>(); // dependency → its dependents

	for (const [node, nodeDeps] of deps) {
		inDegree.set(node, nodeDeps.size);
		for (const dep of nodeDeps) {
			const list = forward.get(dep) ?? [];
			list.push(node);
			forward.set(dep, list);
		}
	}

	const queue: string[] = [];
	for (const [node, degree] of inDegree) {
		if (degree === 0) queue.push(node);
	}

	const sorted: string[] = [];
	while (queue.length > 0) {
		const node = queue.shift();
		if (node === undefined) break;
		sorted.push(node);
		for (const dependent of forward.get(node) ?? []) {
			const degree = inDegree.get(dependent);
			if (degree === undefined) throw new Error(`Dependency graph is missing node '${dependent}'.`);
			const newDegree = degree - 1;
			inDegree.set(dependent, newDegree);
			if (newDegree === 0) queue.push(dependent);
		}
	}

	if (sorted.length < deps.size) {
		return [...deps.keys()].filter(k => !sorted.includes(k));
	}

	return null;
}

/**
 * Build execution waves from dependency graph via topological sort.
 *
 * Each wave contains agents whose dependencies are all in earlier waves.
 * Agents within a wave can execute in parallel.
 */
export function buildExecutionWaves(deps: Map<string, Set<string>>): string[][] {
	const waves: string[][] = [];
	const completed = new Set<string>();
	const remaining = new Set(deps.keys());

	while (remaining.size > 0) {
		const wave: string[] = [];

		for (const node of remaining) {
			const nodeDeps = deps.get(node);
			if (!nodeDeps) throw new Error(`Dependency graph is missing node '${node}'.`);
			let ready = true;
			for (const dep of nodeDeps) {
				if (!completed.has(dep)) {
					ready = false;
					break;
				}
			}
			if (ready) wave.push(node);
		}

		if (wave.length === 0) {
			throw new Error(
				`Deadlock: agents [${[...remaining].join(", ")}] cannot make progress. This indicates a bug in cycle detection.`,
			);
		}

		wave.sort();
		for (const node of wave) {
			remaining.delete(node);
			completed.add(node);
		}
		waves.push(wave);
	}

	return waves;
}
