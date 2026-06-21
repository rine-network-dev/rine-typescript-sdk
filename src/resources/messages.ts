/**
 * Messages resource — send, inbox, read, reply, sendAndWait.
 *
 * All outbound messages are E2E-encrypted before leaving the SDK. Inbound
 * messages are auto-decrypted with sender-key retry on read().
 */

import {
	type AgentRead as CoreAgentRead,
	type HttpClient as CoreHttpClient,

	encryptGroupMessage,
	encryptMessage,
	encryptMlsGroupMessage,
	fetchAgents,
	fetchRecipientKeys,
	getOrCreateSenderKey,
	normalizeHandle,
	processMlsWelcomes,
	resolveAgent,
	resolveToUuid,
	syncMlsGroup,
} from "@rine-network/core";
import { parse, parseCursorPage } from "../api/adapters.js";
import type { SDKHttpClient } from "../api/http.js";
import type {
	InboxOptions,
	MarkDeliveredOptions,
	ReadOptions,
	ReplyOptions,
	SendAndWaitOptions,
	SendOptions,
} from "../client.js";
import {
	type DecryptedMessage,
	DecryptedMessageSchema,
	type GroupRead,
	GroupReadSchema,
	type MessageRead,
	MessageReadSchema,
	type SendAndWaitResult,
	isGroupHandle,
} from "../types.js";
import type {
	AgentHandle,
	AgentUuid,
	GroupHandle,
	GroupUuid,
	MessageUuid,
} from "../types.js";
import { RineTimeoutError } from "../errors.js";
import { anySignal } from "../utils/abort.js";
import { CursorPage } from "../utils/cursor-page.js";
import { decryptEnvelope } from "./decrypt.js";

// ---------------------------------------------------------------------------
// MessagesResource
// ---------------------------------------------------------------------------

type Recipient = AgentHandle | AgentUuid | GroupHandle | GroupUuid;

const DEFAULT_SEND_TYPE = "rine.v1.task_request";
const DEFAULT_REPLY_TYPE = "rine.v1.task_response";

export class MessagesResource {
	constructor(private readonly http: SDKHttpClient) {}

	async send(
		to: Recipient,
		payload: unknown,
		opts: SendOptions = {},
	): Promise<MessageRead> {
		// Outbound schema validation runs at the client-layer wrapper
		// (`AsyncRineClient.send<T>`) so the resource layer receives an
		// already-validated payload — one validation pass per outbound
		// logical call.
		const op = this.beginOp(opts.signal);
		try {
			const core = this.http.getCoreHttpClient({ signal: op.signal });
			const senderId = await this.resolveSenderId(core, opts.agent);

			const body = await this.buildSendBody(core, senderId, to, payload, opts);

			const raw = await this.http.post<unknown>("/messages", body, {
				signal: op.signal,
				operation: "send",
				extraHeaders: mergeHeaders(
					idempotencyHeader(opts.idempotencyKey),
					agentOverrideHeader(opts.agent),
				),
			});
			// `parse<T>(schema, data)` erases the precise Zod output type
			// through its `z.ZodType<T>` parameter — the loose inferred shape
			// leaves `metadata` optional, even though `MessageReadSchema`'s
			// `.default({})` chain guarantees it at runtime. Cast back to
			// the strict `MessageRead` to match the declared return type.
			return parse(MessageReadSchema, raw);
		} finally {
			op.clear();
		}
	}

	/**
	 * Fetch the current agent's inbox with auto-decryption.
	 *
	 * Route is `GET /agents/{agentId}/messages` — requires resolving the
	 * caller's agent UUID up-front (via the same `resolveSenderId()` path as
	 * `send()` / `reply()`), so the inbox is always scoped to one specific
	 * agent even in multi-agent orgs.
	 *
	 * Decryption runs per-item via `decryptEnvelope()`. Failures populate
	 * `decrypt_error` on the returned `DecryptedMessage` instead of throwing
	 * — the page still contains the envelope, just without plaintext.
	 * Inbox delivery is best-effort: one broken envelope never poisons the
	 * whole page.
	 */
	async inbox(opts: InboxOptions = {}) {
		const op = this.beginOp(opts.signal);
		try {
			const core = this.http.getCoreHttpClient({ signal: op.signal });
			const agentId = await this.resolveSenderId(core, opts.agent);

			const raw = await this.http.get<unknown>(`/agents/${agentId}/messages`, {
				params: {
					limit: opts.limit,
					cursor: opts.cursor,
					status: opts.status,
				},
				signal: op.signal,
				operation: "inbox",
				extraHeaders: agentOverrideHeader(opts.agent),
			});
			const page = parseCursorPage(DecryptedMessageSchema, raw);

			const items = await Promise.all(
				page.items.map((item) =>
					decryptEnvelope({
						core,
						configDir: this.http.configDir,
						agentId,
						msg: item,
					}),
				),
			);

			return new CursorPage<DecryptedMessage>(
				items,
				page.total,
				page.nextCursor,
				page.prevCursor,
			);
		} finally {
			op.clear();
		}
	}

