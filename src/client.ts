/**
 * AsyncRineClient — full async API surface for Rine E2E-encrypted messaging.
 */

import {
	type ResolvedActor,
	ACTING_AGENT_HEADER,
	THREAD_REF_SURFACES,
	resolveThreadRef,
} from "@rine-network/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { actingAgentHeader } from "./api/acting-agent.js";
import { parse } from "./api/adapters.js";
import { SDKHttpClient } from "./api/http.js";
import type { RineMiddleware } from "./api/middleware.js";
import { ConversationScope } from "./resources/conversation.js";
import {
	type ParsedDecryptedMessage,
	decryptEnvelope,
} from "./resources/decrypt.js";
import {
	type DiscoverGroupsOptions,
	type DiscoveryFilters,
	DiscoveryResource,
} from "./resources/discovery.js";
import {
	type AgentHandleMap,
	AgentHandleCache,
} from "./resources/agent-handles.js";
import { GroupsResource } from "./resources/groups.js";
import {
	type AddPostQuantumKeyOptions,
	type AgentCardInput,
	type CreateAgentOptions,
	type EraseOrgOptions,
	IdentityResource,
	type UpdateAgentPatch,
	type UpdateOrgPatch,
	type VerifyIdentityOptions,
} from "./resources/identity.js";
import { MessagesResource } from "./resources/messages.js";
import { PaymentsResource } from "./resources/payments.js";
import { PollingResource } from "./resources/polling.js";
import { type StreamOptions, StreamsResource } from "./resources/streams.js";
import {
	type FetchThreadOptions,
	fetchThread,
	transcriptPath,
} from "./resources/thread.js";
import { WebhooksResource } from "./resources/webhooks.js";
import {
	type AgentHandle,
	type AgentUuid,
	type DecryptedMessage,
	DecryptedMessageSchema,
	type GroupHandle,
	type GroupUuid,
	type MessageRead,
	type MessageTypeString,
	type MessageUuid,
	RESERVED_MESSAGE_TYPES,
	type RineEvent,
	type SendAndWaitResult,
	type ThreadEntry,
} from "./types.js";
import { parseMessagePlaintext, validateOutbound } from "./utils/schema.js";
import { SeenIds } from "./utils/seen-ids.js";
import { sleepWithSignal } from "./utils/sleep.js";

export type { StreamOptions };

// `RESERVED_MESSAGE_TYPES` is imported from `./types.js` — single-source
// definition used by `messages()`, `defineAgent`, and public re-exports.
// Reserved types are filtered from `client.messages()` unconditionally
// unless `includeReserved: true` is passed. The only entry —
// `rine.v1.sender_key_distribution` — carries group key material, and
// nothing ingests it off the stream: dropping the frame costs no key
// material because `decryptEnvelope({ retrySenderKey: true })` fetches
// pending distributions straight from the server when a group envelope
// fails to open.

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RineClientOptions {
	configDir?: string;
	apiUrl?: string;
	/** Agent handle or UUID, sent as `X-Rine-Agent` verbatim (no bare names). */
	agent?: string;
	/** Request timeout in ms. Default: 30_000. */
	timeout?: number;
	/** Max retries on 429. Default: 2. */
	maxRetries?: number;
	/** Global AbortSignal for all requests. */
	signal?: AbortSignal;
	/**
	 * User middleware chain. Composed once at construction and wrapped
	 * around every SDK HTTP call. The first element is the outermost
	 * layer — `[logging, retry]` logs before retrying.
	 *
	 * Scope boundary: middleware does NOT wrap SSE streams (`client.stream`,
	 * `client.messages`) or crypto-path HTTP calls.
	 */
	middleware?: readonly RineMiddleware[];
}

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

export interface SendOptions<T = unknown> {
	type?: MessageTypeString;
	contentType?: string;
	metadata?: Record<string, unknown>;
	parentConversationId?: string;
	conversationMetadata?: Record<string, unknown>;
	idempotencyKey?: string;
	agent?: string;
	signal?: AbortSignal;
	/**
	 * Standard Schema v1 — validates the outbound payload *before* encrypt.
	 * A schema failure throws `ValidationError` and no message is sent
	 * (validated before encrypt). Zero-runtime-cost type-only integration.
	 */
	schema?: StandardSchemaV1<unknown, T>;
}

export interface SendAndWaitOptions<Req = unknown, Rep = unknown> {
	type?: MessageTypeString;
	contentType?: string;
	metadata?: Record<string, unknown>;
	timeout?: number;
	idempotencyKey?: string;
	agent?: string;
	signal?: AbortSignal;
	/** Validates the outbound request payload before encrypt. */
	schema?: StandardSchemaV1<unknown, Req>;
	/** Narrows the decrypted reply plaintext on the return value. */
	replySchema?: StandardSchemaV1<unknown, Rep>;
}

export interface InboxOptions {
	limit?: number;
	cursor?: string;
	agent?: string;
	signal?: AbortSignal;
	/**
	 * Filter by delivery status. `"new"` returns undelivered mail, `"delivered"`
	 * delivered-but-unread, `"read"` already-read. When omitted, the server
	 * default applies (no `status` query param is sent — back-compat).
	 */
	status?: "new" | "delivered" | "read";
}

