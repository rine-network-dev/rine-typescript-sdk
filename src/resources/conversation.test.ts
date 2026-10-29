/**
 * Regression tests for `client.conversation()`.
 *
 * The scope builder is transport-free: it delegates to `client.send`,
 * `client.reply`, `client.messages`, and `client.inbox`. Every test here
 * stubs those four slots on a real `AsyncRineClient` instance and asserts
 * on the *delegation contract*, not on any HTTP or crypto behavior.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AsyncRineClient,
	type InboxOptions,
	type MessagesOptions,
	type ReplyOptions,
} from "../client.js";
import type {
	AgentHandle,
	AgentUuid,
	DecryptedMessage,
	MessageUuid,
} from "../types.js";
import { CursorPage } from "../utils/cursor-page.js";
import { ConversationScope } from "./conversation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecrypted(
	over: Partial<DecryptedMessage> & { conversation_id: string },
): DecryptedMessage {
	return {
		id: randomUUID(),
		from_agent_id: randomUUID(),
		to_agent_id: randomUUID(),
		type: "rine.v1.task_request",
		encrypted_payload: "enc",
		encryption_version: "hpke-hybrid-v2",
		metadata: {},
		created_at: "2026-04-11T00:00:00.000Z",
		plaintext: "payload",
		verified: true,
		verification_status: "verified",
		decrypt_error: null,
		...over,
	} as DecryptedMessage;
}

function makePage(
	items: DecryptedMessage[],
	nextCursor: string | null = null,
): CursorPage<DecryptedMessage> {
	return new CursorPage<DecryptedMessage>(
		items,
		items.length,
		nextCursor,
		null,
	);
}

/** Build a controllable async iterable over `messages`. */
function asyncIter(
	messages: DecryptedMessage[],
): AsyncIterable<DecryptedMessage> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const m of messages) yield m;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("client.conversation() — construction", () => {
	it("returns a ConversationScope with the given id", () => {
		const client = new AsyncRineClient({});
		const conv = client.conversation("conv-123");
		expect(conv).toBeInstanceOf(ConversationScope);
		expect(conv.id).toBe("conv-123");
	});

	it("each call returns a fresh instance — not cached", () => {
		const client = new AsyncRineClient({});
		const a = client.conversation("conv-123");
		const b = client.conversation("conv-123");
		expect(a).not.toBe(b);
		expect(a.id).toBe(b.id);
	});
});

// ---------------------------------------------------------------------------
// send()
// ---------------------------------------------------------------------------