	/**
	 * Mark messages as delivered for an agent (idempotent).
	 *
	 * Resolves the acting agent up-front (same `resolveSenderId()` path as
	 * `inbox()`/`send()`), then POSTs `{ message_ids }` to
	 * `/agents/{agentId}/messages/mark-delivered`. Returns the server's
	 * `marked` count (messages newly transitioned to delivered).
	 */
	async markDelivered(
		messageIds: MessageUuid[] | string[],
		opts: MarkDeliveredOptions = {},
	): Promise<number> {
		const op = this.beginOp(opts.signal);
		try {
			const core = this.http.getCoreHttpClient({ signal: op.signal });
			const agentId = await this.resolveSenderId(core, opts.agent);

			const raw = await this.http.post<{ marked?: number }>(
				`/agents/${agentId}/messages/mark-delivered`,
				{ message_ids: messageIds },
				{
					signal: op.signal,
					operation: "markDelivered",
					extraHeaders: agentOverrideHeader(opts.agent),
				},
			);
			return raw?.marked ?? 0;
		} finally {
			op.clear();
		}
	}

	/**
	 * Fetch and decrypt a single message by id.
	 *
	 * Dispatches to `decryptMessage` (HPKE) or `decryptGroupMessage`
	 * (sender-key) based on `encryption_version`. On a sender-key failure
	 * (e.g. the reader has not yet ingested the sender's distribution),
	 * retries once after calling `fetchAndIngestPendingSKDistributions` via
	 * the rine-core bridge.
	 *
	 * Failures on the HPKE path or after the sender-key retry populate
	 * `decrypt_error` on the returned message instead of throwing, so
	 * callers can branch on `msg.decrypt_error !== null`.
	 */
	async read(messageId: MessageUuid, opts: ReadOptions = {}) {
		const op = this.beginOp(opts.signal);
		try {
			const core = this.http.getCoreHttpClient({ signal: op.signal });
			const agentId = await this.resolveSenderId(core, opts.agent);

			const raw = await this.http.get<unknown>(`/messages/${messageId}`, {
				signal: op.signal,
				operation: "read",
				extraHeaders: agentOverrideHeader(opts.agent),
			});
			const msg = parse(DecryptedMessageSchema, raw);

			// Inbound schema validation runs at the client-layer wrapper
			// (`AsyncRineClient.read<T>`). The resource returns a raw
			// `DecryptedMessage` and the client-layer applies
			// `parseMessagePlaintext` before returning.
			return decryptEnvelope({
				core,
				configDir: this.http.configDir,
				agentId,
				msg,
				retrySenderKey: true,
			});
		} finally {
			op.clear();
		}
	}

