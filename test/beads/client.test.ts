import { describe, expect, it } from "bun:test";
import { extractBeadsData, extractBeadsIssueRecords, parseBeadsJson, runBeadsJson } from "../../src/beads/client";

describe("Beads CLI adapter", () => {
	it("unwraps bd JSON envelopes and extracts issue records", () => {
		const data = { data: [{ id: "bd-1", title: "Issue", issue_type: "task", status: "open", metadata: {} }] };
		expect(extractBeadsData(data)).toEqual(data.data);
		expect(extractBeadsIssueRecords(data)).toEqual([
			{ id: "bd-1", title: "Issue", type: "task", status: "open", metadata: {} },
		]);
	});

	it("runs bounded argv JSON commands without an operation schema", async () => {
		const calls: string[][] = [];
		const result = await runBeadsJson(["list", "--status", "open"], "/workspace", undefined, async args => {
			calls.push([...args]);
			return JSON.stringify({ data: [{ id: "bd-1", status: "open" }] });
		});

		expect(calls).toEqual([["list", "--status", "open", "--json"]]);
		expect(result.args).toEqual(["list", "--status", "open"]);
		expect(result.data).toEqual([{ id: "bd-1", status: "open" }]);
	});

	it("does not duplicate an explicit JSON flag", async () => {
		const calls: string[][] = [];
		await runBeadsJson(["show", "bd-1", "--json"], "/workspace", undefined, async args => {
			calls.push([...args]);
			return '{"data": []}';
		});
		expect(calls).toEqual([["show", "bd-1", "--json"]]);
	});

	it("rejects malformed JSON with the bounded command context", () => {
		expect(() => parseBeadsJson("not json", ["show", "bd-1"])).toThrow("bd show bd-1 returned invalid JSON");
	});
});