describe("ConversationScope.send (routes via reply)", () => {
	it("scope from message routes send(payload) through client.reply(anchorMsgId)", async () => {
		const client = new AsyncRineClient({});
		const replySpy = vi
			.spyOn(client, "reply")
			.mockResolvedValue({ id: "m1" } as never);

		const msg = makeDecrypted({
			conversation_id: "conv-xyz",
			sender_handle: "alice@acme.rine.network",
		});
		const conv = client.conversation(msg);
		await conv.send({ hello: 1 });

		expect(replySpy).toHaveBeenCalledTimes(1);
		const [msgId, payload] = replySpy.mock.calls[0] as unknown as [string, unknown];
		expect(msgId).toBe(msg.id);
		expect(payload).toEqual({ hello: 1 });
	});

	it("forwards opts (type, metadata, idempotencyKey, signal) through to client.reply", async () => {
		const client = new AsyncRineClient({});
		const replySpy = vi
			.spyOn(client, "reply")
			.mockResolvedValue({ id: "m1" } as never);

		const msg = makeDecrypted({
			conversation_id: "conv-xyz",
			sender_handle: "alice@acme.rine.network",
		});
		const conv = client.conversation(msg);
		const ac = new AbortController();
		await conv.send({ text: "hi" }, {
			type: "rine.v1.task_response",
			metadata: { trace: "t1" },
			idempotencyKey: "k1",
			signal: ac.signal,
		});

		const [, , opts] = replySpy.mock.calls[0] as unknown as [string, unknown, ReplyOptions];
		expect(opts.type).toBe("rine.v1.task_response");
		expect(opts.metadata).toEqual({ trace: "t1" });
		expect(opts.idempotencyKey).toBe("k1");
		expect(opts.signal).toBe(ac.signal);
	});

	it("send(to, payload) validates explicit recipient matches scope peer", async () => {
		const client = new AsyncRineClient({});
		vi.spyOn(client, "reply").mockResolvedValue({ id: "m1" } as never);

		const msg = makeDecrypted({
			conversation_id: "conv-xyz",
			sender_handle: "alice@acme.rine.network",
		});
		const conv = client.conversation(msg);
		// Matching peer — should succeed
		await expect(
			conv.send("alice@acme.rine.network" as AgentHandle, { ok: true }),
		).resolves.toBeDefined();

		// Mismatched peer — should reject
		await expect(
			conv.send("bob@acme.rine.network" as AgentHandle, { ok: true }),
		).rejects.toThrow(/does not match scope peer/);
	});

	it("scope from bare id throws on send (cannot thread)", async () => {
		const client = new AsyncRineClient({});
		const conv = client.conversation("conv-xyz");
		await expect(
			conv.send("bot@acme.rine.network" as AgentHandle, { hello: 1 }),
		).rejects.toThrow(/bare conversation id/);
		await expect(conv.send({ hello: 1 })).rejects.toThrow(
			/bare conversation id/,
		);
	});

	it("returns whatever client.reply() returns", async () => {
		const client = new AsyncRineClient({});
		const stub = { id: "delegated" };
		vi.spyOn(client, "reply").mockResolvedValue(stub as never);

		const msg = makeDecrypted({
			conversation_id: "conv-xyz",
			sender_handle: "alice@acme.rine.network",
		});
		const conv = client.conversation(msg);
		const result = await conv.send({ hello: 1 });
		expect(result).toBe(stub);
	});
});

// ---------------------------------------------------------------------------
// reply()
// ---------------------------------------------------------------------------

describe("ConversationScope.reply", () => {
	it("delegates straight through to client.reply", async () => {
		const client = new AsyncRineClient({});
		const replySpy = vi
			.spyOn(client, "reply")
			.mockResolvedValue({ id: "r1" } as never);

		const conv = client.conversation("conv-xyz");
		const msgId = randomUUID() as unknown as MessageUuid;
		const ac = new AbortController();
		await conv.reply(
			msgId,
			{ ok: true },
			{
				type: "rine.v1.task_response",
				signal: ac.signal,
			},
		);

		expect(replySpy).toHaveBeenCalledTimes(1);
		const [id, payload, opts] = replySpy.mock.calls[0] as [
			MessageUuid,
			unknown,
			ReplyOptions,
		];
		expect(id).toBe(msgId);
		expect(payload).toEqual({ ok: true });
		expect(opts.type).toBe("rine.v1.task_response");
		expect(opts.signal).toBe(ac.signal);
	});

	it("does not mutate the passed opts object", async () => {
		const client = new AsyncRineClient({});
		vi.spyOn(client, "reply").mockResolvedValue({ id: "r1" } as never);

		const conv = client.conversation("conv-xyz");
		const opts: ReplyOptions = { metadata: { trace: "t1" } };
		const before = JSON.stringify(opts);
		await conv.reply(randomUUID() as unknown as MessageUuid, "x", opts);
		expect(JSON.stringify(opts)).toBe(before);
	});

	it("propagates client.reply() rejection to the caller", async () => {
		const client = new AsyncRineClient({});
		vi.spyOn(client, "reply").mockRejectedValue(new Error("network failure"));

		const conv = client.conversation("conv-xyz");
		await expect(
			conv.reply(randomUUID() as unknown as MessageUuid, {}),
		).rejects.toThrow("network failure");
	});
});

