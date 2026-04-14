/**
 * SDKHttpClient AbortSignal regression suite.
 *
 * Covers:
 * - `ac.abort()` mid-`inbox()` / mid-`send()` rejects with a *native*
 *   `AbortError` (NOT `RineTimeoutError`). User-signal abort → native
 *   AbortError; SDK internal timeout → `RineTimeoutError`.
 * - The SDK timeout fires `RineTimeoutError` only when the user signal is
 *   not the cause.
 * - The internal timeout handle is cleared on every path (success AND
 *   failure).
 * - The composed signal (user ∪ SDK timeout) reaches `fetch()` so the
 *   browser/node fetch implementation can actually abort in-flight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub rine-core auth helpers — the authenticated path calls `loadCredentials`
// and `getOrRefreshToken`, both of which touch disk / the network in real
// usage. Hoisted by vitest above the SDKHttpClient import.
vi.mock("@rine-network/core", async () => {
	const actual =
		await vi.importActual<typeof import("@rine-network/core")>(
			"@rine-network/core",
		);
	return {
		...actual,
		loadCredentials: vi.fn(() => ({
			default: {
				org_id: "stub",
				agent_handle: "stub@stub",
				agent_id: "stub",
				signing_key: "stub",
				encryption_key: "stub",
			},
		})),
		getOrRefreshToken: vi.fn(async () => "stub-token"),
		// `resolveSenderId()` calls `fetchAgents(core)` + `resolveAgent(...)`
		// before the inbox GET. Stub both so the resource-layer integration
		// test below never touches the fetch stub for sender resolution —
		// the only fetch call should be the inbox request we're aborting.
		fetchAgents: vi.fn(async () => [
			{
				id: "11111111-1111-4111-8111-111111111111",
				handle: "stub@stub.rine.network",
			},
		]),
		resolveAgent: vi.fn(
			async () => "11111111-1111-4111-8111-111111111111",
		),
	};
});

import { RineTimeoutError } from "../errors.js";
import { MessagesResource } from "../resources/messages.js";
import { SDKHttpClient } from "./http.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchCall {
	url: string;
	init: RequestInit;
}

/**
 * Install a `fetch` stub that honours AbortSignal semantics:
 *
 * - If the signal is already aborted, reject synchronously with an
 *   AbortError.
 * - Otherwise park the promise until either the signal fires (reject with
 *   AbortError) or the caller manually resolves via `resolveNext(response)`.
 *
 * Returns `{ calls, resolveNext }` so tests can assert on the request made
 * and drive the happy path when needed.
 */
function installFetchStub(): {
	calls: FetchCall[];
	resolveNext: (response: Response) => void;
} {
	const calls: FetchCall[] = [];
	const pending: Array<(response: Response) => void> = [];

	const stub = vi.fn(
		async (input: string | URL | Request, init: RequestInit = {}) => {
			calls.push({ url: String(input), init });
			return new Promise<Response>((resolve, reject) => {
				const signal = init.signal as AbortSignal | undefined;
				if (signal?.aborted) {
					reject(makeAbortError());
					return;
				}
				const onAbort = () => reject(makeAbortError());
				signal?.addEventListener("abort", onAbort, { once: true });
				pending.push((response: Response) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(response);
				});
			});
		},
	);

	vi.stubGlobal("fetch", stub);

	return {
		calls,
		resolveNext(response: Response) {
			const next = pending.shift();
			if (!next) throw new Error("resolveNext called with no pending fetch");
			next(response);
		},
	};
}

function makeAbortError(): Error {
	// Node and browser fetch both reject with a DOMException whose
	// `name === "AbortError"`. Use a plain Error with the same name so the
	// check `err.name === "AbortError"` matches real runtime behaviour.
	const err = new Error("The operation was aborted");
	err.name = "AbortError";
	return err;
}

