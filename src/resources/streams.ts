/**
 * SSE streaming resource — /agents/{id}/stream with auto-reconnect.
 *
 * Delivers AsyncIterable<RineEvent> with:
 * - Exponential backoff on disconnect (cap: 30s)
 * - Last-Event-ID resume after reconnect
 * - Heartbeat events during quiet periods
 * - Full AbortSignal cancellation
 */

import type { SDKHttpClient } from "../api/http.js";
import type { RineEvent } from "../types.js";
import { anySignal } from "../utils/abort.js";
import { toAsyncIter } from "../utils/sse.js";
import { SeenIds } from "../utils/seen-ids.js";
import { sleepWithSignal } from "../utils/sleep.js";

// ---------------------------------------------------------------------------
// Options types
// ---------------------------------------------------------------------------

export interface StreamOptions {
	/** External AbortSignal for cancellation. */
	signal?: AbortSignal;
	/** Agent ID/handle to stream events for. Defaults to authenticated agent. */
	agent?: string;
	/** Maximum stream duration in ms (timeout). */
	timeout?: number;
	/**
	 * Resume token for server-side replay. Sent as the initial
	 * `Last-Event-ID` request header; the server replays events after this
	 * id, then continues live. Updated automatically as live events arrive,
	 * so the SPEC §12.4 reconnect loop uses the most recent seen id on
	 * subsequent reconnects regardless of what the caller passed.
	 */
	lastEventId?: string;
}

// ---------------------------------------------------------------------------
// StreamsResource
// ---------------------------------------------------------------------------

export class StreamsResource {
	constructor(private readonly http: SDKHttpClient) {}

	/**
	 * Open an SSE stream yielding RineEvents.
	 *
	 * For agentic use cases, prefer `client.messages()` (SPEC §11.1) which
	 * wraps this with local decryption and cleartext type filtering — this
	 * method is the lower-level raw-event primitive.
	 *
	 * @example
	 * ```ts
	 * const ac = new AbortController();
	 * setTimeout(() => ac.abort(), 60_000);
	 *
	 * for await (const event of client.streams.stream({ signal: ac.signal })) {
	 *   console.log(event.type, event.id);
	 * }
	 * ```
	 */
	stream(opts: StreamOptions = {}): AsyncIterable<RineEvent> {
		const { signal, agent, timeout, lastEventId } = opts;
		const agentSegment = agent ? `/agents/${agent}` : "";

		let combinedSignal: AbortSignal;
		if (signal && timeout !== undefined) {
			combinedSignal = anySignal(signal, AbortSignal.timeout(timeout));
		} else if (signal) {
			combinedSignal = signal;
		} else if (timeout !== undefined) {
			combinedSignal = AbortSignal.timeout(timeout);
		} else {
			combinedSignal = neverAbortingSignal();
		}

		return this.connect(agentSegment, combinedSignal, lastEventId);
	}

	private async *connect(
		agentSegment: string,
		signal: AbortSignal,
		initialLastEventId: string | undefined,
	): AsyncGenerator<RineEvent> {
		let lastEventId: string | undefined = initialLastEventId;
		let backoff = 1; // seconds
		// Bounded FIFO seen-ID set (SPEC_v2 §12.3.3). On reconnect with
		// Last-Event-ID, the server's catch-up query can race with NOTIFY
		// delivery and re-emit events — this is the guard against dispatching
		// them twice within the 500-id window.
		const seen = new SeenIds(500);

		while (!signal.aborted) {
			const headers: Record<string, string> = {};
			if (lastEventId) headers["Last-Event-ID"] = lastEventId;

			try {
				const response = await this.http.openStream(`${agentSegment}/stream`, {
					headers,
					signal,
				});

				if (!response.ok) {
					throw new Error(
						`SSE stream error: ${response.status} ${response.statusText}`,
					);
				}

				// Connection succeeded — reset backoff for the next failure.
				backoff = 1;

				// Delegate SSE parsing to toAsyncIter — yields parsed RineEvents
				for await (const event of toAsyncIter(response, signal)) {
					// Track last ID for resume after reconnect
					if (event.id) {
						// Dedup only events that carry an id. Heartbeats and
						// SDK-synthesized disconnect frames have no id and
						// always pass through.
						if (!seen.record(event.id)) continue;
						lastEventId = event.id;
					}
					yield event;
				}

				// Stream ended normally
				yield { type: "disconnect", data: "stream ended" };
				break;
			} catch (err) {
				if (signal.aborted) break;

				// Exponential backoff before reconnect
				backoff = Math.min(backoff * 2, 30);
				yield {
					type: "heartbeat",
					data: `reconnecting in ${backoff}s: ${err instanceof Error ? err.message : String(err)}`,
				};

				await sleepWithSignal(backoff * 1000, signal);

				if (signal.aborted) break;
				// Will reconnect on next iteration with updated lastEventId
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function neverAbortingSignal(): AbortSignal {
	// Returns an AbortSignal that is never aborted.
	// The caller ensures it is only used for the lifetime of the stream.
	return new AbortController().signal;
}