// ---------------------------------------------------------------------------
// messages()
// ---------------------------------------------------------------------------

describe("ConversationScope.messages", () => {
	it("yields only messages whose conversation_id matches the scope id", async () => {
		const client = new AsyncRineClient({});
		const MATCH = "conv-xyz";
		const other = randomUUID();

		const pushed: DecryptedMessage[] = [
			makeDecrypted({ conversation_id: MATCH, metadata: { n: 1 } }),
			makeDecrypted({ conversation_id: other, metadata: { n: 2 } }),
			makeDecrypted({ conversation_id: MATCH, metadata: { n: 3 } }),
			makeDecrypted({ conversation_id: other, metadata: { n: 4 } }),
			makeDecrypted({ conversation_id: MATCH, metadata: { n: 5 } }),
		];
		vi.spyOn(client, "messages").mockReturnValue(asyncIter(pushed));

		const conv = client.conversation(MATCH);
		const seen: unknown[] = [];
		for await (const msg of conv.messages()) {
			seen.push((msg.metadata as { n: number }).n);
		}
		expect(seen).toEqual([1, 3, 5]);
	});

	it("forwards signal and type filter to client.messages()", async () => {
		const client = new AsyncRineClient({});
		const messagesSpy = vi
			.spyOn(client, "messages")
			.mockReturnValue(asyncIter([]));

		const conv = client.conversation("conv-xyz");
		const ac = new AbortController();
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for await (const _ of conv.messages({
			type: ["rine.v1.task_request", "rine.v1.task_response"],
			signal: ac.signal,
			agent: "bot@acme.rine.network",
			lastEventId: "evt-42",
		})) {
			// no-op
		}
		expect(messagesSpy).toHaveBeenCalledTimes(1);
		const opts = messagesSpy.mock.calls[0]?.[0] as MessagesOptions;
		expect(opts.type).toEqual([
			"rine.v1.task_request",
			"rine.v1.task_response",
		]);
		expect(opts.signal).toBe(ac.signal);
		expect(opts.agent).toBe("bot@acme.rine.network");
		expect(opts.lastEventId).toBe("evt-42");
	});

	it("does NOT set MessagesOptions.includeReserved — scope filter is conv-id-only", async () => {
		const client = new AsyncRineClient({});
		const messagesSpy = vi
			.spyOn(client, "messages")
			.mockReturnValue(asyncIter([]));

		const conv = client.conversation("conv-xyz");
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for await (const _ of conv.messages()) {
			/* no-op */
		}
		const opts = messagesSpy.mock.calls[0]?.[0] as MessagesOptions;
		expect(opts).not.toHaveProperty("includeReserved");
	});

	// NOTE: If the underlying stream never yields a matching conversation_id,
	// `messages()` will block until the stream ends or the signal fires.
	// The abort-signal test below pins the escape hatch callers rely on.

	it("stops mid-iteration when the abort signal fires", async () => {
		const client = new AsyncRineClient({});
		const MATCH = "conv-xyz";
		const ac = new AbortController();

		// A stream that honours the caller's abort signal the same way the
		// real `client.messages()` does — returns early when the signal
		// fires. The conversation scope trusts the for-await to exit; this
		// test pins that contract.
		async function* abortingStream(): AsyncGenerator<DecryptedMessage> {
			yield makeDecrypted({ conversation_id: MATCH, metadata: { n: 1 } });
			if (ac.signal.aborted) return;
			yield makeDecrypted({ conversation_id: MATCH, metadata: { n: 2 } });
		}
		vi.spyOn(client, "messages").mockReturnValue({
			[Symbol.asyncIterator]: () => abortingStream(),
		});

		const conv = client.conversation(MATCH);
		const seen: number[] = [];
		for await (const msg of conv.messages({ signal: ac.signal })) {
			seen.push((msg.metadata as { n: number }).n);
			ac.abort();
		}
		expect(seen).toEqual([1]);
	});
});

