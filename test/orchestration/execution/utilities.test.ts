import { describe, expect, it } from "bun:test";
import { mapWithConcurrency } from "../../../src/orchestration/execution/concurrency";
import { createAbortSignalScope } from "../../../src/orchestration/execution/signals";

describe("bounded asynchronous work", () => {
	it("preserves input order while enforcing the worker limit", async () => {
		let active = 0;
		let peak = 0;
		const result = await mapWithConcurrency([20, 5, 1, 10], 2, async (delay, index) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise<void>(resolve => setTimeout(resolve, delay));
			active -= 1;
			return `${index}:${delay}`;
		});

		expect(peak).toBe(2);
		expect(result).toEqual(["0:20", "1:5", "2:1", "3:10"]);
	});

	it("rejects invalid worker limits before invoking work", async () => {
		let invoked = false;
		await expect(
			mapWithConcurrency([1], 0, async value => {
				invoked = true;
				return value;
			}),
		).rejects.toThrow("positive integer");
		expect(invoked).toBe(false);
	});
});

describe("abort scopes", () => {
	it("propagates parent cancellation and cleans up", async () => {
		const parent = new AbortController();
		const scope = createAbortSignalScope(parent.signal, 1000);
		expect(scope.signal).toBeDefined();
		expect(scope.signal?.aborted).toBe(false);

		parent.abort("cancelled by caller");
		expect(scope.signal?.aborted).toBe(true);
		expect(scope.signal?.reason).toBe("cancelled by caller");
		scope.dispose();
	});

	it("aborts on a finite timeout", async () => {
		const scope = createAbortSignalScope(undefined, 5);
		await new Promise<void>(resolve => scope.signal?.addEventListener("abort", () => resolve(), { once: true }));
		expect(scope.signal?.aborted).toBe(true);
		expect(scope.signal?.reason).toBeInstanceOf(Error);
		scope.dispose();
	});
});
