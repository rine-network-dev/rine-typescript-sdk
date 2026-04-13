import { describe, expect, it, vi } from "vitest";
import type { RineEvent } from "../types.js";
import { toAsyncIter } from "./sse.js";

// Helper: build a minimal Response whose body streams the given SSE text.
function sseResponse(body: string): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(body));
			controller.close();
		},
	});
	return new Response(stream, {
		headers: { "content-type": "text/event-stream" },
	});
}

// Helper: drain an AsyncIterable of RineEvent into an array.
async function collect(iter: AsyncIterable<RineEvent>): Promise<RineEvent[]> {
	const out: RineEvent[] = [];
	for await (const ev of iter) out.push(ev);
	return out;
}

describe("toAsyncIter — blank-line dispatch", () => {
	it("dispatches an event on the blank-line delimiter", async () => {
		const frame = "event: message\ndata: hello\nid: abc\n\n";
		const events = await collect(
			toAsyncIter(sseResponse(frame), new AbortController().signal),
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "message",
			data: "hello",
			id: "abc",
		});
	});

	it("dispatches multiple events separated by blank lines", async () => {
		const frames =
			"event: message\ndata: one\n\n" +
			"event: heartbeat\ndata: tick\n\n" +
			"event: message\ndata: two\n\n";
		const events = await collect(
			toAsyncIter(sseResponse(frames), new AbortController().signal),
		);
		expect(events).toHaveLength(3);
		expect(events.map((e) => e.type)).toEqual([
			"message",
			"heartbeat",
			"message",
		]);
		expect(events.map((e) => e.data)).toEqual(["one", "tick", "two"]);
	});

	it("flushes a trailing event with no terminating blank line", async () => {
		const frame = "event: message\ndata: tail\n";
		const events = await collect(
			toAsyncIter(sseResponse(frame), new AbortController().signal),
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "message", data: "tail" });
	});

	it("joins multi-line data fields with a newline", async () => {
		const frame = "event: message\ndata: line1\ndata: line2\n\n";
		const events = await collect(
			toAsyncIter(sseResponse(frame), new AbortController().signal),
		);
		expect(events[0]?.data).toBe("line1\nline2");
	});

	it("ignores SSE comment lines (starting with colon)", async () => {
		const frame = ": keep-alive\nevent: message\ndata: hi\n\n";
		const events = await collect(
			toAsyncIter(sseResponse(frame), new AbortController().signal),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.data).toBe("hi");
	});

	it("strips exactly one leading space from field values", async () => {
		const frame = "event: message\ndata:  two-spaces\n\n";
		const events = await collect(
			toAsyncIter(sseResponse(frame), new AbortController().signal),
		);
		// One space was stripped; the second one is preserved as part of the value.
		expect(events[0]?.data).toBe(" two-spaces");
	});
});

describe("toAsyncIter — event type mapping", () => {
	it("preserves a heartbeat event type", async () => {
		const frame = "event: heartbeat\ndata: {}\n\n";
		const events = await collect(
			toAsyncIter(sseResponse(frame), new AbortController().signal),
		);
		expect(events[0]?.type).toBe("heartbeat");
	});

	it("maps disconnect events", async () => {
		const frame = "event: disconnect\ndata: bye\n\n";
		const events = await collect(
			toAsyncIter(sseResponse(frame), new AbortController().signal),
		);
		expect(events[0]?.type).toBe("disconnect");
	});

	it("preserves server status events as first-class", async () => {
		const frame = "event: status\ndata: {}\n\n";
		const events = await collect(
			toAsyncIter(sseResponse(frame), new AbortController().signal),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("status");
	});

	it("drops unknown event types (does not misroute to message or heartbeat)", async () => {
		const frame = "event: nonsense\ndata: {}\n\nevent: message\ndata: ok\n\n";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const events = await collect(
				toAsyncIter(sseResponse(frame), new AbortController().signal),
			);
			// Unknown event dropped; subsequent real message still delivered.
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("message");
			expect(events[0]?.data).toBe("ok");
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("unknown SSE event type ignored: nonsense"),
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("warns once per unknown type within a single stream", async () => {
		const frame =
			"event: nonsense\ndata: a\n\n" +
			"event: nonsense\ndata: b\n\n" +
			"event: otherweird\ndata: c\n\n";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			await collect(
				toAsyncIter(sseResponse(frame), new AbortController().signal),
			);
			// First `nonsense` + first `otherweird` = two warnings.
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("treats a frame with no event: field as message (SSE default)", async () => {
		const frame = "data: payload\n\n";
		const events = await collect(
			toAsyncIter(sseResponse(frame), new AbortController().signal),
		);
		expect(events[0]).toMatchObject({ type: "message", data: "payload" });
	});
});

describe("toAsyncIter — abort handling", () => {
	it("yields zero events when the signal is aborted before iteration", async () => {
		const ac = new AbortController();
		ac.abort();
		const events = await collect(
			toAsyncIter(
				sseResponse("event: message\ndata: hi\nid: 1\n\n"),
				ac.signal,
			),
		);
		expect(events).toEqual([]);
	});
});

describe("toAsyncIter — framing robustness", () => {
	it("handles events split across chunk boundaries", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode("event: mess"));
				controller.enqueue(encoder.encode("age\ndata: hel"));
				controller.enqueue(encoder.encode("lo\n\n"));
				controller.close();
			},
		});
		const response = new Response(stream);
		const events = await collect(
			toAsyncIter(response, new AbortController().signal),
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "message", data: "hello" });
	});
});