// ---------------------------------------------------------------------------
// history()
// ---------------------------------------------------------------------------

describe("ConversationScope.history", () => {
	it("walks inbox pages and drops non-matching items", async () => {
		const client = new AsyncRineClient({});
		const MATCH = "conv-xyz";
		const other = randomUUID();

		const page1 = makePage(
			[
				makeDecrypted({ conversation_id: MATCH, metadata: { n: 1 } }),
				makeDecrypted({ conversation_id: other, metadata: { n: 2 } }),
			],
			"cursor-2",
		);
		const page2 = makePage(
			[
				makeDecrypted({ conversation_id: other, metadata: { n: 3 } }),
				makeDecrypted({ conversation_id: MATCH, metadata: { n: 4 } }),
			],
			null,
		);

		const inboxSpy = vi
			.spyOn(client, "inbox")
			.mockResolvedValueOnce(page1)
			.mockResolvedValueOnce(page2);

		const conv = client.conversation(MATCH);
		const seen: number[] = [];
		for await (const msg of conv.history({ limit: 2 })) {
			seen.push((msg.metadata as { n: number }).n);
		}
		expect(seen).toEqual([1, 4]);
		expect(inboxSpy).toHaveBeenCalledTimes(2);
		const firstCall = inboxSpy.mock.calls[0]?.[0] as InboxOptions;
		const secondCall = inboxSpy.mock.calls[1]?.[0] as InboxOptions;
		expect(firstCall.limit).toBe(2);
		expect(firstCall.cursor).toBeUndefined();
		expect(secondCall.cursor).toBe("cursor-2");
	});

	it("stops walking when hasNext is false (and uses default limit=50)", async () => {
		const client = new AsyncRineClient({});
		const MATCH = "conv-xyz";
		const page = makePage(
			[makeDecrypted({ conversation_id: MATCH, metadata: { n: 1 } })],
			null,
		);
		const inboxSpy = vi.spyOn(client, "inbox").mockResolvedValue(page);

		const conv = client.conversation(MATCH);
		const seen: number[] = [];
		for await (const msg of conv.history()) {
			seen.push((msg.metadata as { n: number }).n);
		}
		expect(seen).toEqual([1]);
		expect(inboxSpy).toHaveBeenCalledTimes(1);
		// Default limit per conversation.ts — test 14 covers explicit override.
		expect((inboxSpy.mock.calls[0]?.[0] as InboxOptions).limit).toBe(50);
	});

	it("does not stop when an intermediate page yields zero matching items", async () => {
		const client = new AsyncRineClient({});
		const MATCH = "conv-xyz";
		const other = randomUUID();

		// Page 1 is entirely non-matching; page 2 carries the real hit. The
		// generator must keep walking instead of bailing on the empty page.
		const page1 = makePage(
			[
				makeDecrypted({ conversation_id: other, metadata: { n: 1 } }),
				makeDecrypted({ conversation_id: other, metadata: { n: 2 } }),
			],
			"cursor-2",
		);
		const page2 = makePage(
			[makeDecrypted({ conversation_id: MATCH, metadata: { n: 3 } })],
			null,
		);

		vi.spyOn(client, "inbox")
			.mockResolvedValueOnce(page1)
			.mockResolvedValueOnce(page2);

		const conv = client.conversation(MATCH);
		const seen: number[] = [];
		for await (const msg of conv.history()) {
			seen.push((msg.metadata as { n: number }).n);
		}
		expect(seen).toEqual([3]);
	});

	it("honours maxItems and stops mid-page", async () => {
		const client = new AsyncRineClient({});
		const MATCH = "conv-xyz";
		const page = makePage(
			[
				makeDecrypted({ conversation_id: MATCH, metadata: { n: 1 } }),
				makeDecrypted({ conversation_id: MATCH, metadata: { n: 2 } }),
				makeDecrypted({ conversation_id: MATCH, metadata: { n: 3 } }),
			],
			"cursor-2",
		);
		const inboxSpy = vi.spyOn(client, "inbox").mockResolvedValue(page);

		const conv = client.conversation(MATCH);
		const seen: number[] = [];
		for await (const msg of conv.history({ maxItems: 2 })) {
			seen.push((msg.metadata as { n: number }).n);
		}
		expect(seen).toEqual([1, 2]);
		// Once maxItems is reached we stop; the generator must not
		// request the next page even though hasNext is true.
		expect(inboxSpy).toHaveBeenCalledTimes(1);
	});

	it("forwards cursor / agent / signal to client.inbox()", async () => {
		const client = new AsyncRineClient({});
		const MATCH = "conv-xyz";
		const inboxSpy = vi
			.spyOn(client, "inbox")
			.mockResolvedValue(makePage([], null));

		const conv = client.conversation(MATCH);
		const ac = new AbortController();
		for await (const _ of conv.history({
			limit: 100,
			cursor: "resume-here",
			agent: "bot@acme.rine.network",
			signal: ac.signal,
		})) {
			// no-op
		}
		const opts = inboxSpy.mock.calls[0]?.[0] as InboxOptions;
		expect(opts.limit).toBe(100);
		expect(opts.cursor).toBe("resume-here");
		expect(opts.agent).toBe("bot@acme.rine.network");
		expect(opts.signal).toBe(ac.signal);
	});

	it("propagates inbox errors to the iterator consumer", async () => {
		const client = new AsyncRineClient({});
		vi.spyOn(client, "inbox").mockRejectedValue(new Error("boom"));

		const conv = client.conversation("conv-xyz");
		const walk = async () => {
			for await (const _ of conv.history()) {
				/* no-op */
			}
		};
		await expect(walk()).rejects.toThrow("boom");
	});
});