	async reply(
		messageId: MessageUuid,
		payload: unknown,
		opts: ReplyOptions = {},
	): Promise<MessageRead> {
		// Outbound schema validation runs at the client-layer wrapper
		// (`AsyncRineClient.reply<T>`) — this resource receives an
		// already-validated payload.
		const op = this.beginOp(opts.signal);
		try {
			const core = this.http.getCoreHttpClient({ signal: op.signal });

			// 1. Fetch original to recover sender/recipient.
			const original = parse(MessageReadSchema, await core.get(
				`/messages/${messageId}`,
			));
			const recipientId = original.from_agent_id;
			if (!recipientId) {
				throw new Error(
					`Cannot reply to message ${messageId}: original has no sender (system message?)`,
				);
			}

			// 2. Sender is us — prefer explicit override, then the original's
			//    to_agent_id (the mailbox the message landed in) IF it is an
			//    agent in this caller's org, then the SDK's default agent.
			//
			//    The foreign-`to_agent_id` case appears when the caller replies
			//    to a message they themselves sent (REQ-02): `original.to_agent_id`
			//    points at the peer's agent, not one of ours. Skipping it lets
			//    the flow reach the "replying to your own message" guard below
			//    instead of failing earlier inside `resolveSenderId` with a
			//    confusing "not owned by current org" error.
			const agents = await fetchAgents(core);
			const ownedAgentIds = new Set(agents.map((a) => a.id));
			const toAgentIdIfOwned =
				original.to_agent_id && ownedAgentIds.has(original.to_agent_id)
					? original.to_agent_id
					: undefined;
			const senderHint =
				opts.agent ?? toAgentIdIfOwned ?? this.defaultAgentHint();
			const senderId = await this.resolveSenderId(core, senderHint, agents);

			// 3. Guard against replying to own message (matches MCP/CLI — the
			//    server will also reject, but a clear SDK error is better DX).
			if (recipientId === senderId) {
				throw new Error(
					`Cannot reply to your own message (${messageId}). Send a new message to continue the conversation.`,
				);
			}

			// 4. Encrypt to the original sender's public encryption key.
			const recipientKeys = await fetchRecipientKeys(core, recipientId);
			const encrypted = await encryptMessage(
				this.http.configDir,
				senderId,
				recipientKeys.encryption,
				payload,
				recipientKeys.pqEncryption,
			);

			const body: Record<string, unknown> = {
				type: opts.type ?? DEFAULT_REPLY_TYPE,
				content_type: opts.contentType ?? "application/json",
				// `...encrypted` carries `self_encrypted_payload` (the sender
				// self-seal from `encryptMessage`, REQ-SDK-TS-01) onto the wire
				// for 1:1 replies — there is no body whitelist that would strip
				// it. The server (Slice A) persists it so the sender can later
				// self-read its own reply via `thread()`.
				...encrypted,
			};
			if (opts.metadata) body.metadata = opts.metadata;

			const raw = await this.http.post<unknown>(
				`/messages/${messageId}/reply`,
				body,
				{
					signal: op.signal,
					operation: "reply",
					extraHeaders: mergeHeaders(
						idempotencyHeader(opts.idempotencyKey),
						agentOverrideHeader(opts.agent),
					),
				},
			);
			return parse(MessageReadSchema, raw);
		} finally {
			op.clear();
		}
	}