export interface MarkDeliveredOptions {
	agent?: string;
	signal?: AbortSignal;
}

/** What {@link RineClient.thread} takes besides the conversation id. */
export interface ThreadOptions {
	/**
	 * The group to read, as a handle (`#name@org`), a bare name, or a UUID.
	 * Name this or the conversation id, never both.
	 */
	group?: string;
	/** The agent to read as — its own keys open its own rows. */
	agent?: string;
	/** Max turns, most-recent window. The server applies its own default. */
	limit?: number;
	signal?: AbortSignal;
}

export interface ReadOptions<T = unknown> {
	agent?: string;
	signal?: AbortSignal;
	/**
	 * Read without consuming the message — it stays new, and stays offered by
	 * `inbox({ status: "new" })`, {@link AsyncRineClient.poll} and SSE catch-up.
	 *
	 * A plain read marks the message delivered **whether or not it decrypts**:
	 * the server holds no key and stamps the mark before the client has tried,
	 * and there is no un-mark route — so a row this agent cannot open yet is
	 * offered exactly once and then only fetchable by id. This is what an
	 * unattended loop wants for that row. The acting agent is still named and
	 * still refused if it names nobody: only the mark is suppressed.
	 *
	 * Riding on `X-Rine-Peek`, honoured by the server from the release this
	 * option ships with. An older deployment ignores the header and consumes
	 * the row as it always did.
	 */
	peek?: boolean;
	/**
	 * Standard Schema v1 — JSON-parses `plaintext` and validates it after
	 * decrypt. On success the returned `DecryptedMessage<T>.plaintext` is
	 * typed as `T | null`. On failure throws `ValidationError` (the
	 * cryptography succeeded; the payload shape did not).
	 */
	schema?: StandardSchemaV1<unknown, T>;
}

export interface ReplyOptions<T = unknown> {
	type?: MessageTypeString;
	contentType?: string;
	metadata?: Record<string, unknown>;
	idempotencyKey?: string;
	agent?: string;
	signal?: AbortSignal;
	/** Validates the outbound reply payload before encrypt. */
	schema?: StandardSchemaV1<unknown, T>;
}

export interface WatchOptions {
	signal?: AbortSignal;
	pollInterval?: number;
	onError?: (err: unknown) => void;
}

/**
 * Options for `client.messages()`.
 */
export interface MessagesOptions<T = unknown> {
	/**
	 * Pre-decrypt filter on the cleartext `type` field. Exact-match only;
	 * no glob or prefix support in v0.1. Accepts a single string or an array.
	 */
	type?: MessageTypeString | readonly MessageTypeString[];
	/** External AbortSignal for cancellation. */
	signal?: AbortSignal;
	/** Agent to receive on. Defaults to the client's configured agent. */
	agent?: string;
	/** Resume token — forwarded to the underlying SSE stream. */
	lastEventId?: string;
	/**
	 * Debug escape hatch — when true, reserved message types
	 * (`rine.v1.sender_key_distribution` in v0.1) are yielded instead of
	 * filtered. Unsupported; behavior may change between minor versions.
	 * Emits a one-shot `console.warn` on first use per process.
	 */
	includeReserved?: boolean;
	/**
	 * Standard Schema v1 — runs after decrypt, before each message is
	 * yielded. On success the iterator yields `DecryptedMessage<T>` with
	 * typed `plaintext`. A validation failure throws `ValidationError` out
	 * of the generator and iteration ends — same semantics as `read<T>()`.
	 * Inside `defineAgent<T>({ schema })` the failure is caught and routed
	 * to `onError({ stage: 'schema' })`; the loop keeps running.
	 */
	schema?: StandardSchemaV1<unknown, T>;
}

let __includeReservedWarned = false;

// ---------------------------------------------------------------------------
// AsyncRineClient
// ---------------------------------------------------------------------------

/**
 * Async client for the Rine E2E-encrypted messaging API.
 *
 * All messages are encrypted client-side (HPKE for 1:1, Sender Keys for
 * groups) before leaving the process. Construct via `new AsyncRineClient()`
 * or `defineAgent()` for the handler-based pattern.
 */
export class AsyncRineClient implements AsyncDisposable {
	private readonly http: SDKHttpClient;
	private readonly _signal?: AbortSignal;

	// Sub-resources. The `messages` slot is reserved for the public iterator
	// method on the public surface; the underlying resource is stashed
	// privately so `send` / `inbox` / `read` / `reply` / `sendAndWait` can
	// delegate without shadowing the iterator method name.
	private readonly messagingResource: MessagesResource;
	readonly streams: StreamsResource;
	readonly polling: PollingResource;
	readonly groups: GroupsResource;
	readonly webhooks: WebhooksResource;
	readonly discovery: DiscoveryResource;
	readonly identity: IdentityResource;
	/** x402 payment helpers — payer (pay a quote) + payee (quote/verify/settle/receipt). */
	readonly payments: PaymentsResource;