// ---------------------------------------------------------------------------
// defineAgent integration — ctx.conversation pre-bind
// ---------------------------------------------------------------------------

describe("defineAgent ctx.conversation", () => {
	it("exposes a ConversationScope pre-bound to the incoming message's conversation_id", async () => {
		const { defineAgent } = await import("../agent.js");
		const client = new AsyncRineClient({});

		const CONV = randomUUID();
		const msg = makeDecrypted({ conversation_id: CONV });

		vi.spyOn(client, "messages").mockReturnValue(asyncIter([msg]));

		// Await a promise the handler resolves on first dispatch — no
		// `setTimeout`, no flakiness. `stop()` aborts the internal
		// controller before the loop microtask runs, so we must let
		// dispatch settle BEFORE calling stop. The resolved promise is
		// that ordering signal.
		let capturedConv: ConversationScope | null = null;
		let resolveHandled!: () => void;
		const handled = new Promise<void>((resolve) => {
			resolveHandled = resolve;
		});

		const agent = defineAgent({
			client,
			autoStart: false,
			onMessage: (_m, ctx) => {
				capturedConv = ctx.conversation;
				resolveHandled();
			},
		});

		await agent.start();
		await handled;
		await agent.stop();

		expect(capturedConv).toBeInstanceOf(ConversationScope);
		expect((capturedConv as unknown as ConversationScope).id).toBe(CONV);
	});
});

// ---------------------------------------------------------------------------
// ConversationScope peer from message
// ---------------------------------------------------------------------------

