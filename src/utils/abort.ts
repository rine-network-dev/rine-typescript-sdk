/**
 * AbortSignal helpers for composable cancellation.
 *
 * Provides:
 * - `timeoutSignal(ms)` — `{ signal, clear }` pair that aborts after ms ms
 *   with an `RineTimeoutError` reason. Callers MUST call `clear()` in a
 *   `finally` block so the timer is cancelled on early completion
 *   (audit MINOR-4, SPEC_v2 §14.3).
 * - `anySignal(...signals)` — signal that aborts when ANY of the inputs abort
 */

import { RineTimeoutError } from "../errors.js";

/**
 * Create a signal that fires after `ms` milliseconds.
 *
 * Returns a `{ signal, clear }` pair. Callers MUST invoke `clear()` in a
 * `finally` block (or equivalent) to cancel the timer on early completion —
 * otherwise the timer will still fire, aborting an already-settled signal
 * and leaking a timer handle per call. `clear()` is idempotent.
 *
 * When the timer fires, the signal is aborted with an `RineTimeoutError`
 * reason so `catch` sites can distinguish an SDK timeout from a user-cancel
 * via `err instanceof RineTimeoutError` (SPEC_v2 §14.4).
 */
export function timeoutSignal(ms: number): {
	signal: AbortSignal;
	clear: () => void;
} {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new RineTimeoutError(`timeout after ${ms}ms`)),
		ms,
	);
	return {
		signal: controller.signal,
		clear: () => clearTimeout(timer),
	};
}

/**
 * Combine multiple signals into one that aborts when ANY input aborts.
 *
 * The composed signal's `reason` is the reason from whichever input fired
 * first — this preserves the `RineTimeoutError` reason attached by
 * `timeoutSignal()` (and matching per-op timers in resources), so downstream
 * `signal.reason instanceof RineTimeoutError` checks classify timeouts
 * correctly instead of seeing a generic `AbortError` (SPEC_v2 §14.4).
 *
 * Listeners are detached from the remaining inputs as soon as the combined
 * signal fires — this prevents retaining long-lived source signals (e.g. a
 * global client signal) through short-lived request signals.
 */
export function anySignal(...signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	const cleanup: Array<() => void> = [];

	const abort = (reason?: unknown) => {
		controller.abort(reason);
		for (const off of cleanup) off();
		cleanup.length = 0;
	};

	for (const signal of signals) {
		if (signal.aborted) {
			abort(signal.reason);
			return controller.signal;
		}
		const onAbort = () => abort(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		cleanup.push(() => signal.removeEventListener("abort", onAbort));
	}

	return controller.signal;
}