	// Not `readonly`: `withOptions` hands its own cache to the client it derives,
	// which is the whole reason one exists (see `agentHandles`).
	private handleCache: AgentHandleCache;

	constructor(opts: RineClientOptions = {}) {
		this.http = new SDKHttpClient({
			configDir: opts.configDir,
			apiUrl: opts.apiUrl,
			agent: opts.agent,
			timeout: opts.timeout,
			maxRetries: opts.maxRetries,
			middleware: opts.middleware,
		});
		this._signal = opts.signal;

		// Initialise sub-resources
		this.messagingResource = new MessagesResource(this.http);
		this.streams = new StreamsResource(this.http);
		this.polling = new PollingResource(this.http);
		this.groups = new GroupsResource(this.http, this.messagingResource);
		this.webhooks = new WebhooksResource(this.http);
		this.discovery = new DiscoveryResource(this.http);
		this.identity = new IdentityResource(this.http);
		this.payments = new PaymentsResource(
			this,
			this.http,
			this.messagingResource,
		);
		this.handleCache = new AgentHandleCache(() => this.identity.listAgents());
	}

	/**
	 * This org's agent ids resolved to handles, fetched at most once per client
	 * lifetime and never throwing.
	 *
	 * The rule every caller renders by — handle, else the id, else the surface's
	 * own "none seated" sentence — is stated once, on {@link AgentHandleMap} in
	 * `resources/agent-handles.ts`. Read it there before adding a fourth case.
	 *
	 * It exists for `member_agent_ids`: a group row reports which of *your*
	 * agents are seated as UUIDs, and a UUID is not something an operator or a
	 * model can act on. Resolution is client-side, against the org's own agent
	 * list, so it depends on no field the deployed server does not already send.
	 */
	agentHandles(): Promise<AgentHandleMap> {
		return this.handleCache.get();
	}

	// -------------------------------------------------------------------------
	// Messaging
	// -------------------------------------------------------------------------

	/**
	 * Which of the org's agents a call would act as, and anything the resolver
	 * has to say about the value it was given.
	 *
	 * The one **public, per-call** way to obtain that note. It is not a property
	 * of the client on purpose: one `AsyncRineClient` serves a whole process of
	 * concurrent inbound work, and a `lastActorWarning` attribute written while
	 * resolving one call is read by whichever call finished next — the warning
	 * then names the wrong send, or is overwritten and lost. A value object
	 * cannot be misattributed.
	 *
	 * A host that renders the note itself resolves once, here, and passes the
	 * resolved UUID down as `opts.agent`; the inner path short-circuits a UUID
	 * with no lookup, so nothing is resolved twice and no second note is minted.
	 * A host that does not call this still gets the note on the operator log.
	 *
	 * @param agent - Name, handle or UUID; omitted falls back to the client's
	 *   own default agent, then to the org's only agent.
	 * @returns The resolved agent id, and a `warning` when a one-agent org acted
	 *   on a value that named nobody.
	 */
	async resolveActor(agent?: string): Promise<ResolvedActor> {
		return this.messagingResource.resolveSenderActor(
			this.http.getCoreHttpClient({ signal: this._signal }),
			agent,
		);
	}

	/**
	 * Send an E2E-encrypted message to an agent or group.
	 *
	 * @param to - Recipient handle (`name@org`), group handle
	 *   (`#logistics@acme.rine.network`), or UUID.
	 * @param payload - Message payload (encrypted before sending).
	 * @param opts - Optional type, metadata, schema validation, signal.
	 * @returns The server-acknowledged message envelope.
	 * @throws {SchemaValidationError} If `opts.schema` is set and payload fails validation.
	 *
	 * @example
	 * ```ts
	 * const msg = await client.send("bot@acme", { task: "summarize" });
	 * ```
	 */
	async send<T = unknown>(
		to: AgentHandle | AgentUuid | GroupHandle | GroupUuid,
		payload: T,
		opts?: SendOptions<T>,
	): Promise<MessageRead> {
		if (typeof to !== "string") {
			throw new Error(
				`client.send() expects (to, payload, opts); first arg must be a recipient handle or UUID, got ${typeof to}. Did you pass the payload first?`,
			);
		}
		// Outbound schema validates *before* encrypt. Running
		// validation here (client-layer) rather than inside the resource
		// keeps the schema slot observable at the public API boundary and
		// lets the resource stay schema-free.
		const validated =
			opts?.schema !== undefined
				? await validateOutbound(payload, opts.schema)
				: payload;
		const { schema: _schema, ...rest } = opts ?? {};
		return this.messagingResource.send(to, validated, {
			signal: this._signal,
			...rest,
		});
	}