function okJsonResponse(body: unknown = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("SDKHttpClient cancellation — user signal", () => {
	let fx: ReturnType<typeof installFetchStub>;
	beforeEach(() => {
		fx = installFetchStub();
	});

	it("rejects GET with a native AbortError when the user signal aborts mid-flight", async () => {
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			timeout: 10_000,
		});
		const ac = new AbortController();
		const pending = http.get("/poll", {
			unauthenticated: true,
			operation: "poll",
			signal: ac.signal,
		});

		// Queue a microtask to abort AFTER fetch has been called (so we exercise
		// the mid-flight path rather than the already-aborted shortcut).
		await Promise.resolve();
		ac.abort();

		const err = await pending.catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).name).toBe("AbortError");
		expect(err).not.toBeInstanceOf(RineTimeoutError);
		expect(fx.calls).toHaveLength(1);
	});

	it("rejects POST with a native AbortError when the user signal aborts mid-flight", async () => {
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			timeout: 10_000,
		});
		const ac = new AbortController();
		const pending = http.post(
			"/messages",
			{ type: "rine.v1.task_request" },
			{
				unauthenticated: true,
				operation: "send",
				signal: ac.signal,
			},
		);

		await Promise.resolve();
		ac.abort();

		const err = await pending.catch((e) => e);
		expect((err as Error).name).toBe("AbortError");
		expect(err).not.toBeInstanceOf(RineTimeoutError);
	});

	it("honours a pre-aborted signal (never resolves the request)", async () => {
		const http = new SDKHttpClient({ apiUrl: "https://api.test" });
		const ac = new AbortController();
		ac.abort();

		const err = await http
			.get("/poll", {
				unauthenticated: true,
				operation: "poll",
				signal: ac.signal,
			})
			.catch((e) => e);

		expect((err as Error).name).toBe("AbortError");
		expect(err).not.toBeInstanceOf(RineTimeoutError);
	});

	it("passes the composed signal (user ∪ sdk-timeout) into fetch()", async () => {
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			timeout: 10_000,
		});
		const ac = new AbortController();
		// Drive the happy path so we can inspect the init captured by fetch.
		setTimeout(() => fx.resolveNext(okJsonResponse({ ok: true })), 0);
		await http.get("/poll", {
			unauthenticated: true,
			operation: "poll",
			signal: ac.signal,
		});

		const init = fx.calls[0]?.init;
		expect(init).toBeDefined();
		// The composed signal must be a real AbortSignal and MUST NOT be the
		// user's raw signal — it has to be the `anySignal()` composite so
		// that the SDK timeout can abort even when the user never does.
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(init?.signal).not.toBe(ac.signal);
	});
});

describe("SDKHttpClient cancellation — SDK timeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		installFetchStub();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("throws RineTimeoutError when the internal timer fires before the response", async () => {
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			timeout: 25,
		});
		const pending = http.get("/poll", {
			unauthenticated: true,
			operation: "poll",
		});
		const caught = pending.catch((e) => e);
		// Advance beyond the 25ms timeout — no user signal was ever passed,
		// so the only way this promise settles is the SDK timer firing.
		await vi.advanceTimersByTimeAsync(30);
		const err = await caught;
		expect(err).toBeInstanceOf(RineTimeoutError);
		expect((err as RineTimeoutError).message).toContain("timed out after 25ms");
	});

	it("user abort wins the race when both fire — yields native AbortError", async () => {
		// Arrange: fire the user abort before the SDK timeout. Both would
		// eventually cause `fetch` to reject, but the user-signal path
		// must be reported as a native AbortError, never a timeout.
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			timeout: 1_000,
		});
		const ac = new AbortController();
		const pending = http.get("/poll", {
			unauthenticated: true,
			operation: "poll",
			signal: ac.signal,
		});
		// Tick 10ms into the timeout, then abort.
		await vi.advanceTimersByTimeAsync(10);
		ac.abort();
		// Drain the rejection microtasks.
		const err = await pending.catch((e) => e);
		expect((err as Error).name).toBe("AbortError");
		expect(err).not.toBeInstanceOf(RineTimeoutError);
	});
});

