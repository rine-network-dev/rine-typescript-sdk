import { sleep } from "@rine-network/core";

/**
 * Like core's `sleep()` but aborts early when the given signal fires. Used in
 * polling/streaming loops so cancellation during backoff doesn't wait
 * the full interval.
 */
export function sleepWithSignal(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	if (!signal) return sleep(ms);
	if (ms <= 0 || signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