	async sendAndWait<Req = unknown, Rep = unknown>(
		to: AgentHandle | AgentUuid | GroupHandle | GroupUuid,
		payload: Req,
		opts?: SendAndWaitOptions<Req, Rep>,
	): Promise<SendAndWaitResult<Rep>> {
		if (typeof to !== "string") {
			throw new Error(
				`client.sendAndWait() expects (to, payload, opts); first arg must be a recipient handle or UUID, got ${typeof to}. Did you pass the payload first?`,
			);
		}
		const validated =
			opts?.schema !== undefined
				? await validateOutbound(payload, opts.schema)
				: payload;
		const { schema: _schema, replySchema, ...rest } = opts ?? {};
		const result = await this.messagingResource.sendAndWait(to, validated, {
			signal: this._signal,
			...rest,
		});
		// `replySchema` narrows the decrypted reply. Only apply
		// it when the cryptography succeeded; a decrypt-failed envelope is
		// returned untouched so callers branch on `decrypt_error`.
		if (
			replySchema !== undefined &&
			result.reply !== null &&
			result.reply.decrypt_error == null
		) {
			const typedReply = await parseMessagePlaintext(result.reply, replySchema);
			return { sent: result.sent, reply: typedReply } as SendAndWaitResult<Rep>;
		}
		return result as SendAndWaitResult<Rep>;
	}

	/** Fetch the current agent's inbox with automatic decryption. */
	inbox(opts?: InboxOptions) {
		return this.messagingResource.inbox({ signal: this._signal, ...opts });
	}

	/**
	 * Auto-paginating async iterator over every message in the inbox.
	 *
	 * Walks `nextCursor` until exhausted and yields each `DecryptedMessage` as
	 * it arrives. Lazy — holds at most one page in memory. Replaces the
	 * removed `CursorPage.autoPaginate(fetchPage)` helper.
	 *
	 * @example
	 * ```ts
	 * for await (const msg of client.inboxAll({ limit: 100 })) {
	 *   console.log(msg.plaintext);
	 * }
	 * ```
	 */
	async *inboxAll(opts?: InboxOptions): AsyncGenerator<DecryptedMessage> {
		let cursor = opts?.cursor;
		while (true) {
			const page = await this.inbox({ ...opts, cursor });
			yield* page.items;
			if (!page.hasNext || page.nextCursor == null) return;
			cursor = page.nextCursor;
		}
	}

	/**
	 * Mark messages as delivered for an agent (idempotent).
	 *
	 * Lets a poller acknowledge messages so a subsequent
	 * `inbox({ status: "new" })` returns only newer mail. The acting agent is
	 * resolved internally (same precedence as `inbox`/`send`), so callers pass
	 * a handle/name/UUID via `opts.agent` (or omit it for the default agent),
	 * never a pre-resolved ID.
	 *
	 * @param messageIds - Message UUIDs to mark delivered.
	 * @param opts.agent - Agent to mark deliveries for. Omit to use the
	 *   client's configured/default agent.
	 * @returns The number of messages newly marked delivered.
	 */
	markDelivered(
		messageIds: MessageUuid[] | string[],
		opts?: { agent?: string },
	): Promise<number> {
		return this.messagingResource.markDelivered(messageIds, {
			signal: this._signal,
			...opts,
		});
	}

	/** Fetch and decrypt a single message by ID. */
	async read<T = unknown>(
		messageId: MessageUuid,
		opts?: ReadOptions<T>,
	): Promise<DecryptedMessage<T>> {
		const { schema, ...rest } = opts ?? {};
		const msg = await this.messagingResource.read(messageId, {
			signal: this._signal,
			...rest,
		});
		// Inbound schema runs *after* decrypt. On a decrypt-
		// failed envelope the message is returned untouched so the caller
		// can branch on `decrypt_error`.
		if (schema !== undefined && msg.decrypt_error == null) {
			return parseMessagePlaintext(msg, schema);
		}
		return msg as DecryptedMessage<T>;
	}

	/**
	 * Reply to a message, threading into the same conversation.
	 *
	 * @param messageId - UUID of the message to reply to.
	 * @param payload - Reply payload (encrypted before sending).
	 * @param opts - Optional type, metadata, schema validation, signal.
	 * @returns The server-acknowledged reply envelope.
	 *
	 * @example
	 * ```ts
	 * await client.reply(msg.id, { status: "done", result: 42 });
	 * ```
	 */
	async reply<T = unknown>(
		messageId: MessageUuid,
		payload: T,
		opts?: ReplyOptions<T>,
	): Promise<MessageRead> {
		if (typeof messageId !== "string") {
			throw new Error(
				`client.reply() expects (messageId, payload, opts); first arg must be a message UUID string, got ${typeof messageId}. Did you pass the payload first?`,
			);
		}
		const validated =
			opts?.schema !== undefined
				? await validateOutbound(payload, opts.schema)
				: payload;
		const { schema: _schema, ...rest } = opts ?? {};
		return this.messagingResource.reply(messageId, validated, {
			signal: this._signal,
			...rest,
		});
	}

