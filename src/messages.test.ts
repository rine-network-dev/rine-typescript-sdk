/**
 * Regression tests for `client.messages()`.
 *
 * Each test stubs three things on a real `AsyncRineClient` instance:
 *
 *   1. `client.streams.stream()`                   — the underlying SSE source
 *   2. `client.messagingResource.resolveSenderId`  — the agent-UUID resolver
 *   3. `client.http.getCoreHttpClient()`           — the rine-core bridge factory
 *
 * ...and mocks `./resources/decrypt.js` so each yielded `DecryptedMessage`
 * is deterministic and the test never touches real crypto or the filesystem.
 * The constructor on `AsyncRineClient` only stashes config — no network,
 * no filesystem reads — so `new AsyncRineClient({})` is safe here.
 */

import { randomUUID } from "node:crypto";
import { ACTING_AGENT_HEADER } from "@rine-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecryptedMessage, RineEvent } from "./types.js";

const CONV_ID = randomUUID();
const SENDER_ID = randomUUID();
const RECIPIENT_ID = randomUUID();

// Mock must register BEFORE the SUT import so messagesGenerator binds to
// the mocked `decryptEnvelope`. The mock preserves the input envelope
// shape and appends a synthetic plaintext derived from `metadata.label`
// so individual tests can assert on which envelopes made it through the
// pre-decrypt filters.
vi.mock("./resources/decrypt.js", () => ({
	decryptEnvelope: vi.fn(
		async (opts: {
			// biome-ignore lint/suspicious/noExplicitAny: test shim
			msg: any;
		}) => {
			const label =
				(opts.msg?.metadata as { label?: string } | undefined)?.label ??
				"<no-label>";
			return {
				...opts.msg,
				metadata: opts.msg.metadata ?? {},
				plaintext: `plaintext:${label}`,
				verified: true,
				verification_status: "verified" as const,
				decrypt_error: null,
			};
		},
	),
}));

// Grab the mocked reference so individual tests can override behavior.
const decryptMod = await import("./resources/decrypt.js");
const mockedDecryptEnvelope = vi.mocked(decryptMod.decryptEnvelope);

const { AsyncRineClient } = await import("./client.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MessagePayload = {
	id: string;
	label: string; // test-only tag — carried via metadata.label
	type: string;
	conversation_id?: string;
	from_agent_id?: string | null;
	to_agent_id?: string | null;
	encrypted_payload?: string;
	encryption_version?: string;
	group_id?: string;
	created_at?: string;
	metadata?: Record<string, unknown>;
};

/**
 * Build a message payload with a generated UUID id but a human-readable
 * `label` stored inside `metadata` so tests can assert on stable tags
 * without having to pre-compute the random id.
 */
function messagePayload(
	over: Partial<MessagePayload> & { label: string; type: string },
): MessagePayload {
	const id = over.id ?? randomUUID();
	return {
		id,
		conversation_id: CONV_ID,
		from_agent_id: SENDER_ID,
		to_agent_id: RECIPIENT_ID,
		encrypted_payload: "enc-payload",
		encryption_version: "hpke-hybrid-v2",
		created_at: "2026-04-11T00:00:00.000Z",
		...over,
		metadata: { label: over.label, ...(over.metadata ?? {}) },
	};
}

function messageEvent(payload: MessagePayload): RineEvent {
	// `label` is test-only — the wire payload is just the MessageRead fields.
	const { label: _label, ...wire } = payload;
	return { type: "message", data: JSON.stringify(wire), id: payload.id };
}

/** Extract the label tag we embedded into `metadata.label`. */
function labelOf(msg: DecryptedMessage): string {
	return (msg.metadata as { label?: string })?.label ?? "<no-label>";
}

/**
 * Wire stubs into a fresh `AsyncRineClient`. `streamEvents` is the
 * sequence the underlying `streams.stream()` will yield before the
 * iterator closes (the underlying generator returns, which closes the
 * `client.messages()` loop naturally).
 */
