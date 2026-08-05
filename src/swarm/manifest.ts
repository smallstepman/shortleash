import { $ } from "bun";
import packageJson from "../../package.json" with { type: "json" };
import type { SwarmDefinition } from "./schema";
import type { SwarmRunManifest } from "./state";

export interface SwarmManifestOptions {
	definitionPath?: string;
	definitionHash: string;
	workspace: string;
	pluginPaths: string[];
	cwd: string;
}

export async function createSwarmRunManifest(
	definition: SwarmDefinition,
	options: SwarmManifestOptions,
): Promise<SwarmRunManifest> {
	return {
		definitionPath: options.definitionPath,
		definitionHash: options.definitionHash,
		workspace: options.workspace,
		ompVersion: process.env.OMP_VERSION ?? "unknown",
		extensionVersion: packageJson.version,
		repositoryRevision: await readRepositoryRevision(options.cwd),
		models: Object.fromEntries(
			[...definition.agents].map(([name, agent]) => [name, agent.model ?? definition.model]),
		),
		pluginPaths: [...options.pluginPaths],
		environment: {
			platform: process.platform,
			arch: process.arch,
			bunVersion: Bun.version,
			nodeVersion: process.versions.node,
			cwd: options.cwd,
			...(process.env.CI ? { ci: process.env.CI } : {}),
		},
	};
}

async function readRepositoryRevision(cwd: string): Promise<string | undefined> {
	const result = await $`git rev-parse HEAD`.cwd(cwd).quiet().nothrow();
	if (result.exitCode !== 0) return undefined;
	const revision = result.text().trim();
	return revision.length > 0 ? revision : undefined;
}