	/**
	 * Decrypted message iterator — the agentic headline surface.
	 *
	 * Thin transform over `this.streams.stream()` that parses the inline
	 * `MessageRead` envelope from each `event: message` SSE frame, runs the
	 * pre-decrypt type filter and reserved-type hiding, then decrypts via
	 * the shared `decryptEnvelope()` helper.
	 *
	 * Key property: decryption is local, not a round-trip via `read()`. The
	 * server already JSON-encodes the full envelope into the SSE `data:`
	 * field, so the SDK never needs a second `GET /messages/{id}` per
	 * message.
	 *
	 * Lifetime: bound to `opts.signal`. When the signal aborts, the underlying
	 * SSE connection closes and the generator returns immediately without
	 * yielding further messages. **No error is thrown on abort** — long-lived
	 * stream iterators exit silently, matching the standard
	 * async-iterator cancellation contract. To distinguish "aborted" from
	 * "ended naturally", check `opts.signal?.aborted` after the `for await`
	 * loop exits. Without a signal, iteration continues until the caller
	 * `break`s out of the `for await` loop (triggering the generator's
	 * `return()`, which closes the underlying SSE connection).
	 *
	 * Non-message events (`heartbeat`, `status`, `disconnect`) and reserved
	 * message types are silently dropped. Crypto failures populate
	 * `decrypt_error` on the yielded message rather than throwing — same
	 * discipline as `inbox()` / `read()`.
	 *
	 * Typed payload generics (`messages<T>({ schema })`) and the Standard
	 * Schema v1 validation hook are wired end-to-end: if `schema`
	 * is supplied each decrypted message is JSON-parsed and validated before
	 * being yielded, and `msg.plaintext` narrows to `T | null`. A schema
	 * failure throws `ValidationError` out of the generator and iteration
	 * ends — the same semantics as `read<T>()`. Inside `defineAgent<T>` the
	 * failure is caught and routed to `onError({ stage: 'schema' })`.
	 *
	 * @example
	 * ```ts
	 * const ac = new AbortController();
	 * for await (const msg of client.messages({ signal: ac.signal })) {
	 *   console.log(msg.type, msg.plaintext);
	 * }
	 * ```
	 */
	messages<T = unknown>(
		opts: MessagesOptions<T> = {},
	): AsyncIterable<DecryptedMessage<T>> {
		return this.messagesGenerator(opts);
	}

	private async *messagesGenerator<T>(
		opts: MessagesOptions<T>,
	): AsyncGenerator<DecryptedMessage<T>> {
		const signal = opts.signal ?? this._signal;

		if (opts.includeReserved && !__includeReservedWarned) {
			__includeReservedWarned = true;
			console.warn(
				"rine: client.messages({ includeReserved: true }) is a debug-only " +
					"escape hatch; behavior may change between minor versions.",
			);
		}

		// Resolve the owning agent UUID once up-front. Used by decryptEnvelope
		// to load the right local keys, and passed as `agent` down to the
		// underlying SSE stream so `/agents/{id}/stream` scopes server-side.
		const core = this.http.getCoreHttpClient({ signal });
		const agentId = await this.messagingResource.resolveSenderId(
			core,
			opts.agent,
		);

		const filterTypes = normalizeTypeFilter(opts.type);

		const stream = this.streams.stream({
			signal,
			agent: agentId,
			lastEventId: opts.lastEventId,
		});

		// One-shot warn for malformed message envelopes. Protocol drift or a
		// server bug would otherwise be invisible — see `async.ts` which does
		// the same for unknown SSE event types. Scoped per-iterator, not
		// module-global, because this is a per-stream observability signal
		// not a process-wide one.
		let warnedParseFailure = false;

		for await (const ev of stream) {
			if (signal?.aborted) return;
			if (ev.type !== "message") continue;

			// `ParsedDecryptedMessage` is the looser shape that `parse<T>`'s
			// erased return type actually yields — see the JSDoc on the type
			// in `decrypt.ts` for the Zod-inference story.
			let envelope: ParsedDecryptedMessage;
			try {
				envelope = parse(DecryptedMessageSchema, JSON.parse(ev.data));
			} catch (err) {
				// The server is expected to JSON-encode a full MessageRead
				// envelope per `_format_message_frame`; a frame that doesn't
				// round-trip is either a server bug or a protocol drift.
				// Skip rather than throwing — inbox/read do the same on
				// crypto failure, and a thrown iterator kills the stream —
				// but warn once per stream so the drift is observable.
				if (!warnedParseFailure) {
					warnedParseFailure = true;
					const reason = err instanceof Error ? err.message : String(err);
					console.warn(
						`rine: client.messages() dropped malformed SSE envelope (${reason}); further drops on this stream are silent`,
					);
				}
				continue;
			}

			if (!opts.includeReserved && RESERVED_MESSAGE_TYPES.has(envelope.type)) {
				continue;
			}
			if (filterTypes && !filterTypes.has(envelope.type)) continue;

			const decrypted = await decryptEnvelope({
				core,
				configDir: this.http.configDir,
				agentId,
				msg: envelope,
				// Same recovery as `read()`. A group message can reach the stream
				// before its key material does (the sender-key distribution is a
				// separate message; MLS state arrives via Welcome/commit), so a
				// cold group row must refresh from the server and retry once
				// rather than yielding a permanent "unknown sender key id".
				retrySenderKey: true,
				memo: this.http.decryptMemo,
			});
			// Inbound schema runs post-decrypt. Decrypt-failed envelopes
			// bypass the schema check so callers can branch on
			// `decrypt_error`. A successful-decrypt / schema-fail path throws
			// `ValidationError` out of the generator and iteration ends;
			// inside `defineAgent` the failure is caught and routed to
			// `onError({ stage: 'schema' })`.
			const typed =
				opts.schema !== undefined && decrypted.decrypt_error == null
					? await parseMessagePlaintext(decrypted, opts.schema)
					: (decrypted as DecryptedMessage<T>);
			yield typed;
		}
	}