function makeClientWithEvents(streamEvents: RineEvent[]): {
	client: InstanceType<typeof AsyncRineClient>;
	streamCalls: Array<Record<string, unknown>>;
	markDelivered: ReturnType<typeof vi.fn>;
} {
	const client = new AsyncRineClient({});
	const streamCalls: Array<Record<string, unknown>> = [];

	// Stub streams.stream() to produce a bounded async iterable over the
	// pre-baked event list. Record the opts so tests can assert on forwarding.
	// biome-ignore lint/suspicious/noExplicitAny: test override of instance method
	(client.streams as any).stream = (opts: Record<string, unknown>) => {
		streamCalls.push(opts);
		return (async function* () {
			for (const ev of streamEvents) yield ev;
		})();
	};

	// Stub resolveSenderId so no /agents request is fired.
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).messagingResource.resolveSenderId = vi
		.fn()
		.mockResolvedValue(RECIPIENT_ID);

	// Stub getCoreHttpClient — decryptEnvelope is mocked, so the only call
	// the bridge sees is the batched `mark-delivered` ack.
	const markDelivered = vi.fn().mockResolvedValue({ marked: 1 });
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.getCoreHttpClient = () => ({ markDelivered });

	return { client, streamCalls, markDelivered };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const v of iter) out.push(v);
	return out;
}