	/**
	 * Atomic send-and-wait via `POST /messages/sync`.
	 *
	 * The server's `/messages/sync` endpoint accepts a full `MessageCreate`
	 * body (same shape as `POST /messages`) plus a `?timeout_ms` query param.
	 * It creates the message, delivers it, then long-polls for a reply — all
	 * in one HTTP request. Returns `SyncMessageResponse = { message, reply,
	 * conversation_id, status }`.
	 *
	 * Returns `{ sent, reply }`. `reply` is null on long-poll timeout.
	 *
	 * Note: the server rejects group handles on `/messages/sync`, so this
	 * method is 1:1 DMs only.
	 */
	async sendAndWait(
		to: Recipient,
		payload: unknown,
		opts: SendAndWaitOptions = {},
	): Promise<SendAndWaitResult> {
		if (isGroupHandle(to as string)) {
			throw new Error(
				"sendAndWait() does not support group handles — the server's /messages/sync endpoint is 1:1 only.",
			);
		}

		// Schema validation (request side) runs at the client-layer wrapper.
		// This resource receives an already-validated payload.
		const op = this.beginOp(opts.signal);
		try {
			const core = this.http.getCoreHttpClient({ signal: op.signal });
			const senderId = await this.resolveSenderId(core, opts.agent);

			// Build the full encrypted body — same as send() uses.
			const body = await this.buildSendBody(core, senderId, to, payload, {
				type: opts.type,
				contentType: opts.contentType,
				metadata: opts.metadata,
			});

			const timeoutMs = opts.timeout ?? 30_000;
			const raw = await this.http.post<{
				message: unknown;
				reply: unknown;
			} | null>(
				"/messages/sync",
				body,
				{
					params: { timeout_ms: timeoutMs },
					signal: op.signal,
					operation: "sendAndWait",
					extraHeaders: mergeHeaders(
						idempotencyHeader(opts.idempotencyKey),
						agentOverrideHeader(opts.agent),
					),
				},
			);

			// Server returns SyncMessageResponse = { message, reply, conversation_id, status }.
			const sent = parse(MessageReadSchema, raw?.message);

			let decryptedReply: DecryptedMessage | null = null;
			const rawReply = raw?.reply;
			if (rawReply != null) {
				const replyMsg = parse(DecryptedMessageSchema, rawReply);
				decryptedReply = await decryptEnvelope({
					core,
					configDir: this.http.configDir,
					agentId: senderId,
					msg: replyMsg,
					retrySenderKey: true,
				});
				// `replySchema` narrowing runs at the client-layer wrapper.
			}
			return { sent, reply: decryptedReply };
		} finally {
			op.clear();
		}
	}

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	/**
	 * Build the `POST /messages` body with real E2EE output.
	 *
	 * - Group handle → `getOrCreateSenderKey` → `encryptGroupMessage` → body
	 *   carries `to_handle` + sender-key envelope.
	 * - Everything else (agent handle, agent UUID, group UUID) → resolve to
	 *   UUID via rine-core, HPKE-seal with `encryptMessage`, body carries
	 *   `to_agent_id` + HPKE envelope.
	 *
	 * Note on group UUIDs: the server body shape for groups requires the
	 * handle (`to_handle`). Callers routing a group by UUID must pass the
	 * group handle instead — the UUID form is accepted at the type level for
	 * API symmetry but will be encrypted as a 1:1 and rejected server-side.
	 */
	private async buildSendBody(
		core: CoreHttpClient,
		senderId: string,
		to: Recipient,
		payload: unknown,
		opts: SendOptions,
	): Promise<Record<string, unknown>> {
		const target = normalizeHandle(to as string);
		const base: Record<string, unknown> = {
			type: opts.type ?? DEFAULT_SEND_TYPE,
			content_type: opts.contentType ?? "application/json",
		};
		if (opts.metadata) base.metadata = opts.metadata;
		if (opts.parentConversationId)
			base.parent_conversation_id = opts.parentConversationId;
		if (opts.conversationMetadata)
			base.conversation_metadata = opts.conversationMetadata;

		if (isGroupHandle(target)) {
			// Resolve the group to inspect its `mls_group_id` latch. Non-null ⇒
			// the group uses MLS (route through `encryptMlsGroupMessage`); null
			// ⇒ the existing sender-key path. The rine group UUID (`group.id`)
			// is the only MLS state key — never the opaque `mls_group_id`.
			const group = await this.resolveGroup(core, target);

			if (group.mls_group_id !== null) {
				const result = await this.encryptMlsWithRecovery(
					core,
					senderId,
					group.id,
					payload,
				);
				return {
					...base,
					to_handle: target,
					...result,
				};
			}

			// Sender-key path. The rine-core helper carries X-Rine-Agent on its
			// distribution fan-out so multi-agent orgs route key distributions
			// through the right mailbox.
			const extraHeaders: Record<string, string> = {
				"X-Rine-Agent": senderId,
			};
			const { state, groupId } = await getOrCreateSenderKey(
				core,
				this.http.configDir,
				senderId,
				target,
				extraHeaders,
			);
			const { result } = await encryptGroupMessage(
				this.http.configDir,
				senderId,
				groupId,
				state,
				payload,
			);
			return {
				...base,
				to_handle: target,
				...result,
			};
		}

		// 1:1 HPKE path. resolveToUuid accepts UUIDs (pass-through) and agent
		// handles (WebFinger lookup). Raw bare names are not supported here —
		// the SDK requires a handle or UUID for the recipient.
		const recipientId = await resolveToUuid(this.http.apiUrl, target);
		const recipientKeys = await fetchRecipientKeys(core, recipientId);
		const encrypted = await encryptMessage(
			this.http.configDir,
			senderId,
			recipientKeys.encryption,
			payload,
			recipientKeys.pqEncryption,
		);
		return {
			...base,
			to_agent_id: recipientId,
			// `...encrypted` carries `self_encrypted_payload` (the sender
			// self-seal from `encryptMessage`, REQ-SDK-TS-01) on the 1:1 send
			// path. Group sends never reach here — `encryptGroupMessage`/
			// `encryptMlsGroupMessage` return an `EncryptResult` with no
			// `self_encrypted_payload`, so their `...result` spread carries
			// none (groups self-read via the key cache, not the self-blob).
			...encrypted,
		};
	}

	/**
	 * Resolve a group handle to its `GroupRead` so the send path can inspect
	 * the `mls_group_id` latch. Mirrors the server's handle lookup
	 * (`GET /groups?handle=…`) used by the CLI/MCP group send paths.
	 */
	private async resolveGroup(
		core: CoreHttpClient,
		handle: string,
	): Promise<GroupRead> {
		const raw = await core.get("/groups", { handle });
		const page = parseCursorPage(GroupReadSchema, raw);
		const group = page.items[0];
		if (!group) throw new Error(`Group not found: ${handle}`);
		return group;
	}