	/**
	 * Scoped conversation builder.
	 *
	 * Returns a `ConversationScope` whose `send`, `reply`, `messages`, and
	 * `history` methods auto-pin `conversation_id`. The returned object
	 * is a thin wrapper over this client — it does not cache, hold
	 * resources, or open connections eagerly, so callers can construct
	 * one per dispatch cycle without worrying about teardown.
	 *
	 * No `.metadata()` / `.status()` / `.participants()` methods are
	 * currently exposed on the scope; those would be additive if added
	 * later.
	 *
	 * @example
	 * ```ts
	 * const conv = client.conversation(msg.conversation_id);
	 * await conv.reply(msg.id, { ok: true });
	 * for await (const next of conv.messages()) { ... }
	 * ```
	 */
	conversation(convId: string): ConversationScope;
	conversation(msg: DecryptedMessage): ConversationScope;
	conversation(convIdOrMsg: string | DecryptedMessage): ConversationScope {
		if (typeof convIdOrMsg === "string") {
			return new ConversationScope(this, convIdOrMsg);
		}
		const msg = convIdOrMsg;
		const selfHandle = this.http.agentHeader?.[ACTING_AGENT_HEADER];
		const peer = derivePeerFromMessage(msg, selfHandle);
		return new ConversationScope(
			this,
			msg.conversation_id,
			peer,
			msg.id as MessageUuid,
		);
	}

	/**
	 * Fetch the both-sided, role-tagged transcript of a conversation or a group.
	 * Each row is decrypted with the caller's OWN keys —
	 * the self-sealed copy for messages this agent sent, the recipient copy
	 * for messages it received, the group cache for group rows. Undecryptable
	 * rows (a legacy sent message with no self-blob, or a decrypt failure)
	 * render as `"[unavailable]"` and never throw.
	 *
	 * 🔴 A **group** is named the way every other group verb takes it — a
	 * handle, a bare name or a UUID. Reading a group used to be the one verb in
	 * the family that would not accept the name of the thing it reads: it
	 * demanded a *conversation* UUID, the id of a different entity whose only
	 * source was a column another method returned. A caller holding a group and
	 * nothing else had nowhere to spend it, and spent it here anyway — into a
	 * path parameter the server types `uuid.UUID`, which answers a framework
	 * 422 and no next step.
	 *
	 * `conversationId` stays first and positional, so nothing that worked before
	 * `group` existed calls differently now.
	 *
	 * Exposed via `client.conversation(id).thread()`; this method carries the
	 * client-internal plumbing (agent resolution + http) so `ConversationScope`
	 * stays a thin delegator, mirroring how `send`/`inbox` route through the
	 * client.
	 *
	 * @example
	 * ```ts
	 * await client.thread(msg.conversation_id);
	 * await client.thread({ group: "#ops@acme" });
	 * ```
	 *
	 * @throws {Error} Both references named, or neither, or a `conversationId`
	 *   that is not a spelling the wire reads as a UUID — all refused locally,
	 *   before a request is spent.
	 */
	thread(conversationId: string, opts?: ThreadOptions): Promise<ThreadEntry[]>;
	thread(opts: ThreadOptions): Promise<ThreadEntry[]>;
	async thread(
		conversationIdOrOpts?: string | ThreadOptions,
		maybeOpts?: ThreadOptions,
	): Promise<ThreadEntry[]> {
		const isPositional = typeof conversationIdOrOpts === "string";
		const opts = (isPositional ? maybeOpts : conversationIdOrOpts) ?? {};
		// Exactly one of the two references, and a conversation reference the wire
		// would read as a UUID — both decided in `rine-core`, offline, so a caller
		// that named the wrong thing pays nothing to find out.
		const ref = resolveThreadRef(
			{
				...(isPositional ? { conversationId: conversationIdOrOpts } : {}),
				...(opts.group !== undefined ? { group: opts.group } : {}),
			},
			THREAD_REF_SURFACES.sdk,
		);
		const signal = opts.signal ?? this._signal;
		const core = this.http.getCoreHttpClient({ signal });
		// Honor the agent override so a non-default agent in a multi-agent org
		// can read its own thread (the self-sealed `direction:"sent"` blob is
		// sealed to one specific agent's key — picking the reader is load-bearing
		// for that decrypt). Mirrors `inbox`/`read`/Python `thread(agent=...)`.
		const agentId = await this.messagingResource.resolveSenderId(
			core,
			opts.agent,
		);
		// The group resolve and the read name the SAME acting agent. `GET /groups`
		// selects on the org today, so this changes no verdict — but one call
		// answered by two different actors is what a reader of the trace sees, and
		// the day that route becomes agent-scoped it would resolve silently wrong.
		const actorHeader = actingAgentHeader(opts.agent, agentId);
		const fetchOpts: FetchThreadOptions = {
			http: this.http,
			core,
			agentId,
			path: await transcriptPath(core, ref, actorHeader),
			...(opts.agent !== undefined ? { agent: opts.agent } : {}),
			...(opts.limit !== undefined ? { limit: opts.limit } : {}),
			...(signal !== undefined ? { signal } : {}),
		};
		return fetchThread(fetchOpts);
	}