afterEach(() => {
	vi.restoreAllMocks();
	mockedDecryptEnvelope.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("client.messages()", () => {
	it("yields decrypted messages for each message-type SSE event", async () => {
		const { client } = makeClientWithEvents([
			messageEvent(
				messagePayload({ label: "m1", type: "rine.v1.task_request" }),
			),
			messageEvent(
				messagePayload({ label: "m2", type: "rine.v1.task_response" }),
			),
		]);

		const out = await collect(client.messages());

		expect(out.map(labelOf)).toEqual(["m1", "m2"]);
		expect(out[0]?.plaintext).toBe("plaintext:m1");
		expect(out[0]?.decrypt_error).toBeNull();
	});

	it("drops non-message SSE events (heartbeat, status, disconnect)", async () => {
		const { client } = makeClientWithEvents([
			{ type: "heartbeat", data: "" },
			messageEvent(
				messagePayload({ label: "m1", type: "rine.v1.task_request" }),
			),
			{ type: "status", data: "ready", id: "s1" },
			messageEvent(
				messagePayload({ label: "m2", type: "rine.v1.task_request" }),
			),
			{ type: "disconnect", data: "bye" },
		]);

		const out = await collect(client.messages());

		expect(out.map(labelOf)).toEqual(["m1", "m2"]);
	});

	it("applies the pre-decrypt type filter (single string)", async () => {
		const { client } = makeClientWithEvents([
			messageEvent(
				messagePayload({ label: "m1", type: "rine.v1.task_request" }),
			),
			messageEvent(
				messagePayload({ label: "m2", type: "rine.v1.status_update" }),
			),
			messageEvent(
				messagePayload({ label: "m3", type: "rine.v1.task_request" }),
			),
		]);

		const out = await collect(
			client.messages({ type: "rine.v1.task_request" }),
		);

		expect(out.map(labelOf)).toEqual(["m1", "m3"]);
		// Filtered-out event never went through decryptEnvelope — pre-decrypt
		// cost savings.
		expect(mockedDecryptEnvelope).toHaveBeenCalledTimes(2);
		const decryptedLabels = mockedDecryptEnvelope.mock.calls.map(
			// biome-ignore lint/suspicious/noExplicitAny: narrow mock call arg
			(call) => ((call[0] as any).msg.metadata as { label: string }).label,
		);
		expect(decryptedLabels).toEqual(["m1", "m3"]);
	});

	it("applies the pre-decrypt type filter (array form)", async () => {
		const { client } = makeClientWithEvents([
			messageEvent(
				messagePayload({ label: "m1", type: "rine.v1.task_request" }),
			),
			messageEvent(
				messagePayload({ label: "m2", type: "rine.v1.status_update" }),
			),
			messageEvent(messagePayload({ label: "m3", type: "a2a.v1.message" })),
		]);

		const out = await collect(
			client.messages({
				type: ["rine.v1.task_request", "a2a.v1.message"],
			}),
		);

		expect(out.map(labelOf)).toEqual(["m1", "m3"]);
	});

	it("hides reserved message types by default", async () => {
		const { client } = makeClientWithEvents([
			messageEvent(
				messagePayload({
					label: "sk1",
					type: "rine.v1.sender_key_distribution",
				}),
			),
			messageEvent(
				messagePayload({ label: "m1", type: "rine.v1.task_request" }),
			),
		]);

		const out = await collect(client.messages());

		expect(out.map(labelOf)).toEqual(["m1"]);
		// Reserved type never touched the decrypt path either.
		expect(mockedDecryptEnvelope).toHaveBeenCalledTimes(1);
	});

	it("yields reserved types when includeReserved: true and warns once", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const { client: c1 } = makeClientWithEvents([
			messageEvent(
				messagePayload({
					label: "sk1",
					type: "rine.v1.sender_key_distribution",
				}),
			),
		]);
		const out1 = await collect(c1.messages({ includeReserved: true }));
		expect(out1.map(labelOf)).toEqual(["sk1"]);

		// Second call on a brand-new client — warn must NOT fire again.
		const { client: c2 } = makeClientWithEvents([
			messageEvent(
				messagePayload({
					label: "sk2",
					type: "rine.v1.sender_key_distribution",
				}),
			),
		]);
		const out2 = await collect(c2.messages({ includeReserved: true }));
		expect(out2.map(labelOf)).toEqual(["sk2"]);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/includeReserved/);
	});

	it("surfaces decrypt failures as decrypt_error without throwing", async () => {
		mockedDecryptEnvelope.mockImplementationOnce(async (opts) => ({
			// biome-ignore lint/suspicious/noExplicitAny: mock input shape
			...(opts as any).msg,
			// biome-ignore lint/suspicious/noExplicitAny: mock input shape
			metadata: (opts as any).msg.metadata ?? {},
			plaintext: undefined,
			verified: false,
			verification_status: "unverifiable" as const,
			decrypt_error: "simulated crypto failure",
		}));

		const { client } = makeClientWithEvents([
			messageEvent(
				messagePayload({ label: "m1", type: "rine.v1.task_request" }),
			),
			messageEvent(
				messagePayload({ label: "m2", type: "rine.v1.task_request" }),
			),
		]);

		const out = await collect(client.messages());

		expect(out.map(labelOf)).toEqual(["m1", "m2"]);
		expect(out[0]?.decrypt_error).toBe("simulated crypto failure");
		expect(out[0]?.plaintext).toBeUndefined();
		// Second message decrypts fine — one bad envelope does not kill the loop.
		expect(out[1]?.decrypt_error).toBeNull();
		expect(out[1]?.plaintext).toBe("plaintext:m2");
	});

	it("self-heals a cold sender-key group envelope instead of yielding it undecrypted", async () => {
		// The stream can deliver a group message before its key material
		// (the sender-key distribution is a separate message, and the loop
		// drops reserved types). The loop must therefore ask `decryptEnvelope`
		// for the same recovery `read()` gets — fetch pending distributions
		// from the server, then retry once. Without `retrySenderKey: true` the
		// message yields `decrypt_error: "unknown sender key id: …"` forever.
		mockedDecryptEnvelope.mockImplementationOnce(async (opts) => {
			// biome-ignore lint/suspicious/noExplicitAny: mock input shape
			const msg = (opts as any).msg;
			const cold =
				msg.encryption_version === "sender-key-v1" && !opts.retrySenderKey;
			return {
				...msg,
				metadata: msg.metadata ?? {},
				plaintext: cold ? undefined : "plaintext:group",
				verified: !cold,
				verification_status: cold
					? ("unverifiable" as const)
					: ("verified" as const),
				decrypt_error: cold ? "unknown sender key id: sk-1" : null,
			};
		});

		const { client } = makeClientWithEvents([
			messageEvent(
				messagePayload({
					label: "g1",
					type: "rine.v1.task_request",
					encryption_version: "sender-key-v1",
					group_id: "99999999-9999-4999-8999-999999999999",
				}),
			),
		]);

		const out = await collect(client.messages());

		expect(out).toHaveLength(1);
		expect(out[0]?.plaintext).toBe("plaintext:group");
		expect(out[0]?.decrypt_error).toBeNull();
		// And the memo is threaded through so a row seen twice still opens.
		const call = mockedDecryptEnvelope.mock.calls[0]?.[0];
		expect(call?.retrySenderKey).toBe(true);
		expect(call?.memo).toBeDefined();
	});

	it("forwards lastEventId + resolved agent UUID to streams.stream()", async () => {
		const { client, streamCalls } = makeClientWithEvents([]);

		const ac = new AbortController();
		const iter = client.messages({
			lastEventId: "resume-token-123",
			agent: "bot@acme.rine.network",
			signal: ac.signal,
		});
		// Drain — stream yields nothing so the generator returns immediately.
		await collect(iter);

		expect(streamCalls).toHaveLength(1);
		expect(streamCalls[0]).toMatchObject({
			lastEventId: "resume-token-123",
			// resolveSenderId is stubbed to return the fixed UUID — the iterator
			// forwards THAT (not the caller-supplied handle) as `agent` so the
			// SSE path `/agents/{id}/stream` is always keyed on a UUID.
			agent: RECIPIENT_ID,
		});
		expect(streamCalls[0]?.signal).toBe(ac.signal);
	});

	it("skips message frames whose data is not valid JSON and warns once", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { client } = makeClientWithEvents([
			{ type: "message", data: "not-json{", id: "bad-1" },
			{ type: "message", data: "still-broken{", id: "bad-2" },
			messageEvent(
				messagePayload({ label: "m1", type: "rine.v1.task_request" }),
			),
		]);

		const out = await collect(client.messages());

		expect(out.map(labelOf)).toEqual(["m1"]);
		// Two malformed frames, but only ONE warn — subsequent drops on the
		// same stream are silent so bad servers can't flood logs.
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/malformed SSE envelope/);
	});

	it("skips message frames whose envelope fails schema validation", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { client } = makeClientWithEvents([
			// Missing required `id` field — DecryptedMessageSchema.parse throws.
			{
				type: "message",
				data: JSON.stringify({ type: "rine.v1.task_request" }),
			},
			messageEvent(
				messagePayload({ label: "m1", type: "rine.v1.task_request" }),
			),
		]);

		const out = await collect(client.messages());

		expect(out.map(labelOf)).toEqual(["m1"]);
		// Schema failure also routes through the parse-failure warn path.
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it("propagates resolveSenderId failures to the caller", async () => {
		const client = new AsyncRineClient({});
		// biome-ignore lint/suspicious/noExplicitAny: test override
		(client.streams as any).stream = () => {
			throw new Error("streams.stream should not be called if resolve fails");
		};
		// biome-ignore lint/suspicious/noExplicitAny: test override
		(client as any).messagingResource.resolveSenderId = vi
			.fn()
			.mockRejectedValue(new Error("resolve boom"));
		// biome-ignore lint/suspicious/noExplicitAny: test override
		(client as any).http.getCoreHttpClient = () => ({});

		await expect(collect(client.messages())).rejects.toThrow("resolve boom");
	});

	it("forwards abort reason when an already-aborted signal is supplied", async () => {
		// The stream stub never yields if the generator is wired to close
		// on the pre-aborted signal. But `messagesGenerator` doesn't
		// short-circuit on the signal directly — it relies on the
		// underlying stream to honor it. Confirm the wiring by checking
		// that `streams.stream()` receives the same signal we passed in.
		const { client, streamCalls } = makeClientWithEvents([]);

		const ac = new AbortController();
		ac.abort();
		await collect(client.messages({ signal: ac.signal }));

		expect(streamCalls[0]?.signal).toBe(ac.signal);
		expect((streamCalls[0]?.signal as AbortSignal).aborted).toBe(true);
	});

	it("closes naturally when the underlying stream ends", async () => {
		const { client } = makeClientWithEvents([
			messageEvent(
				messagePayload({ label: "m1", type: "rine.v1.task_request" }),
			),
		]);

		const out: DecryptedMessage[] = [];
		for await (const msg of client.messages()) {
			out.push(msg);
		}

		expect(out).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Delivery acknowledgement
// ---------------------------------------------------------------------------

function ackedIds(markDelivered: ReturnType<typeof vi.fn>): string[] {
	return markDelivered.mock.calls.flatMap((call) => call[1] as string[]);
}

function leaveUnopened(over: Record<string, unknown> = {}) {
	mockedDecryptEnvelope.mockImplementationOnce(async (opts) => ({
		// biome-ignore lint/suspicious/noExplicitAny: mock input shape
		...(opts as any).msg,
		plaintext: undefined,
		verified: false,
		verification_status: "unverifiable" as const,
		decrypt_error: "no keys",
		...over,
	}));
}

describe("client.messages() delivery acknowledgement", () => {
	it("streams in peek mode", async () => {
		const { client, streamCalls } = makeClientWithEvents([]);

		await collect(client.messages());

		expect(streamCalls[0]).toMatchObject({ peek: true });
	});

	it("acks an opened row for the reading agent, in one batch", async () => {
		const a = messagePayload({ label: "a", type: "rine.v1.task_request" });
		const b = messagePayload({ label: "b", type: "rine.v1.task_request" });
		const { client, markDelivered } = makeClientWithEvents([
			messageEvent(a),
			messageEvent(b),
		]);

		await collect(client.messages());

		expect(markDelivered).toHaveBeenCalledTimes(1);
		expect(markDelivered.mock.calls[0]?.[0]).toBe(RECIPIENT_ID);
		expect(markDelivered.mock.calls[0]?.[1]).toEqual([a.id, b.id]);
		expect(markDelivered.mock.calls[0]?.[2]).toEqual({
			[ACTING_AGENT_HEADER]: RECIPIENT_ID,
		});
	});

	it("acks a row whose sender signature was refused", async () => {
		const a = messagePayload({ label: "a", type: "rine.v1.task_request" });
		leaveUnopened({
			verification_status: "invalid",
			decrypt_error: "invalid signature",
		});
		const { client, markDelivered } = makeClientWithEvents([messageEvent(a)]);

		await collect(client.messages());

		expect(ackedIds(markDelivered)).toEqual([a.id]);
	});

	it("acks a row that was never ciphertext", async () => {
		const a = messagePayload({
			label: "a",
			type: "rine.v1.task_request",
			encryption_version: "none",
		});
		leaveUnopened({ decrypt_error: "not text" });
		const { client, markDelivered } = makeClientWithEvents([messageEvent(a)]);

		await collect(client.messages());

		expect(ackedIds(markDelivered)).toEqual([a.id]);
	});

	it("does not ack a row it could not decrypt", async () => {
		const a = messagePayload({ label: "a", type: "rine.v1.task_request" });
		leaveUnopened();
		const { client, markDelivered } = makeClientWithEvents([messageEvent(a)]);

		const out = await collect(client.messages());

		expect(out).toHaveLength(1);
		expect(markDelivered).not.toHaveBeenCalled();
	});

	it("does not ack a row sealed under a version this client does not know", async () => {
		const a = messagePayload({
			label: "a",
			type: "rine.v1.task_request",
			encryption_version: "hpke-v9",
		});
		leaveUnopened({ decrypt_error: "unsupported encryption version" });
		const { client, markDelivered } = makeClientWithEvents([messageEvent(a)]);

		await collect(client.messages());

		expect(markDelivered).not.toHaveBeenCalled();
	});

	it("acks a reserved row it skips unopened", async () => {
		const sk = messagePayload({
			label: "sk",
			type: "rine.v1.sender_key_distribution",
		});
		const { client, markDelivered } = makeClientWithEvents([messageEvent(sk)]);

		const out = await collect(client.messages());

		expect(out).toEqual([]);
		expect(mockedDecryptEnvelope).not.toHaveBeenCalled();
		expect(ackedIds(markDelivered)).toEqual([sk.id]);
	});

	it("leaves a row outside the type filter new", async () => {
		const other = messagePayload({ label: "o", type: "rine.v1.task_response" });
		const { client, markDelivered } = makeClientWithEvents([
			messageEvent(other),
		]);

		const out = await collect(client.messages({ type: "rine.v1.task_request" }));

		expect(out).toEqual([]);
		expect(markDelivered).not.toHaveBeenCalled();
	});

	it("leaves a frame that is not an envelope new", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { client, markDelivered } = makeClientWithEvents([
			{ type: "message", data: "{not json", id: randomUUID() },
		]);

		await collect(client.messages());

		expect(markDelivered).not.toHaveBeenCalled();
	});

	it("flushes on a heartbeat, ahead of the batch delay", async () => {
		const a = messagePayload({ label: "a", type: "rine.v1.task_request" });
		const b = messagePayload({ label: "b", type: "rine.v1.task_request" });
		const { client, markDelivered } = makeClientWithEvents([
			messageEvent(a),
			{ type: "heartbeat", data: "" },
			messageEvent(b),
		]);
		const sentWhenYielded: number[] = [];

		for await (const _ of client.messages()) {
			sentWhenYielded.push(ackedIds(markDelivered).length);
		}

		expect(sentWhenYielded).toEqual([0, 1]);
		expect(ackedIds(markDelivered)).toEqual([a.id, b.id]);
	});

	it("acks a row that then fails the caller's schema", async () => {
		const a = messagePayload({ label: "a", type: "rine.v1.task_request" });
		const { client, markDelivered } = makeClientWithEvents([messageEvent(a)]);
		const schema = {
			"~standard": {
				version: 1,
				vendor: "test",
				validate: () => ({ issues: [{ message: "nope" }] }),
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: test schema
		await expect(collect(client.messages({ schema: schema as any }))).rejects.toThrow();

		expect(ackedIds(markDelivered)).toEqual([a.id]);
	});

	it("warns and does not throw when the ack fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const a = messagePayload({ label: "a", type: "rine.v1.task_request" });
		const { client, markDelivered } = makeClientWithEvents([messageEvent(a)]);
		markDelivered.mockRejectedValue(new Error("503"));

		const out = await collect(client.messages());

		expect(out).toHaveLength(1);
		expect(warn).toHaveBeenCalledWith(
			"rine: could not mark 1 message(s) delivered; they may be shown again (503)",
		);
	});

	it("flushes what is queued when the consumer breaks out of the loop", async () => {
		const a = messagePayload({ label: "a", type: "rine.v1.task_request" });
		const b = messagePayload({ label: "b", type: "rine.v1.task_request" });
		const { client, markDelivered } = makeClientWithEvents([
			messageEvent(a),
			messageEvent(b),
		]);

		for await (const _ of client.messages()) break;

		expect(ackedIds(markDelivered)).toEqual([a.id]);
	});

	it("flushes what is queued after the caller's signal aborted", async () => {
		const a = messagePayload({ label: "a", type: "rine.v1.task_request" });
		const b = messagePayload({ label: "b", type: "rine.v1.task_request" });
		const { client } = makeClientWithEvents([messageEvent(a), messageEvent(b)]);
		const ac = new AbortController();
		const sent: string[] = [];
		// A core client built with the caller's signal rejects once it aborts, as
		// the real one does; only a client built without it can still send.
		// biome-ignore lint/suspicious/noExplicitAny: test override
		(client as any).http.getCoreHttpClient = (o?: { signal?: AbortSignal }) => ({
			markDelivered: async (_agent: string, ids: string[]) => {
				if (o?.signal?.aborted) {
					throw Object.assign(new Error("aborted"), { name: "AbortError" });
				}
				sent.push(...ids);
				return { marked: ids.length };
			},
		});

		for await (const _ of client.messages({ signal: ac.signal })) ac.abort();

		expect(sent).toEqual([a.id]);
	});

	it("still acks a reserved row it yields when includeReserved is set", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const sk = messagePayload({
			label: "sk",
			type: "rine.v1.sender_key_distribution",
		});
		const { client, markDelivered } = makeClientWithEvents([messageEvent(sk)]);

		const out = await collect(client.messages({ includeReserved: true }));

		expect(out).toHaveLength(1);
		expect(ackedIds(markDelivered)).toEqual([sk.id]);
	});
});

describe("conversation.messages() delivery acknowledgement", () => {
	const OTHER_CONV = randomUUID();

	it("acks and yields a row of its own conversation", async () => {
		const mine = messagePayload({ label: "mine", type: "rine.v1.task_request" });
		const { client, markDelivered } = makeClientWithEvents([messageEvent(mine)]);

		const out = await collect(client.conversation(CONV_ID).messages());

		expect(out.map(labelOf)).toEqual(["mine"]);
		expect(ackedIds(markDelivered)).toEqual([mine.id]);
	});

	it("skips a row of another conversation before decrypt and leaves it new", async () => {
		const other = messagePayload({
			label: "other",
			type: "rine.v1.task_request",
			conversation_id: OTHER_CONV,
		});
		const { client, markDelivered } = makeClientWithEvents([
			messageEvent(other),
		]);

		const out = await collect(client.conversation(CONV_ID).messages());

		expect(out).toEqual([]);
		expect(mockedDecryptEnvelope).not.toHaveBeenCalled();
		expect(markDelivered).not.toHaveBeenCalled();
	});
});