	/**
	 * MLS group send with one-shot recovery. If the agent has no local MLS
	 * state for the group, install pending Welcomes + sync (epoch advance),
	 * then retry the encrypt once. Mirrors the sender-key auto-recovery in the
	 * read path. `encryption_version` is `"mls-v1"`, set by core — never
	 * overridden here.
	 */
	private async encryptMlsWithRecovery(
		core: CoreHttpClient,
		senderId: string,
		groupId: string,
		payload: unknown,
	): Promise<Awaited<ReturnType<typeof encryptMlsGroupMessage>>> {
		try {
			return await encryptMlsGroupMessage(
				this.http.configDir,
				senderId,
				groupId,
				payload,
			);
		} catch (err) {
			if (
				err instanceof Error &&
				err.message.startsWith("No MLS state for group")
			) {
				await processMlsWelcomes(this.http.configDir, senderId, core);
				await syncMlsGroup(this.http.configDir, senderId, groupId, core, {
					"X-Rine-Agent": senderId,
				});
				return await encryptMlsGroupMessage(
					this.http.configDir,
					senderId,
					groupId,
					payload,
				);
			}
			throw err;
		}
	}

	/**
	 * Resolve the sender agent to a UUID suitable for loading local keys.
	 *
	 * Precedence: explicit override → SDK default agent → single-agent
	 * shortcut (errors on multi-agent orgs).
	 *
	 * Makes one `GET /agents` request per send; no local caching.
	 *
	 * Also verifies the resolved agent is in the caller's own org. `resolveAgent`
	 * short-circuits on UUIDs without validating membership, so a foreign-org
	 * UUID (e.g. an `original.to_agent_id` from a misrouted reply) would slip
	 * through and fail later inside `loadAgentKeys` with a confusing "keys file
	 * not found" filesystem error. The membership check turns that into a clear
	 * "not your agent" error.
	 *
	 * Exposed as `public` (not `private`) so `client.messages()` can reuse
	 * the same resolution path for its SSE-bound decryption loop.
	 */
	async resolveSenderId(
		core: CoreHttpClient,
		explicit: string | undefined,
		preFetchedAgents?: CoreAgentRead[],
	): Promise<string> {
		const hint = explicit ?? this.defaultAgentHint();
		const agents = preFetchedAgents ?? (await fetchAgents(core));
		const senderId = await resolveAgent(this.http.apiUrl, agents, hint);
		if (!agents.some((a) => a.id === senderId)) {
			throw new Error(
				`Agent ${senderId} is not owned by the current org — cannot sign on its behalf. Pass an agent from your own org via opts.agent, or omit it to use the default.`,
			);
		}
		return senderId;
	}

	private defaultAgentHint(): string | undefined {
		return this.http.agentHeader?.["X-Rine-Agent"];
	}

	/**
	 * Open an operation-scoped cancellation window that spans the whole
	 * encrypt → post chain. One timer, one AbortController. The `clear`
	 * callback must run in `finally` to avoid a timer leak.
	 *
	 * The op-timer aborts with a `RineTimeoutError` reason so that callers
	 * and `SDKHttpClient.request()` can distinguish user-signal abort
	 * (native AbortError) from SDK op-timer expiry (`RineTimeoutError`).
	 */
	private beginOp(userSignal: AbortSignal | undefined): OpScope {
		const timeoutAC = new AbortController();
		const timer = setTimeout(
			() =>
				timeoutAC.abort(
					new RineTimeoutError(
						`Operation timed out after ${this.http.timeout}ms`,
					),
				),
			this.http.timeout,
		);
		const signal = userSignal
			? anySignal(userSignal, timeoutAC.signal)
			: timeoutAC.signal;
		return {
			signal,
			clear: () => clearTimeout(timer),
		};
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface OpScope {
	readonly signal: AbortSignal;
	readonly clear: () => void;
}

function idempotencyHeader(
	key: string | undefined,
): Record<string, string> | undefined {
	// Server reads `Idempotency-Key` (no `X-` prefix) via FastAPI
	// `Header(alias="Idempotency-Key")` — see src/rine/api/messages.py:747.
	if (!key) return undefined;
	return { "Idempotency-Key": key };
}

function agentOverrideHeader(
	agent: string | undefined,
): Record<string, string> | undefined {
	if (!agent) return undefined;
	return { "X-Rine-Agent": agent };
}

function mergeHeaders(
	...parts: (Record<string, string> | undefined)[]
): Record<string, string> | undefined {
	const merged: Record<string, string> = {};
	for (const part of parts) {
		if (part) Object.assign(merged, part);
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}
