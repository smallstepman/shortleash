/** A cancellable operation scope with explicit timer/listener cleanup. */
export interface AbortSignalScope {
	signal?: AbortSignal;
	dispose(): void;
}

/**
 * Combine parent cancellation with an optional timeout.
 *
 * When no timeout is configured, the parent signal is returned unchanged. When
 * a timeout is configured, callers must dispose the scope to release its timer
 * and parent listener after the operation settles.
 */
export function createAbortSignalScope(parent?: AbortSignal, timeoutMs?: number): AbortSignalScope {
	if (timeoutMs === undefined) return { signal: parent, dispose: () => {} };
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error("Abort timeout must be a positive finite number.");
	}

	const controller = new AbortController();
	const onAbort = (): void => controller.abort(parent?.reason);
	parent?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(new Error(`Operation timed out after ${timeoutMs}ms.`)), timeoutMs);
	if (parent?.aborted) onAbort();

	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}