describe("SDKHttpClient — internal timer hygiene", () => {
	// Use fake timers so we can *count* outstanding timers. A spy on
	// `clearTimeout` is vacuously true because many things in the test
	// environment call `clearTimeout` incidentally — removing the clearTimeout
	// call from `http.ts` entirely would not fail a `toHaveBeenCalled()`
	// assertion. `vi.getTimerCount()` reports only the fake-timer queue, so
	// it precisely tracks the SDK's own internal timer.
	let fx: ReturnType<typeof installFetchStub>;
	beforeEach(() => {
		vi.useFakeTimers();
		fx = installFetchStub();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("clears the internal timeout handle on a successful response", async () => {
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			timeout: 10_000,
		});
		const pending = http.get("/poll", {
			unauthenticated: true,
			operation: "poll",
		});
		// Flush the microtask that registers the timer before we inspect.
		await Promise.resolve();
		// Exactly one pending fake timer: the SDK's own internal timeoutId.
		expect(vi.getTimerCount()).toBe(1);

		// Drive the happy path — the fetch stub parks until we resolve it.
		fx.resolveNext(okJsonResponse());
		await pending;

		// The success branch of `request()` must call `clearTimeout(timeoutId)`
		// or the timer would still be pending. If the clearTimeout line were
		// removed from http.ts, this assertion would fail.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears the internal timeout handle on a user-abort rejection", async () => {
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			timeout: 10_000,
		});
		const ac = new AbortController();
		const pending = http.get("/poll", {
			unauthenticated: true,
			operation: "poll",
			signal: ac.signal,
		});
		await Promise.resolve();
		expect(vi.getTimerCount()).toBe(1);

		ac.abort();
		await pending.catch(() => undefined);

		// The `catch` branch must also clear the timer. A regression that
		// leaked the timer on the error path would leave count at 1.
		expect(vi.getTimerCount()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Resource-layer integration
//
// The HTTP-layer tests above cover `SDKHttpClient.get/.post` in isolation.
// `MessagesResource.inbox()` wraps its HTTP call in `beginOp()` which
// composes the user signal with a per-operation timeout AC before forwarding
// to `http.get()`. That wiring is distinct enough to deserve its own
// regression.
// ---------------------------------------------------------------------------

describe("MessagesResource cancellation — resource-layer (inbox)", () => {
	let fx: ReturnType<typeof installFetchStub>;
	beforeEach(() => {
		fx = installFetchStub();
	});

	it("inbox() rejects with a native AbortError when the user signal aborts mid-flight", async () => {
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			timeout: 10_000,
		});
		// `inbox()` calls `this.http.getCoreHttpClient(...)` → then
		// `resolveSenderId(core, ...)` → which calls the (mocked) `fetchAgents`
		// + `resolveAgent` from `@rine-network/core`. Those two are stubbed
		// at the module level above, so sender resolution does NOT touch the
		// fetch stub. The only fetch call the test drives is the inbox GET,
		// and that's the one we want to abort mid-flight.
		//
		// `getCoreHttpClient()` still needs to return *something* duck-typed
		// as `CoreHttpClient`, but `fetchAgents` never calls methods on it
		// because the mock short-circuits.
		(
			http as unknown as {
				getCoreHttpClient: () => Record<string, unknown>;
			}
		).getCoreHttpClient = () => ({});
		const messages = new MessagesResource(http);

		const ac = new AbortController();
		const pending = messages.inbox({ signal: ac.signal });

		// Let the resolveSenderId microtasks settle, then abort. By the time
		// we abort, execution is parked inside the fetch stub (the inbox GET).
		await Promise.resolve();
		await Promise.resolve();
		ac.abort();

		const err = await pending.catch((e) => e);
		expect((err as Error).name).toBe("AbortError");
		expect(err).not.toBeInstanceOf(RineTimeoutError);
		// Exactly one fetch call — the inbox GET. Sender resolution never
		// touched the network because `fetchAgents` / `resolveAgent` are
		// mocked at the module level.
		expect(fx.calls).toHaveLength(1);
		expect(fx.calls[0]?.url).toContain("/agents/");
		expect(fx.calls[0]?.url).toContain("/messages");
	});
});
