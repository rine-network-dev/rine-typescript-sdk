/**
 * `ConversationScope`.
 *
 * A lightweight builder returned by `client.conversation(convId)` that
 * auto-scopes `send`, `reply`, `messages`, and `history` to a single
 * `conversation_id`. No `metadata()` / `status()` / `participants()`
 * methods are currently exposed on the scope.
 *
 * Design notes:
 *
 * - `send()` routes through `client.reply(anchorMessageId, …)` when the
 *   scope was built from a message (the common case). The server's reply
 *   endpoint threads the new message into the original conversation.
 *   Scopes built from bare conversation id strings throw on `send()` —
 *   the old `parentConversationId` path only created sub-conversations.
 *
 * - `reply()` delegates straight through; the server infers the
 *   conversation from the parent message id. The scoped method exists
 *   for ergonomic symmetry (so agents inside the scope don't have to
 *   reach for `ctx.client.reply`).
 *
 * - `messages()` post-filters the agent-wide SSE stream by
 *   `conversation_id` — the server's stream endpoint is per-agent in
 *   v0.1, not per-conversation. When a server-side
 *   `GET /conversations/{id}/stream` ships, this method can switch
 *   transports without changing its public signature.
 *
 * - `history()` walks `client.inbox({ cursor, limit })` pages and drops
 *   items whose `conversation_id` does not match. Also a v0.1 trade
 *   — same migration story as `messages()`.
 *
 * Typed generics (`send<T>`, `messages<T>({ schema })`, etc.) thread a
 * `<T = unknown>` generic and a `schema?: StandardSchemaV1<unknown, T>`
 * slot so one schema written once narrows an entire conversation's
 * payload type end-to-end.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
	AsyncRineClient,
	InboxOptions,
	MessagesOptions,
	ReplyOptions,
} from "../client.js";
import {
	type AgentHandle,
	type AgentUuid,
	type DecryptedMessage,
	type GroupHandle,
	type GroupUuid,
	type MessageRead,
	type MessageUuid,
	type ThreadEntry,
	isAgentHandle,
	isGroupHandle,
} from "../types.js";
import { parseMessagePlaintext } from "../utils/schema.js";

import { UUID_RE } from "../types.js";

function looksLikeRecipient(value: unknown): value is string {
	if (typeof value !== "string") return false;
	return UUID_RE.test(value) || isAgentHandle(value) || isGroupHandle(value);
}

type Recipient = AgentHandle | AgentUuid | GroupHandle | GroupUuid;

/** Options accepted by `ConversationScope.send` — maps to `ReplyOptions<T>`
 * when the scope is message-anchored (the common case). */
export type ConversationSendOptions<T = unknown> = ReplyOptions<T>;

/** Options accepted by `ConversationScope.reply` — identical to `ReplyOptions<T>`. */
export type ConversationReplyOptions<T = unknown> = ReplyOptions<T>;

/** Options accepted by `ConversationScope.messages` — `MessagesOptions<T>`
 * minus the `includeReserved` debug escape hatch, which is meaningless
 * inside a scope that already drops everything except the pinned
 * conversation. Using `Omit` keeps this type aligned with
 * `MessagesOptions` for free as new fields land there. */
export type ConversationMessagesOptions<T = unknown> = Omit<
	MessagesOptions<T>,
	"includeReserved"
>;

export interface ConversationHistoryOptions<T = unknown> {
	/** Page size forwarded to `client.inbox()`. Default: 50. */
	limit?: number;
	/** Starting cursor. Defaults to the first page. */
	cursor?: string;
	/** Hard cap on items yielded across all pages. Unbounded by default. */
	maxItems?: number;
	/** Agent override forwarded to `client.inbox()`. */
	agent?: string;
	signal?: AbortSignal;
	/**
	 * Standard Schema v1 — narrows `plaintext` on every yielded message.
	 * A decrypt-failed envelope (with `decrypt_error`) is yielded untouched
	 * so callers can still observe the failure; a successful decrypt that
	 * fails schema validation throws `ValidationError` out of the generator.
	 */
	schema?: StandardSchemaV1<unknown, T>;
}

export class ConversationScope {
	/**
	 * Peer auto-wired when the scope was built via `client.conversation(msg)`.
	 * When set, the two-arg `scope.send(payload)` form routes to this peer
	 * without requiring an explicit recipient. Null when the scope was
	 * built from a bare conversation id.
	 */
	public readonly peer: Recipient | null;

	/**
	 * Anchor message id — set when the scope was built via
	 * `client.conversation(msg)`. When present, `scope.send()` routes
	 * through `client.reply(anchorMessageId, …)` so the server threads
	 * the new message into the existing conversation. Null when the
	 * scope was built from a bare conversation id string.
	 */
	public readonly anchorMessageId: MessageUuid | null;

	constructor(
		private readonly client: AsyncRineClient,
		public readonly id: string,
		peer: Recipient | null = null,
		anchorMessageId: MessageUuid | null = null,
	) {
		this.peer = peer;
		this.anchorMessageId = anchorMessageId;
	}

