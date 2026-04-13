/**
 * SSE → AsyncIterable adapter.
 *
 * Converts an SSE (Server-Sent Events) stream into a native TypeScript
 * AsyncIterable, so it composes with `for-await-of`, TransformStream, etc.
 *
 * The adapter:
 * - Handles SSE line parsing (event:, data:, id:, :)
 * - Dispatches accumulated events on blank lines (the SSE delimiter)
 * - Yields structured `{ type, data, id }` objects
 * - Couples with AbortSignal for cancellation
 */

import type { RineEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type SSELine =
	| { field: "event" | "data" | "id"; value: string }
	| { field: "dispatch" };

/**
 * Convert a fetch Response with an SSE body into an AsyncIterable of RineEvent.
 *
 * @param response - A fetch Response whose body is an SSE stream.
 * @param signal   - AbortSignal for cancellation.
 *
 * Usage:
 * ```ts
 * const resp = await fetch(url, { headers: { Accept: 'text/event-stream' } });
 * for await (const event of toAsyncIter(resp, signal)) {
 *   console.log(event.type, event.data);
 * }
 * ```
 */
export async function* toAsyncIter(
	response: Response,
	signal: AbortSignal,
): AsyncGenerator<RineEvent> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();

	let buffer = "";
	let eventType = "";
	let eventData = "";
	let eventId: string | null = null;
	// First occurrence of an unknown SSE event type surfaces one console.warn
	// per stream so protocol drift is visible in dev without spamming logs.
	const warnedUnknownTypes = new Set<string>();

	const cleanup = () => {
		reader.cancel().catch(() => {
			/* ignore cancel errors */
		});
	};

	signal.addEventListener("abort", cleanup, { once: true });

	// Short-circuit an already-aborted signal so we don't yield anything
	// from a pre-buffered response body.
	if (signal.aborted) {
		signal.removeEventListener("abort", cleanup);
		cleanup();
		return;
	}

	const flush = function* (): Generator<RineEvent> {
		if (!(eventType || eventData)) return;
		const event = parseRineEvent(
			eventType,
			eventData,
			eventId ?? undefined,
			warnedUnknownTypes,
		);
		if (event !== null) yield event;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			// Split on newlines, keeping the last partial line in buffer
			const lines = buffer.split("\n");
			buffer = lines[lines.length - 1] ?? "";

			for (const raw of lines.slice(0, -1)) {
				const line = parseLine(raw);
				if (line === null) continue;

				if (line.field === "dispatch") {
					// Blank line → dispatch accumulated event
					yield* flush();
					eventType = "";
					eventData = "";
					eventId = null;
				} else if (line.field === "event") {
					eventType = line.value;
				} else if (line.field === "data") {
					if (eventData) eventData += "\n";
					eventData += line.value;
				} else if (line.field === "id") {
					eventId = line.value;
				}
			}

			if (signal.aborted) break;
		}

		// Final flush (no blank terminator line needed)
		yield* flush();
	} finally {
		signal.removeEventListener("abort", cleanup);
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseLine(raw: string): SSELine | null {
	const line = raw.trimEnd();
	// Blank line is the SSE event delimiter — emit a dispatch sentinel so the
	// consumer flushes whatever it accumulated since the previous blank line.
	if (!line) return { field: "dispatch" };
	if (line.startsWith(":")) return null; // SSE comment line

	const colonIdx = line.indexOf(":");
	// Field-only lines (no colon) are legal in SSE but carry no payload — ignore.
	if (colonIdx === -1) return null;

	const field = line.slice(0, colonIdx);
	// Per spec: only a single leading space is stripped from the value.
	const rawValue = line.slice(colonIdx + 1);
	const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

	if (field === "event") return { field: "event", value };
	if (field === "data") return { field: "data", value };
	if (field === "id") return { field: "id", value };
	return null;
}

function parseRineEvent(
	rawType: string,
	data: string,
	id: string | undefined,
	warnedUnknownTypes: Set<string>,
): RineEvent | null {
	const type = mapEventType(rawType);
	if (type === null) {
		if (!warnedUnknownTypes.has(rawType)) {
			warnedUnknownTypes.add(rawType);
			console.warn(`rine: unknown SSE event type ignored: ${rawType}`);
		}
		return null;
	}
	return { type, data, id };
}

function mapEventType(raw: string): RineEvent["type"] | null {
	switch (raw) {
		case "message":
			return "message";
		case "heartbeat":
			return "heartbeat";
		case "status":
			return "status";
		case "disconnect":
			return "disconnect";
		// SSE spec: an empty `event:` field means "message" event.
		case "":
			return "message";
		default:
			return null;
	}
}