	// -------------------------------------------------------------------------
	// Async delivery
	// -------------------------------------------------------------------------

	stream(opts?: StreamOptions): AsyncIterable<RineEvent> {
		return this.streams.stream({ signal: this._signal, ...opts });
	}

	/** Check how many unread messages are waiting (lightweight poll). */
	poll(): Promise<number> {
		return this.polling.poll();
	}

	/**
	 * Watch for incoming messages via polling — calls `handler` on each new message.
	 *
	 * Ergonomic surface for polling agents behind firewalls (where SSE is
	 * unavailable). Returns an unsubscribe function.
	 */
	async watch<M = DecryptedMessage>(
		handler: (msg: M) => Promise<void> | void,
		opts?: WatchOptions,
	): Promise<() => void> {
		const {
			signal,
			pollInterval = 5_000,
			onError,
		} = {
			signal: this._signal,
			...opts,
		};
		let stopped = false;

		// Bounded seen-id dedup — ids are UUIDs, which are not lexicographically
		// ordered, so the previous `msg.id > lastId` check was unsound. Each
		// page is sorted by `created_at` (the real ordering signal) and
		// deduped against the most recent 500 ids.
		const seen = new SeenIds(500);

		const tick = async () => {
			while (!stopped) {
				if (signal?.aborted) break;
				try {
					const page = await this.inbox({ limit: 10, signal });
					const sorted = [...page.items].sort((a, b) => {
						const ta = (a as { created_at?: string }).created_at ?? "";
						const tb = (b as { created_at?: string }).created_at ?? "";
						return ta.localeCompare(tb);
					});
					for (const msg of sorted) {
						const id = (msg as { id: string }).id;
						if (!seen.record(id)) continue;
						await handler(msg as M);
					}
				} catch (err) {
					if (onError) onError(err);
				}
				await sleepWithSignal(pollInterval, signal);
			}
		};

		tick();
		return () => {
			stopped = true;
		};
	}

	// -------------------------------------------------------------------------
	// Identity
	// -------------------------------------------------------------------------

	/** Fetch the current org identity, agent list, and trust tier. */
	whoami() {
		return this.identity.whoami();
	}
	createAgent(name: string, opts?: CreateAgentOptions) {
		return this.identity.createAgent(name, opts);
	}
	listAgents(opts?: { includeRevoked?: boolean }) {
		return this.identity.listAgents(opts);
	}
	getAgent(agentId: AgentUuid) {
		return this.identity.getAgent(agentId);
	}
	updateAgent(agentId: AgentUuid, patch: UpdateAgentPatch) {
		return this.identity.updateAgent(agentId, patch);
	}
	revokeAgent(agentId: AgentUuid) {
		return this.identity.revokeAgent(agentId);
	}
	rotateKeys(agentId: AgentUuid) {
		return this.identity.rotateKeys(agentId);
	}
	/** Prove control of a SPIFFE identity for an agent (→ org trust tier 2). */
	verifyIdentity(agentId: AgentUuid, opts?: VerifyIdentityOptions) {
		return this.identity.verifyIdentity(agentId, opts);
	}
	addPostQuantumKey(agentId: AgentUuid, opts?: AddPostQuantumKeyOptions) {
		return this.identity.addPostQuantumKey(agentId, opts);
	}
	getAgentCard(agentId: AgentUuid) {
		return this.identity.getAgentCard(agentId);
	}
	setAgentCard(agentId: AgentUuid, card: AgentCardInput) {
		return this.identity.setAgentCard(agentId, card);
	}
	deleteAgentCard(agentId: AgentUuid): Promise<void> {
		return this.identity.deleteAgentCard(agentId);
	}
	regeneratePollToken(agentId: AgentUuid) {
		return this.identity.regeneratePollToken(agentId);
	}
	revokePollToken(agentId: AgentUuid): Promise<void> {
		return this.identity.revokePollToken(agentId);
	}
	getQuotas() {
		return this.identity.getQuotas();
	}
	updateOrg(patch: UpdateOrgPatch, opts?: { signal?: AbortSignal }) {
		return this.identity.updateOrg(patch, opts);
	}
	eraseOrg(opts: EraseOrgOptions) {
		return this.identity.eraseOrg(opts);
	}
	exportOrg(opts?: { signal?: AbortSignal }) {
		return this.identity.exportOrg(opts);
	}

	// -------------------------------------------------------------------------
	// Discovery
	// -------------------------------------------------------------------------

	discover(filters?: DiscoveryFilters) {
		return this.discovery.discover(filters);
	}

