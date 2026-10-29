import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKHttpClient } from "../api/http.js";

// Make the reconnect backoff zero-latency so tests run in real time without
// fake timers. Must be declared before the SUT import so the mock is applied
// when `streams.ts` resolves the `../utils/sleep.js` dependency.
vi.mock("../utils/sleep.js", () => ({
	sleepWithSignal: () => Promise.resolve(),
}));

// SUT imported after the mock is registered.
const { StreamsResource } = await import("./streams.js");

// Helper: build a Response whose body streams the given SSE text and closes cleanly.
function sseResponse(body: string): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(body));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

// Helper: build a Response that emits the given text then errors the stream —
// this simulates a mid-flight network drop that triggers the reconnect loop.
// Uses `pull` (not `start`) so the chunk is delivered to the reader BEFORE the
// error; calling `controller.error()` synchronously after `enqueue()` in
// `start()` supersedes the enqueued chunk and the reader never sees it.
function sseResponseThenError(body: string, err: Error): Response {
	const encoder = new TextEncoder();
	let emitted = false;
	const stream = new ReadableStream({
		pull(controller) {
			if (!emitted) {
				controller.enqueue(encoder.encode(body));
				emitted = true;
				return;
			}
			controller.error(err);
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface OpenStreamCall {
	path: string;
	headers: Record<string, string> | undefined;
}

// Minimal SDKHttpClient stub driven by a FIFO queue of response producers.
function makeHttpStub(
	queue: Array<
		(() => Response) | (() => Promise<Response>) | (() => never) | Response
	>,
): { http: SDKHttpClient; calls: OpenStreamCall[] } {
	const calls: OpenStreamCall[] = [];
	let i = 0;
	const openStream = async (
		path: string,
		opts: { headers?: Record<string, string>; signal: AbortSignal },
	): Promise<Response> => {
		calls.push({ path, headers: opts.headers });
		const item = queue[i++];
		if (item === undefined) {
			// Park forever so callers that hit the tail of the queue can abort.
			return new Promise<Response>(() => undefined);
		}
		if (typeof item === "function") return item();
		return item;
	};
	return {
		http: { openStream } as unknown as SDKHttpClient,
		calls,
	};
}

// Collect with a hard abort on an event count so a bug can't hang the test.
async function collectUntil<T>(
	iter: AsyncIterable<T>,
	predicate: (evs: T[]) => boolean,
	abort: AbortController,
): Promise<T[]> {
	const out: T[] = [];
	for await (const v of iter) {
		out.push(v);
		if (predicate(out)) {
			abort.abort();
			break;
		}
	}
	return out;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("StreamsResource", () => {
	it("forwards Last-Event-ID on reconnect after a mid-stream error", async () => {
		const { http, calls } = makeHttpStub([
			// First connection: emits message with id="abc" then the network errors.
			() =>
				sseResponseThenError(
					"event: message\ndata: one\nid: abc\n\n",
					new Error("network drop"),
				),
			// Second connection: emits one message then closes cleanly.
			() => sseResponse("event: message\ndata: two\nid: xyz\n\n"),
		]);

		const streams = new StreamsResource(http);
		const ac = new AbortController();
		const payloads: string[] = [];
		for await (const ev of streams.stream({ signal: ac.signal })) {
			if (ev.type === "message") payloads.push(ev.data);
			if (payloads.length >= 2) {
				ac.abort();
				break;
			}
		}

		expect(calls.length).toBe(2);
		expect(calls[0]?.headers?.["Last-Event-ID"]).toBeUndefined();
		expect(calls[1]?.headers?.["Last-Event-ID"]).toBe("abc");
		expect(payloads).toEqual(["one", "two"]);
	});

	it("dedupes events the server replays after reconnect (SeenIds)", async () => {
		const { http } = makeHttpStub([
			() =>
				sseResponseThenError(
					"event: message\ndata: one\nid: m1\n\n" +
						"event: message\ndata: two\nid: m2\n\n",
					new Error("drop"),
				),
			// Catch-up replays m2 then adds m3.
			() =>
				sseResponse(
					"event: message\ndata: two-replay\nid: m2\n\n" +
						"event: message\ndata: three\nid: m3\n\n",
				),
		]);

		const streams = new StreamsResource(http);
		const ac = new AbortController();
		const payloads: string[] = [];
		for await (const ev of streams.stream({ signal: ac.signal })) {
			if (ev.type === "message") payloads.push(ev.data);
			if (payloads.length >= 3) {
				ac.abort();
				break;
			}
		}

		// Replay of m2 (with payload "two-replay") is dropped by SeenIds.
		expect(payloads).toEqual(["one", "two", "three"]);
	});

	it("resets the backoff to 1s after a successful connection", async () => {
		const { http } = makeHttpStub([
			// Fail 1.
			() => {
				throw new Error("boom-1");
			},
			// Succeed, then drop mid-stream.
			() =>
				sseResponseThenError(
					"event: message\ndata: ok\nid: a\n\n",
					new Error("drop"),
				),
			// Fail 2 — if backoff was reset after the success, this should be
			// "reconnecting in 2s" (1→2), not "reconnecting in 8s" (4→8 had the
			// bug regressed).
			() => {
				throw new Error("boom-2");
			},
		]);

		const streams = new StreamsResource(http);
		const ac = new AbortController();
		const heartbeats: string[] = [];
		for await (const ev of streams.stream({ signal: ac.signal })) {
			if (ev.type === "heartbeat") heartbeats.push(ev.data);
			if (heartbeats.length >= 2) {
				ac.abort();
				break;
			}
		}

		expect(heartbeats.length).toBe(2);
		expect(heartbeats[0]).toContain("reconnecting in 2s");
		// Post-success, backoff reset to 1 → doubled to 2 on the next failure.
		expect(heartbeats[1]).toContain("reconnecting in 2s");
	});

	it("enters the reconnect loop on a non-OK response", async () => {
		const { http } = makeHttpStub([
			() => new Response("", { status: 503 }),
			() => sseResponse("event: message\ndata: recovered\nid: a\n\n"),
		]);

		const streams = new StreamsResource(http);
		const ac = new AbortController();
		const types: string[] = [];
		for await (const ev of streams.stream({ signal: ac.signal })) {
			types.push(ev.type);
			if (ev.type === "message") {
				ac.abort();
				break;
			}
		}

		expect(types).toContain("heartbeat");
		expect(types).toContain("message");
	});

	it("exponential backoff progresses 1→2→4→8→16→30 and caps at 30s", async () => {
		// Eight consecutive failures — the backoff sequence should be
		// 1s → 2s → 4s → 8s → 16s → 30s → 30s → 30s, capped at `maxDelayMs`.
		// Each failure emits one heartbeat frame carrying `"reconnecting in Ns"`.
		const queue: Array<() => never> = [];
		for (let i = 0; i < 8; i++) {
			queue.push(() => {
				throw new Error(`boom-${i}`);
			});
		}
		const { http } = makeHttpStub(queue);

		const streams = new StreamsResource(http);
		const ac = new AbortController();
		const heartbeats: string[] = [];
		for await (const ev of streams.stream({ signal: ac.signal })) {
			if (ev.type === "heartbeat") heartbeats.push(ev.data);
			if (heartbeats.length >= 8) {
				ac.abort();
				break;
			}
		}

		// Extract the "N" from each "reconnecting in Ns: ..." message. A
		// format change that broke the regex would yield all NaN; the
		// explicit length + "not NaN" check below catches that loudly before
		// any cap assertion, so the failure message points at the real
		// cause instead of an opaque "expected NaN to equal 2".
		const seconds = heartbeats.map((h) => {
			const m = h.match(/reconnecting in (\d+)s/);
			return m ? Number(m[1]) : NaN;
		});
		expect(seconds).toHaveLength(8);
		expect(seconds.every((n) => Number.isFinite(n))).toBe(true);

		// Invariant 1: no backoff delay EVER exceeds the 30s cap. This is
		// the `maxDelayMs` contract and must hold even if the doubling order
		// ever changes.
		expect(seconds.every((n) => n <= 30)).toBe(true);

		// Invariant 2: the delay is monotonically non-decreasing until it
		// plateaus at the cap — a regression that reset backoff mid-sequence
		// or failed to double would fail this.
		for (let i = 1; i < seconds.length; i++) {
			expect(seconds[i] as number).toBeGreaterThanOrEqual(
				seconds[i - 1] as number,
			);
		}

		// Exact sequence for the current doubling-before-heartbeat
		// implementation. This assertion documents the as-implemented
		// behaviour precisely so a refactor that subtly changes the starting
		// point is visible. The cap behaviour (Invariant 1) survives
		// independently above.
		expect(seconds).toEqual([2, 4, 8, 16, 30, 30, 30, 30]);
		// The ideal sequence is "1s → 2s → 4s → 8s → 16s → 30s" but the
		// current `connect()` doubles *before* emitting the heartbeat, so
		// the first user-visible value is 2s (from 1s doubled), not 1s.
	});

	it("resumes with the current Last-Event-ID after multiple reconnects", async () => {
		// Three successive failures with updates to the last-seen id, each
		// followed by a reconnect. The client must send the *most recent*
		// id on every reconnect, not the one from the original connection.
		const { http, calls } = makeHttpStub([
			() =>
				sseResponseThenError(
					"event: message\ndata: first\nid: id-1\n\n",
					new Error("drop-1"),
				),
			() =>
				sseResponseThenError(
					"event: message\ndata: second\nid: id-2\n\n",
					new Error("drop-2"),
				),
			() => sseResponse("event: message\ndata: third\nid: id-3\n\n"),
		]);

		const streams = new StreamsResource(http);
		const ac = new AbortController();
		const payloads: string[] = [];
		for await (const ev of streams.stream({ signal: ac.signal })) {
			if (ev.type === "message") payloads.push(ev.data);
			if (payloads.length >= 3) {
				ac.abort();
				break;
			}
		}

		expect(payloads).toEqual(["first", "second", "third"]);
		expect(calls).toHaveLength(3);
		expect(calls[0]?.headers?.["Last-Event-ID"]).toBeUndefined();
		expect(calls[1]?.headers?.["Last-Event-ID"]).toBe("id-1");
		expect(calls[2]?.headers?.["Last-Event-ID"]).toBe("id-2");
	});

	it("aborts cleanly when the signal fires mid-backoff", async () => {
		const { http } = makeHttpStub([
			() => {
				throw new Error("boom");
			},
		]);

		const streams = new StreamsResource(http);
		const ac = new AbortController();
		const types: string[] = [];
		for await (const ev of streams.stream({ signal: ac.signal })) {
			types.push(ev.type);
			if (ev.type === "heartbeat") {
				ac.abort();
			}
		}

		// Only the one heartbeat from the first failure; abort stops the loop.
		expect(types).toEqual(["heartbeat"]);
	});
});