	/**
	 * Send a message in this conversation.
	 *
	 *   scope.send(to, payload)            // explicit recipient
	 *   scope.send(payload)                // uses the peer derived from the
	 *                                      // originating message
	 *
	 * When the scope was built via `client.conversation(msg)` (i.e. it has
	 * an `anchorMessageId`), sends route through `client.reply()` so the
	 * server threads the new message into the existing conversation. A scope
	 * built from a bare conversation id string throws — `parentConversationId`
	 * on `POST /messages` only creates sub-conversations, not threads.
	 */
	send<T = unknown>(
		to: Recipient,
		payload: T,
		opts?: ConversationSendOptions<T>,
	): Promise<MessageRead>;
	send<T = unknown>(
		payload: T,
		opts?: ConversationSendOptions<T>,
	): Promise<MessageRead>;
	send<T = unknown>(
		a: Recipient | T,
		b?: T | ConversationSendOptions<T>,
		c?: ConversationSendOptions<T>,
	): Promise<MessageRead> {
		let payload: T;
		let opts: ConversationSendOptions<T>;
		if (looksLikeRecipient(a)) {
			// Three-arg form: send(to, payload, opts)
			const to = a as Recipient;
			payload = b as T;
			opts = c ?? {};
			if (this.anchorMessageId != null) {
				// Validate that explicit `to` matches the pre-bound peer to
				// prevent cross-routing from a scoped conversation.
				if (this.peer != null && to !== this.peer) {
					return Promise.reject(
						new Error(
							`ConversationScope.send(): explicit recipient "${to}" does not match scope peer "${this.peer}". The reply endpoint auto-routes to the original peer; use client.send() directly for cross-conversation sends.`,
						),
					);
				}
				return this.client.reply<T>(this.anchorMessageId, payload, opts);
			}
			return Promise.reject(
				new Error(
					"ConversationScope was built from a bare conversation id and cannot thread sends. Use client.conversation(message) to pin a message anchor, or call client.send() / client.reply() directly.",
				),
			);
		}

		// Two-arg form: send(payload, opts) — requires peer + anchor
		payload = a as T;
		opts = (b as ConversationSendOptions<T>) ?? {};
		if (this.anchorMessageId == null || this.peer == null) {
			return Promise.reject(
				new Error(
					"ConversationScope was built from a bare conversation id and cannot thread sends. Use client.conversation(message) to pin a message anchor, or call client.send() / client.reply() directly.",
				),
			);
		}
		return this.client.reply<T>(this.anchorMessageId, payload, opts);
	}

	reply<T = unknown>(
		messageId: MessageUuid,
		payload: T,
		opts: ConversationReplyOptions<T> = {},
	): Promise<MessageRead> {
		// The server derives the conversation from the parent message id;
		// no body mutation needed. Method exists so agents inside the
		// scoped surface have a symmetric reply path.
		return this.client.reply<T>(messageId, payload, opts);
	}

	messages<T = unknown>(
		opts: ConversationMessagesOptions<T> = {},
	): AsyncIterable<DecryptedMessage<T>> {
		return this.messagesGenerator(opts);
	}

	history<T = unknown>(
		opts: ConversationHistoryOptions<T> = {},
	): AsyncIterable<DecryptedMessage<T>> {
		return this.historyGenerator(opts);
	}

	/**
	 * Fetch the both-sided, role-tagged transcript of this conversation
	 * (REQ-SDK-TS-02) via `GET /conversations/{id}/messages`.
	 *
	 * Unlike `history()` (a received-only inbox page-walk), `thread()` returns
	 * the agent's SENT turns too — each decrypted with the caller's own keys
	 * (the self-sealed copy for sent rows, the recipient copy for received
	 * rows, the group cache for group rows). Returns a single bounded fetch
	 * (`limit`, default server-side 50) ordered oldest→newest. A row the caller
	 * cannot decrypt (a legacy sent message with no self-blob, or a decrypt
	 * failure) renders `text: "[unavailable]"` — `thread()` never throws on a
	 * single bad row.
	 */
	thread(
		opts: { agent?: string; limit?: number; signal?: AbortSignal } = {},
	): Promise<ThreadEntry[]> {
		return this.client.thread(this.id, opts);
	}

	private async *messagesGenerator<T>(
		opts: ConversationMessagesOptions<T>,
	): AsyncGenerator<DecryptedMessage<T>> {
		const streamOpts: MessagesOptions<T> = {};
		if (opts.type !== undefined) streamOpts.type = opts.type;
		if (opts.signal !== undefined) streamOpts.signal = opts.signal;
		if (opts.agent !== undefined) streamOpts.agent = opts.agent;
		if (opts.lastEventId !== undefined)
			streamOpts.lastEventId = opts.lastEventId;
		if (opts.schema !== undefined) streamOpts.schema = opts.schema;

		for await (const msg of this.client.messages<T>(streamOpts)) {
			if (msg.conversation_id === this.id) yield msg;
		}
	}

	// Manual page walk because we need per-item `conversation_id` filtering
	// and an optional `maxItems` hard cap.
	private async *historyGenerator<T>(
		opts: ConversationHistoryOptions<T>,
	): AsyncGenerator<DecryptedMessage<T>> {
		const limit = opts.limit ?? 50;
		const maxItems = opts.maxItems;
		const schema = opts.schema;
		let cursor: string | undefined = opts.cursor;
		let yielded = 0;

		while (true) {
			const inboxOpts: InboxOptions = { limit };
			if (cursor !== undefined) inboxOpts.cursor = cursor;
			if (opts.agent !== undefined) inboxOpts.agent = opts.agent;
			if (opts.signal !== undefined) inboxOpts.signal = opts.signal;

			const page = await this.client.inbox(inboxOpts);

			for (const msg of page.items) {
				if (msg.conversation_id !== this.id) continue;
				// Schema narrows plaintext after decrypt. A
				// decrypt-failed envelope is yielded untouched so callers
				// can branch on `decrypt_error`; a successful decrypt that
				// fails validation throws `ValidationError` from the
				// generator (same semantics as `read<T>` / `messages<T>`).
				const typed =
					schema !== undefined && msg.decrypt_error == null
						? await parseMessagePlaintext(msg, schema)
						: (msg as DecryptedMessage<T>);
				yield typed;
				yielded += 1;
				if (maxItems !== undefined && yielded >= maxItems) return;
			}

			if (!page.hasNext || page.nextCursor == null) return;
			cursor = page.nextCursor;
		}
	}
}