	/**
	 * Auto-paginating async iterator over every agent that matches the
	 * supplied discovery filters. Walks `nextCursor` until exhausted.
	 * Replaces the removed `CursorPage.autoPaginate()` helper.
	 */
	async *discoverAll(filters?: DiscoveryFilters) {
		let cursor = filters?.cursor;
		while (true) {
			const page = await this.discovery.discover({ ...filters, cursor });
			yield* page.items;
			if (!page.hasNext || page.nextCursor == null) return;
			cursor = page.nextCursor;
		}
	}

	inspect(handleOrId: string) {
		return this.discovery.inspect(handleOrId);
	}

	discoverGroups(opts?: DiscoverGroupsOptions) {
		return this.discovery.discoverGroups(opts);
	}

	async *discoverGroupsAll(opts?: Omit<DiscoverGroupsOptions, "cursor">) {
		let cursor: string | undefined;
		while (true) {
			const page = await this.discovery.discoverGroups({ ...opts, cursor });
			yield* page.items;
			if (!page.hasNext || page.nextCursor == null) return;
			cursor = page.nextCursor;
		}
	}

	// -------------------------------------------------------------------------
	// Derived clients
	// -------------------------------------------------------------------------

	/**
	 * Returns a new `AsyncRineClient` that shares credentials and middleware
	 * but applies the supplied overrides. Any option not provided inherits
	 * from this client.
	 *
	 * This is the idiomatic single-method replacement for the narrower
	 * `withSignal` / `withTimeout` / `withAgent` helpers, which remain
	 * available for callers that prefer the specialised APIs.
	 */
	withOptions(opts: {
		timeout?: number;
		agent?: string;
		maxRetries?: number;
		signal?: AbortSignal;
	}): AsyncRineClient {
		const derived = new AsyncRineClient({
			configDir: this.http.configDir,
			apiUrl: this.http.apiUrl,
			agent: opts.agent ?? this.http.agentHeader?.[ACTING_AGENT_HEADER],
			timeout: opts.timeout ?? this.http.timeout,
			maxRetries: opts.maxRetries ?? this.http.maxRetries,
			middleware: this.http.middleware,
			signal: opts.signal ?? this._signal,
		});
		// The agent list is ORG-scoped and this derived client shares the
		// credentials that scope it, so it shares the fetch too. Without this a
		// host that derives per call — `rine-mastra` does, on every tool execute —
		// would pay `GET /agents` per render, which is not the cost the cache is
		// there to accept.
		derived.handleCache = this.handleCache;
		return derived;
	}

	/** Return a derived client bound to the given AbortSignal. */
	withSignal(signal: AbortSignal): AsyncRineClient {
		return this.withOptions({ signal });
	}

	/** Return a derived client with a different request timeout. */
	withTimeout(ms: number): AsyncRineClient {
		return this.withOptions({ timeout: ms });
	}

	/** Return a derived client acting as a different agent. */
	withAgent(agent: string): AsyncRineClient {
		return this.withOptions({ agent });
	}

	// -------------------------------------------------------------------------
	// Lifetime
	// -------------------------------------------------------------------------

	/** Release any resources held by this client. */
	async close(): Promise<void> {
		// HttpClient has no persistent connections; the only retained state is
		// the group-decrypt memo, whose entries are decrypted plaintext.
		this.http.decryptMemo.clear();
	}

	/** Implements `AsyncDisposable` — delegates to `close()`. */
	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize the `type` filter from `client.messages()` into a Set for O(1)
 * membership tests. Returns `undefined` when no filter was passed (caller
 * branches on `filterTypes !== undefined`).
 */
function normalizeTypeFilter(
	filter: string | readonly string[] | undefined,
): ReadonlySet<string> | undefined {
	if (filter === undefined) return undefined;
	if (typeof filter === "string") return new Set([filter]);
	if (filter.length === 0) return undefined;
	return new Set(filter);
}

/**
 * Derive the "other party" for a conversation scope from a decrypted
 * message. Supports group messages (peer = group handle) and 1:1 DMs
 * (peer = original sender's handle or UUID). Returns `null` when the
 * derivation is ambiguous (system message, missing handle on a group
 * frame, etc.) so that `scope.send(payload)` surfaces the clear
 * "no peer" error instead of misrouting to a stale address.
 */
function derivePeerFromMessage(
	msg: DecryptedMessage,
	selfHandle?: string,
): AgentHandle | AgentUuid | GroupHandle | null {
	// Group messages first — they carry `group_id` + `group_handle`.
	if (msg.group_id) {
		return (msg.group_handle ?? null) as GroupHandle | null;
	}
	// 1:1 DM — when we know the caller's identity, return the *other*
	// party. For messages I sent, that's the recipient; for messages I
	// received, that's the sender. Without selfHandle, fall back to
	// sender-prefer (legacy / no-pinned-agent callers).
	if (selfHandle && msg.sender_handle === selfHandle) {
		// I sent this message — peer is the recipient.
		if (msg.recipient_handle) return msg.recipient_handle as AgentHandle;
		if (msg.to_agent_id) return msg.to_agent_id as AgentUuid;
		return null;
	}
	if (msg.sender_handle) return msg.sender_handle as AgentHandle;
	if (msg.from_agent_id) return msg.from_agent_id as AgentUuid;
	return null;
}
