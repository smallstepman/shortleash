import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderBeadsCall, renderBeadsResult } from "../../src/beads/render";

beforeAll(async () => {
	await initTheme();
});

describe("Beads tool renderer", () => {
	it("renders a pending show call as a compact framed card", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const rendered = renderBeadsCall(
			{ op: "show", issue_id: "obligated-42" },
			{ expanded: false, isPartial: true, spinnerFrame: 1 },
			theme!,
		)
			.render(80)
			.join("\n");
		const plain = Bun.stripANSI(rendered);

		expect(plain).toContain("Beads show obligated-42");
		expect(plain).toContain("╭");
		expect(plain).toContain("╰");
	});

	it("bounds collapsed issue details and expands the same result", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const description = `${"Investigate the repository and preserve the durable workflow evidence. ".repeat(40)}tail-marker`;
		const result = {
			content: [{ type: "text", text: JSON.stringify({ id: "obligated-42" }) }],
			details: {
				operation: "show" as const,
				args: ["show", "obligated-42"],
				data: {
					id: "obligated-42",
					title: "Obligation-driven runtime",
					status: "open",
					description,
					metadata: { source: "renderer-test" },
				},
			},
		};

		const collapsed = Bun.stripANSI(
			renderBeadsResult(result, { expanded: false, isPartial: false }, theme!).render(100).join("\n"),
		);
		const expanded = Bun.stripANSI(
			renderBeadsResult(result, { expanded: true, isPartial: false }, theme!).render(100).join("\n"),
		);

		expect(collapsed).toContain("DESCRIPTION");
		expect(collapsed).toContain("Ctrl+O");
		expect(collapsed).not.toContain("tail-marker");
		expect(expanded).toContain("tail-marker");
		expect(expanded).toContain("METADATA");
	});
});
