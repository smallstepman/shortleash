import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent";
import { renderBeadsCall, renderBeadsResult } from "../../src/beads/render";

async function darkTheme() {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("dark theme unavailable");
	return theme;
}

describe("Beads renderer", () => {
	it("frames the pending operation with a themed Beads header", async () => {
		const theme = await darkTheme();
		const lines = renderBeadsCall(
			{ op: "show", issue_id: "scratchpad-2x5" },
			{ expanded: false, isPartial: true },
			theme,
		).render(100);

		expect(lines[0]).toContain("Beads show scratchpad-2x5");
		expect(lines[0]).toContain("╭");
		expect(lines[0]).toContain("──");
		expect(lines.at(-1)).toContain("╰");
	});
	it("suppresses the completed call preview without a host-specific merge flag", async () => {
		const theme = await darkTheme();
		const lines = renderBeadsCall(
			{ op: "show", issue_id: "scratchpad-2x5" },
			{ expanded: false, isPartial: false },
			theme,
		).render(100);

		expect(lines).toEqual([]);
	});

	it("renders issue fields, Markdown sections, and metadata in the completed card", async () => {
		const theme = await darkTheme();
		const lines = renderBeadsResult(
			{
				content: [{ type: "text", text: "raw JSON" }],
				details: {
					operation: "show",
					args: ["show", "scratchpad-2x5"],
					data: {
						id: "scratchpad-2x5",
						title: "A **rendered** issue",
						status: "open",
						issue_type: "task",
						priority: 2,
						description: "Description with **Markdown**.",
						acceptance_criteria: "- Criterion one",
						metadata: { source: "renderer-test" },
					},
				},
			},
			{ expanded: true, isPartial: false },
			theme,
			{ op: "show", issue_id: "scratchpad-2x5" },
		).render(100);
		const output = lines.join("\n");

		expect(output).toContain("DESCRIPTION");
		expect(output).toContain("ACCEPTANCE CRITERIA");
		expect(output).toContain("METADATA");
		expect(output).toContain("renderer-test");
		expect(output).toContain("Lined Up");
	});

	it("bounds collapsed issue lists and advertises expansion", async () => {
		const theme = await darkTheme();
		const data = Array.from({ length: 4 }, (_, index) => ({
			id: `bd-${index}`,
			title: `Issue ${index}`,
			status: "open",
		}));
		const lines = renderBeadsResult(
			{
				content: [{ type: "text", text: "raw JSON" }],
				details: { operation: "list", args: ["list"], data },
			},
			{ expanded: false, isPartial: false },
			theme,
			{ op: "list" },
		).render(100);

		expect(lines.join("\n")).toContain("1 more issue");
		expect(lines.join("\n")).toContain("Ctrl+O");
	});
	it("ignores malformed host details and falls back to the validated call arguments", async () => {
		const theme = await darkTheme();
		const lines = renderBeadsResult(
			{
				content: [{ type: "text", text: "raw JSON" }],
				details: { operation: "not-a-beads-operation", args: "invalid", data: { id: "bd-1" } },
			} as unknown as Parameters<typeof renderBeadsResult>[0],
			{ expanded: false, isPartial: false },
			theme,
			{ op: "list" },
		).render(100);

		expect(lines.join("\n")).toContain("Beads list");
		expect(lines.join("\n")).toContain("Completed · no data");
	});
});
