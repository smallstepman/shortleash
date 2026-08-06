import { describe, expect, it } from "bun:test";
import path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent";

describe("OMP host extension loader", () => {
	it("loads the extension entry point without duplicate ArkType scope failures", async () => {
		const packageRoot = path.resolve(import.meta.dir, "..");
		const result = await loadExtensions([path.join(packageRoot, "src", "extension.ts")], packageRoot);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].tools.size).toBe(1);
		expect(result.extensions[0].tools.has("bash")).toBe(true);
		const bash = result.extensions[0].tools.get("bash");
		expect(bash).toBeDefined();
		if (!bash) throw new Error("Beads Bash tool was not registered");
		expect((bash.definition as { mergeCallAndResult?: boolean }).mergeCallAndResult).toBe(true);
		expect(bash.definition.renderCall).toBeFunction();
		expect(bash.definition.renderResult).toBeFunction();
		expect(result.extensions[0].handlers.has("tool_call")).toBe(true);
		expect(result.extensions[0].handlers.has("tool_result")).toBe(true);
		expect(result.extensions[0].handlers.has("user_bash")).toBe(true);
	});
});
