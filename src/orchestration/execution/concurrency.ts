/**
 * Run asynchronous work with a bounded number of workers while preserving input order.
 *
 * The mapper is invoked at most `limit` times concurrently. A rejected mapper
 * rejects the returned promise; already-started work is not silently cancelled.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new Error("Concurrency limit must be a positive integer.");
	}
	if (items.length === 0) return [];

	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await mapper(items[index], index);
		}
	};

	await Promise.all(Array.from({ length: Math.min(items.length, limit) }, () => worker()));
	return results;
}
