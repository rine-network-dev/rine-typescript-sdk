import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RineTimeoutError } from "../errors.js";
import { anySignal, timeoutSignal } from "./abort.js";

describe("timeoutSignal", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns a { signal, clear } pair with an unaborted signal", () => {
		const { signal, clear } = timeoutSignal(1000);
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal.aborted).toBe(false);
		expect(typeof clear).toBe("function");
		clear();
	});

	it("aborts the signal with an RineTimeoutError after ms elapse", () => {
		const { signal } = timeoutSignal(500);
		vi.advanceTimersByTime(499);
		expect(signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(signal.aborted).toBe(true);
		expect(signal.reason).toBeInstanceOf(RineTimeoutError);
		expect((signal.reason as RineTimeoutError).message).toContain("500ms");
	});

	it("clear() cancels the pending timer so the signal never aborts", () => {
		const { signal, clear } = timeoutSignal(1000);
		clear();
		// Advance well past the timeout — the signal must remain unaborted.
		vi.advanceTimersByTime(5000);
		expect(signal.aborted).toBe(false);
	});

	it("clear() is idempotent — calling it twice does not throw", () => {
		const { clear } = timeoutSignal(1000);
		expect(() => {
			clear();
			clear();
		}).not.toThrow();
	});

	it("does not leak an active timer handle after clear()", () => {
		const clearSpy = vi.spyOn(globalThis, "clearTimeout");
		const { clear } = timeoutSignal(1000);
		clear();
		expect(clearSpy).toHaveBeenCalledTimes(1);
		clearSpy.mockRestore();
	});
});

describe("anySignal", () => {
	it("returns an unaborted signal when no input is aborted", () => {
		const a = new AbortController();
		const b = new AbortController();
		const composed = anySignal(a.signal, b.signal);
		expect(composed.aborted).toBe(false);
	});

	it("aborts immediately if any input signal is already aborted", () => {
		const a = new AbortController();
		a.abort();
		const b = new AbortController();
		const composed = anySignal(a.signal, b.signal);
		expect(composed.aborted).toBe(true);
	});

	it("aborts when any input aborts after composition", () => {
		const a = new AbortController();
		const b = new AbortController();
		const composed = anySignal(a.signal, b.signal);
		expect(composed.aborted).toBe(false);
		b.abort();
		expect(composed.aborted).toBe(true);
	});

	it("only fires once even if multiple inputs abort", () => {
		const a = new AbortController();
		const b = new AbortController();
		const composed = anySignal(a.signal, b.signal);
		let abortEvents = 0;
		composed.addEventListener("abort", () => {
			abortEvents++;
		});
		a.abort();
		b.abort();
		expect(abortEvents).toBe(1);
	});

	it("detaches listeners from source signals once it fires (prevents listener leak)", () => {
		const a = new AbortController();
		const b = new AbortController();
		// Capture listener count deltas via a spy on removeEventListener.
		const removeA = vi.spyOn(a.signal, "removeEventListener");
		const removeB = vi.spyOn(b.signal, "removeEventListener");
		const composed = anySignal(a.signal, b.signal);
		expect(composed.aborted).toBe(false);
		a.abort();
		// Both cleanups should have run — the listener for `a` AND the one
		// still pending on `b` must be removed so that `b` can be GC'd
		// without retaining a reference to the composed controller.
		expect(removeA).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(removeB).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("handles the empty-varargs case — never aborts on its own", () => {
		const composed = anySignal();
		expect(composed.aborted).toBe(false);
	});
});
