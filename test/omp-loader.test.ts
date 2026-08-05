import { describe, expect, it } from "bun:test";
import path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent";

describe("OMP host extension loader", () => {
	it("loads the extension entry point without duplicate ArkType scope failures", async () => {
		const packageRoot = path.resolve(import.meta.dir, "..");
		const result = await loadExtensions([path.join(packageRoot, "src", "extension.ts")], packageRoot);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect([...result.extensions[0].tools.keys()]).toEqual(["beads"]);
	});
});