describe("client.conversation(msg) — peer + anchor binding", () => {
	it("received msg: peer is sender (the other party)", () => {
		// No pinned agent — legacy sender-prefer fallback
		const client = new AsyncRineClient({});
		const msg = makeDecrypted({
			conversation_id: "conv-1",
			sender_handle: "alice@acme.rine.network",
		});
		const scope = client.conversation(msg);
		expect(scope.peer).toBe("alice@acme.rine.network");
		expect(scope.id).toBe("conv-1");
		expect(scope.anchorMessageId).toBe(msg.id);
	});

	it("sent msg with pinned agent: peer is recipient (the other party)", () => {
		const client = new AsyncRineClient({ agent: "alice@acme.rine.network" });
		const msg = makeDecrypted({
			conversation_id: "conv-1b",
			sender_handle: "alice@acme.rine.network",
			recipient_handle: "bob@acme.rine.network",
		});
		const scope = client.conversation(msg);
		// I sent this — peer should be the recipient, not me.
		expect(scope.peer).toBe("bob@acme.rine.network");
	});

	it("received msg with pinned agent: peer is sender", () => {
		const client = new AsyncRineClient({ agent: "alice@acme.rine.network" });
		const msg = makeDecrypted({
			conversation_id: "conv-1c",
			sender_handle: "bob@acme.rine.network",
			recipient_handle: "alice@acme.rine.network",
		});
		const scope = client.conversation(msg);
		expect(scope.peer).toBe("bob@acme.rine.network");
	});

	it("falls back to from_agent_id when sender_handle is absent", () => {
		const client = new AsyncRineClient({});
		const FROM = "11111111-1111-4111-8111-111111111111";
		const msg = makeDecrypted({
			conversation_id: "conv-2",
			from_agent_id: FROM as unknown as AgentUuid,
			sender_handle: null,
		});
		const scope = client.conversation(msg);
		expect(scope.peer).toBe(FROM);
	});

	it("sent msg falls back to to_agent_id when recipient_handle is absent", () => {
		const client = new AsyncRineClient({ agent: "alice@acme.rine.network" });
		const TO = "22222222-2222-4222-8222-222222222222";
		const msg = makeDecrypted({
			conversation_id: "conv-2b",
			sender_handle: "alice@acme.rine.network",
			recipient_handle: null,
			to_agent_id: TO as unknown as AgentUuid,
		});
		const scope = client.conversation(msg);
		expect(scope.peer).toBe(TO);
	});

	it("derives the group peer from group_handle when group_id is set", () => {
		const client = new AsyncRineClient({});
		const msg = makeDecrypted({
			conversation_id: "conv-3",
			group_id: "33333333-3333-4333-8333-333333333333",
			group_handle: "#devs@acme.rine.network",
			sender_handle: "alice@acme.rine.network",
		});
		const scope = client.conversation(msg);
		expect(scope.peer).toBe("#devs@acme.rine.network");
	});

	it("scope.send(payload) delegates to client.reply(anchorMsgId)", async () => {
		const client = new AsyncRineClient({});
		const replySpy = vi
			.spyOn(client, "reply")
			.mockResolvedValue({ id: "m-new" } as never);

		const msg = makeDecrypted({
			conversation_id: "conv-4",
			sender_handle: "alice@acme.rine.network",
		});
		const scope = client.conversation(msg);
		await scope.send({ text: "reply" });

		expect(replySpy).toHaveBeenCalledTimes(1);
		const [msgId, payload] = replySpy.mock.calls[0] as unknown as [string, unknown];
		expect(msgId).toBe(msg.id);
		expect(payload).toEqual({ text: "reply" });
	});

	it("id-only scope throws on send (cannot thread)", async () => {
		const client = new AsyncRineClient({});
		const scope = client.conversation("conv-6");
		expect(scope.peer).toBeNull();
		expect(scope.anchorMessageId).toBeNull();
		await expect(scope.send({ text: "no anchor" })).rejects.toThrow(
			/bare conversation id/,
		);
	});

	it("group message with missing group_handle leaves peer null", () => {
		const client = new AsyncRineClient({});
		const msg = makeDecrypted({
			conversation_id: "conv-8",
			group_id: "33333333-3333-4333-8333-333333333333",
			group_handle: null,
		});
		const scope = client.conversation(msg);
		expect(scope.peer).toBeNull();
	});
});
