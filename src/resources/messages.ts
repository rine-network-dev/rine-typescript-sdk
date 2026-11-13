/**
 * Messages resource — send, inbox, read, reply, sendAndWait.
 *
 * All outbound messages are E2E-encrypted before leaving the SDK. Inbound
 * messages are auto-decrypted with sender-key retry on read().
 */

import {
	type AgentRead as CoreAgentRead,
	type HttpClient as CoreHttpClient,
	type RecipientTarget,
	type ResolvedActor,
	ACTING_AGENT_HEADER,
	ACTOR_SURFACES,
	MlsInitInFlightError,
	REF_CLASS,
	assertGroupPostable,
	assertNoMlsDowngrade,
	classifyReference,
	encryptGroupMessage,
	encryptMlsGroupMessage,
	fetchAgents,
	getOrCreateSenderKey,
	isNoMlsStateError,
	normalizeHandle,
	postWithEscrowRetry,
	prepareEscrowForSend,
	processMlsWelcomes,
	readableGroupById,
	resolveAgent,
	resolveRecipient,
	resolveToUuid,
	sealForAgent,
	syncMlsGroup,
	withPeekHeader,
} from "@rine-network/core";
import { actingAgentHeader } from "../api/acting-agent.js";
import { GroupReadSchema, parse, parseCursorPage } from "../api/adapters.js";
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
	type MessageRead,
	MessageReadSchema,
	type SendAndWaitResult,
} from "../types.js";
import type {
	AgentHandle,
	AgentUuid,
	GroupHandle,
	GroupRead,
	GroupUuid,
	MessageUuid,
} from "../types.js";
import { ReplyAttributionError, RineTimeoutError } from "../errors.js";
import { groupAcceptsMlsSendOnly } from "../format/groups.js";
import { anySignal } from "../utils/abort.js";
import { CursorPage } from "../utils/cursor-page.js";
import { decryptEnvelope } from "./decrypt.js";
import { isSettled } from "./settled.js";

// ---------------------------------------------------------------------------
// MessagesResource
// ---------------------------------------------------------------------------

type Recipient = AgentHandle | AgentUuid | GroupHandle | GroupUuid;

/**
 * What `sendAndWait` says about a group, whichever way the group was named.
 *
 * 🔴 **Append to this sentence; never change its head.** `rine-mastra`
 * (`src/errors.ts`) and `rine-eve` (`src/errors.ts`) each hold a
 * `GROUP_ON_WAIT_PREFIX` and `startsWith` it to reach the one refusal the
 * backend pins byte-for-byte across five packages
 * (`GROUP_ON_WAIT_MESSAGE_COPIES`, `tests/helpers_client_paths.py`). Both
 * packages are invisible to `ci.sh` and typecheck-gated inside the publish
 * train's `set -e` subshell, so a reworded head aborts a release mid-upload.
 *
 * One constant for BOTH classes this verb refuses — the sigil and the group
 * UUID — and deliberately not a second sentence for the id. The wording is the
 * one already published; the only reader of the difference between "handle" and
 * "id" is a developer holding the `Error`, because every connector surface
 * shows a model the same pinned sentence either way.
 */
const GROUP_ON_WAIT_REFUSAL =
	"sendAndWait() does not support group handles — the server's /messages/sync endpoint is 1:1 only.";

const DEFAULT_SEND_TYPE = "rine.v1.task_request";
const DEFAULT_REPLY_TYPE = "rine.v1.task_response";

/**
 * What a body is built FOR, once the recipient slot has been decided.
 *
 * A record rather than the caller's string, because the two verbs that build a
 * body decide the namespace by different rules and must keep doing so: `send`
 * asks `resolveRecipient` — the contract's door, which reads a bare name as a
 * group — and `sendAndWait` asks nothing wider than the whole handle it was
 * given, because `POST /messages/sync` is 1:1 only and a bare word there can
 * only be an agent handle with its org half dropped. Handing
 * {@link MessagesResource.buildSendBody} a string would put that decision back
 * inside the shared builder, where one verb's rule would silently become both.
 *
 * The group arm carries the ROW, not a handle: the resolve already read it, and
 * `mls_group_id`/`mls_enabled` decide which envelope the message is sealed in.
 * A builder handed a handle has to buy the same row again.
 *
 * ⚠️ Deliberately a type alias and not a `const`/`interface` declared here: the
 * backend's `TO_HANDLE_BINDING_SITES` gate names the `to_handle` binding below
 * after the nearest top-level `function`/`const`/`let`, which is
 * {@link DEFAULT_REPLY_TYPE}. A value declared between the two renames a
 * registered site and reds that gate for something that is not a defect.
 */
type SendTarget =
	| { readonly kind: "group"; readonly group: GroupRead }
	| { readonly kind: "agent"; readonly agentId: string };

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
			// One `GET /agents` for the whole send. `resolveSenderId` would
			// fetch it anyway; the bare-recipient collision guard reads the very
			// same list, and `fetchAgents` is uncached, so the list is fetched
			// here once and handed to both.
			const agents = await fetchAgents(core);
			const senderId = await this.resolveSenderId(core, opts.agent, agents);

			// The contract's recipient door (`rine-core/src/recipient-resolution.ts`),
			// which is where the dispatch table, the reason each class routes where
			// it does, and every refusal on it live. Nothing is restated here: this
			// surface used to hold a private half of that dispatch and hand the
			// answer back as a HANDLE, which the body builder then resolved a second
			// time — one `GET /groups?handle=` per bare or sigiled group send, paid
			// for a row the ladder had already read.
			//
			// `normalizeHandle` runs first, for the reason the Python twin does it
			// (`_client.py`: `recipient_ladder(normalize_handle(to), to)`): the body
			// builder normalised before it classified, so a short handle
			// (`#devs@acme`) has always reached the group ladder whole. It moves no
			// spelling between classes — the suffix is only ever appended to a
			// dotless org half, and every class it could move between is `@`-free —
			// but a refusal quotes the spelling it was handed, and this keeps the
			// one this surface prints byte-identical.
			//
			// `agents` is the page fetched two lines up, handed over rather than
			// fetched again (`ResolveOptions.agents`): `fetchAgents` is uncached by
			// design and the bare-recipient collision guard reads the same list.
			// `extraHeaders` is deliberately NOT passed — the resolve legs are
			// key-scoped reads and `X-Rine-Agent` goes on `POST /messages` alone,
			// so adding it here would change a request trace nothing about this
			// send needs changed.
			const recipient = await resolveRecipient(
				core,
				this.http.apiUrl,
				normalizeHandle(to as string),
				{ agents },
			);
			warnGroupIdRecipient(recipient);
			const { body, escrowGroupId } = await this.buildSendBody(
				core,
				senderId,
				recipient.kind === "group"
					? // The row crosses the SDK's Zod boundary exactly where
						// `resolveGroupHandle` used to put it, so the builder reads the
						// same shape `groups.get` answers with. `row` is set on every
						// rung of the member ladder; a body that somehow carried none is
						// refused here rather than read through a cast.
						{ kind: "group", group: parse(GroupReadSchema, recipient.row) }
					: { kind: "agent", agentId: recipient.id },
				payload,
				opts,
			);

			const post = (sendBody: Record<string, unknown>) =>
				this.http.post<unknown>("/messages", sendBody, {
					signal: op.signal,
					operation: "send",
					extraHeaders: mergeHeaders(
						idempotencyHeader(opts.idempotencyKey),
						actingAgentHeader(opts.agent, senderId),
					),
				});
			// An mls-v1 post is refused with 409 `escrow_missing` until this
			// epoch's escrow is uploaded; it is retried once after an upload.
			const raw =
				escrowGroupId === undefined
					? await post(body)
					: await postWithEscrowRetry(
							this.escrowActor(core, senderId),
							escrowGroupId,
							String(body.escrow_fp),
							(escrowFp) => post({ ...body, escrow_fp: escrowFp }),
						);
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
				extraHeaders: actingAgentHeader(opts.agent, agentId),
			});
			const page = parseCursorPage(DecryptedMessageSchema, raw);

			// 🔴 One item at a time. A page holding several posts from one group
			// decrypts them all against one ratchet in one state file, so a
			// concurrent map let each row's recovery overwrite the others' key
			// material and most of the page came back undecryptable on the first
			// read and fine on the second.
			const items: Awaited<ReturnType<typeof decryptEnvelope>>[] = [];
			for (const item of page.items) {
				items.push(
					await decryptEnvelope({
						core,
						configDir: this.http.configDir,
						agentId,
						msg: item,
						// Same recovery as `read()`: a cold group row (no sender-key
						// distribution ingested yet, or missing MLS state) refreshes
						// its key material from the server and retries once, instead
						// of surfacing an "unknown sender key id" that never heals.
						retrySenderKey: true,
						memo: this.http.decryptMemo,
					}),
				);
			}

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

			const raw = await this.postMarkDelivered(
				agentId,
				messageIds,
				op.signal,
				actingAgentHeader(opts.agent, agentId),
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
	 *
	 * **Reading a group message twice works, and it works because a local copy
	 * is kept.** Both group regimes spend a one-time key at the first successful
	 * decrypt, so the second read is answered from a cache this client writes:
	 * the newest 256 messages per group, capped at 1 MiB of plaintext, in
	 * `<configDir>/keys/<agentId>/group_reads/<groupId>.json` — an owner-only
	 * file (0600) in an owner-only directory, deleted when this agent leaves the
	 * group ITSELF. Being removed by somebody else deletes nothing here: the
	 * departing client is what runs the wipe, and a removed agent runs nothing,
	 * so its copy outlives the removal until the config directory is destroyed.
	 * It is plaintext at rest and widens what a stolen config directory yields;
	 * a replay is re-verified against the sender the server names on THIS read,
	 * never served on the strength of the first one. There is no off switch.
	 *
	 * **This read marks the message delivered only once it has settled**: it
	 * opened, carries no ciphertext, or its author was refused. The server holds
	 * no key and has no un-mark route, so the fetch is always a peek and the
	 * mark is a second request made here after the decrypt. A message this agent
	 * cannot open yet (no keys, a sender key still in flight) stays `new`, so a
	 * key fix or resync can still recover it. If the mark fails the message is
	 * still returned and the failure is logged with `console.warn`.
	 * `opts.peek` declines the mark even for a message that opens.
	 */
	async read(messageId: MessageUuid, opts: ReadOptions = {}) {
		const op = this.beginOp(opts.signal);
		try {
			const core = this.http.getCoreHttpClient({ signal: op.signal });
			const agentId = await this.resolveSenderId(core, opts.agent);

			const raw = await this.http.get<unknown>(`/messages/${messageId}`, {
				// The RESOLVED id, not the caller's spelling: the server marks the
				// acting agent's own delivery row, so the header has to name the
				// same agent whose key decrypts the envelope one call later. The
				// raw `opts.agent` is neither — it is absent whenever the id came
				// from the SDK default, and may be a bare name the header does not
				// accept.
				//
				// Always a peek: the mark is made below, once the row has settled.
				// A peek suppresses the server's mark and NOTHING else, the acting
				// agent included: the row is still read as this agent, with this
				// agent's keys, and a client that names nobody in a multi-agent org
				// is still refused.
				signal: op.signal,
				operation: "read",
				extraHeaders: withPeekHeader({ [ACTING_AGENT_HEADER]: agentId }, true),
			});
			const msg = parse(DecryptedMessageSchema, raw);

			// Inbound schema validation runs at the client-layer wrapper
			// (`AsyncRineClient.read<T>`). The resource returns a raw
			// `DecryptedMessage` and the client-layer applies
			// `parseMessagePlaintext` before returning.
			const opened = await decryptEnvelope({
				core,
				configDir: this.http.configDir,
				agentId,
				msg,
				retrySenderKey: true,
				memo: this.http.decryptMemo,
			});
			if (!opts.peek && isSettled(opened)) {
				await this.markReadDelivered(messageId, agentId, op.signal);
			}
			return opened;
		} finally {
			op.clear();
		}
	}

	/** The one `mark-delivered` request, for the public verb and for `read()`. */
	private postMarkDelivered(
		agentId: string,
		messageIds: readonly string[],
		signal: AbortSignal,
		extraHeaders: Record<string, string> | undefined,
	): Promise<{ marked?: number }> {
		return this.http.post<{ marked?: number }>(
			`/agents/${agentId}/messages/mark-delivered`,
			{ message_ids: messageIds },
			{ signal, operation: "markDelivered", extraHeaders },
		);
	}

	/** Mark a message `read()` settled; a failed mark is a warning, never a failed read. */
	private async markReadDelivered(
		messageId: MessageUuid,
		agentId: string,
		signal: AbortSignal,
	): Promise<void> {
		// Posted directly with the id this read already resolved: going through
		// `markDelivered` would resolve the acting agent a second time (another
		// `GET /agents`, another one-agent-fallback warning).
		try {
			await this.postMarkDelivered(agentId, [messageId], signal, {
				[ACTING_AGENT_HEADER]: agentId,
			});
		} catch (err) {
			// Cancellation is the caller's, not a failed mark: it bubbles out.
			if (err instanceof Error && err.name === "AbortError") throw err;
			console.warn(
				`rine: read ${messageId} but could not mark it delivered; it stays new: ${err instanceof Error ? err.message : String(err)}`,
			);
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

			// 0. Who is reading, decided BEFORE the read — because the read is a
			//    read. `GET /messages/{id}` marks the ACTING agent's delivery
			//    row, and an unheadered fetch from a multi-agent org names
			//    nobody and therefore marks nothing: the reply would land while
			//    the message it answers stayed queued forever. `read()` carries
			//    the header for exactly this reason and this call is the same
			//    fetch by another name.
			//
			//    The hint, not the sender: the sender is not known until the
			//    original has been read, and in the ordinary case — the addressee
			//    answering its own message — the two are the same agent anyway.
			//    With no hint at all the header is omitted and the server's
			//    single-agent fallback answers as it always did. Resolving it here
			//    also moves an unresolvable `opts.agent` to a refusal BEFORE the
			//    request, where it costs nothing; the agent list is fetched once
			//    and reused by step 2 below.
			const agents = await fetchAgents(core);
			const readerHint = opts.agent ?? this.defaultAgentHint();
			const readerId = readerHint
				? await this.resolveSenderId(core, readerHint, agents)
				: undefined;

			// 1. Fetch original to recover sender/recipient.
			const original = parse(
				MessageReadSchema,
				await core.get(
					`/messages/${messageId}`,
					undefined,
					readerId ? { [ACTING_AGENT_HEADER]: readerId } : undefined,
				),
			);
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
			//    to a message they themselves sent: `original.to_agent_id`
			//    points at the peer's agent, not one of ours. Skipping it lets
			//    the flow reach the "replying to your own message" guard below
			//    instead of failing earlier inside `resolveSenderId` with a
			//    confusing "not owned by current org" error.
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

			// 3b. Refuse a reply the actor is not entitled to author.
			//
			//     Only the agent a message was addressed to can answer it. When
			//     the caller names a different one — `opts.agent`, or the agent
			//     the client was constructed with — this used to be sent anyway
			//     and come back a 201 that said the wrong thing about who spoke.
			//     Refuse instead, and NAME the addressee: the caller's only
			//     question is which agent it should have been, and an unnamed
			//     failure sends it looking at the keystore.
			//
			//     Before the encrypt, deliberately — a reply nobody is entitled
			//     to author must not reach a key first.
			//
			//     Typed, because the Python SDK's twin is: a bare `Error` is not
			//     `instanceof RineError`, so the one refusal a caller is most
			//     likely to want to retry would be the one refusal that escapes
			//     the SDK-wide catch, and its three ids would be readable only by
			//     parsing the sentence.
			if (original.to_agent_id && senderId !== original.to_agent_id) {
				throw new ReplyAttributionError(
					messageId,
					senderId,
					original.to_agent_id,
				);
			}

			// 4. Encrypt to the original sender's public encryption key.
			const encrypted = await sealForAgent(
				core,
				this.http.configDir,
				{ senderAgentId: senderId, recipientAgentId: recipientId },
				payload,
			);

			const body: Record<string, unknown> = {
				type: opts.type ?? DEFAULT_REPLY_TYPE,
				content_type: opts.contentType ?? "application/json",
				// `...encrypted` carries `self_encrypted_payload` (the sender
				// self-seal from `sealForAgent`) onto the wire
				// for 1:1 replies — there is no body whitelist that would strip
				// it. The server persists it so the sender can later
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
					// The RESOLVED sender, not the caller's spelling. `/reply` now
					// files the reply from the acting agent rather than deriving one,
					// so a multi-agent org whose sender came from the original's
					// `to_agent_id` — a hint that never reached a header — would be
					// refused for naming nobody. This is the id the payload was just
					// sealed under, which is the one the header has to carry.
					extraHeaders: mergeHeaders(
						idempotencyHeader(opts.idempotencyKey),
						{ [ACTING_AGENT_HEADER]: senderId },
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
	 * Note: `/messages/sync` is 1:1 only, so a group is refused — by handle
	 * here, and by its own id in {@link syncSendTarget}.
	 */
	async sendAndWait(
		to: Recipient,
		payload: unknown,
		opts: SendAndWaitOptions = {},
	): Promise<SendAndWaitResult> {
		// The shared classification table, not `isGroupHandle`. That predicate is
		// a whole `#name@org` handle's shape, so the org-less `#ops` every other
		// surface refuses as a group used to fall past this guard and come back
		// `Invalid agent identifier '#ops'` from the AGENT namespace — one
		// spelling with two answers depending on which client a caller stood on.
		// `classifyReference` asks what the string names, which is this guard's
		// actual question, and it reads the RAW spelling: `#ops@` is a group as
		// written and is refused here rather than sealed, posted, and answered
		// with the server's `422`.
		if (classifyReference(to as string) === REF_CLASS.group) {
			throw new Error(GROUP_ON_WAIT_REFUSAL);
		}

		// Schema validation (request side) runs at the client-layer wrapper.
		// This resource receives an already-validated payload.
		const op = this.beginOp(opts.signal);
		try {
			const core = this.http.getCoreHttpClient({ signal: op.signal });
			const senderId = await this.resolveSenderId(core, opts.agent);

			// Build the full encrypted body — same as send() uses.
			const { body } = await this.buildSendBody(
				core,
				senderId,
				await this.syncSendTarget(core, to),
				payload,
				{
					type: opts.type,
					contentType: opts.contentType,
					metadata: opts.metadata,
				},
			);

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
						actingAgentHeader(opts.agent, senderId),
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
					memo: this.http.decryptMemo,
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
	 * `sendAndWait`'s recipient rule, which is deliberately not `send`'s.
	 *
	 * 🔴 NOT `resolveRecipient`. That door reads a bare word as a group, and
	 * `POST /messages/sync` is 1:1 only — routing `sendAndWait("ops")` through it
	 * would turn a syntactic refusal into a group send the server then rejects.
	 * So the bare and empty classes fall to the agent namespace here exactly as
	 * they always have, and this verb never resolves a recipient INTO a group.
	 *
	 * 🔴 **It only has to RECOGNISE one.** A UUID is the single spelling that
	 * reaches both namespaces, and this verb used to hand every one of them to
	 * `resolveToUuid` — so a group's own id was HPKE-sealed to an agent that does
	 * not exist and came back the server's bare `404: Agent not found`, on the
	 * five published surfaces that wrap this SDK. One key-scoped
	 * {@link readableGroupById} answers it, the same read `send` pays through
	 * `resolveRecipient`'s id rung and the same one `rine-mcp` pays through its
	 * ladder, and a 404/403 miss falls through to the agent rung below.
	 *
	 * 🔴 **Eager, and the lazy variant is rejected rather than unbuilt**: probing
	 * only after the 1:1 path had already answered `404` would save one GET on a
	 * verb that then long-polls for up to 300 s, and would buy two request orders
	 * for one question across two stacks. The Python twin is
	 * `RineClient._a_group_the_sync_endpoint_refuses`.
	 *
	 * `extraHeaders` is deliberately not passed, for the reason {@link send}
	 * gives at its own resolve: the probe is a key-scoped read, and
	 * `X-Rine-Agent` goes on `POST /messages/sync` alone.
	 *
	 * @throws {Error} The UUID names a group this org may read.
	 */
	private async syncSendTarget(
		core: CoreHttpClient,
		to: Recipient,
	): Promise<SendTarget> {
		const target = normalizeHandle(to as string);
		if (
			classifyReference(target) === REF_CLASS.id &&
			(await readableGroupById(core, target)) !== undefined
		) {
			throw new Error(GROUP_ON_WAIT_REFUSAL);
		}
		return {
			kind: "agent",
			agentId: await resolveToUuid(this.http.apiUrl, target),
		};
	}

	/**
	 * Build the `POST /messages` body with real E2EE output.
	 *
	 * - {@link SendTarget} `group` → `getOrCreateSenderKey` → `encryptGroupMessage`
	 *   (or the MLS branch) → body carries `to_handle` + the group envelope.
	 * - {@link SendTarget} `agent` → HPKE-seal with `sealForAgent` → body
	 *   carries `to_agent_id` + the 1:1 envelope.
	 *
	 * 🔴 It no longer decides WHICH of the two a recipient is, and that is the
	 * point of the record: the two verbs that build a body decide by different
	 * rules, and a shared classifier here handed both of them whichever rule it
	 * happened to hold. A group UUID reaches this method as a GROUP — the id
	 * rung inside `resolveRecipient` reads the group namespace first, so a UUID
	 * naming a group this org may read arrives here as `kind: "group"` carrying
	 * the row that rung fetched, and only a miss there falls through to the agent
	 * namespace.
	 *
	 * ⚠️ **The `group` arm has exactly one caller: {@link MessagesResource.send}.**
	 * {@link MessagesResource.syncSendTarget} reads the same UUID against the same
	 * group namespace and REFUSES it rather than addressing it, because
	 * `POST /messages/sync` is 1:1 — so `sendAndWait` reaches this method only
	 * with `kind: "agent"`. Two verbs, one reading of a string, two different
	 * things done with the answer; the record holds that asymmetry and it is not
	 * a case to unify.
	 */
	private async buildSendBody(
		core: CoreHttpClient,
		senderId: string,
		target: SendTarget,
		payload: unknown,
		opts: SendOptions,
	): Promise<{ body: Record<string, unknown>; escrowGroupId?: string }> {
		const base: Record<string, unknown> = {
			type: opts.type ?? DEFAULT_SEND_TYPE,
			content_type: opts.contentType ?? "application/json",
		};
		if (opts.metadata) base.metadata = opts.metadata;
		if (opts.parentConversationId)
			base.parent_conversation_id = opts.parentConversationId;
		if (opts.conversationMetadata)
			base.conversation_metadata = opts.conversationMetadata;

		if (target.kind === "group") {
			// The row the resolve already read: the server's account of this group's
			// encryption is the only one a client gets, and both the guard and the
			// branch below read it. `group.id` is the only MLS state key — never the
			// `mls_group_id` latch.
			const group = target.group;
			// 🔴 Everything downstream addresses the group the SERVER holds, never
			// the spelling the caller composed. `POST /messages` looks
			// `to_handle` up by exact equality, and the resolver's fallback
			// exists precisely because the two can differ — it resolves a
			// handle whose ORG half was
			// fabricated, the shape a model produces when it copies the domain out
			// of a tool description. Posting the spelling sends that fabrication:
			// the message is sealed for the right group and then refused with a bare
			// `Group not found`, which is indistinguishable from the ladder not
			// working at all. The resolve alone was never the whole fix.
			const groupHandle = group.handle;
			// The SEND question, not the render question; `groupAcceptsMlsSendOnly`
			// documents why `mls_group_id` alone walks into a server 409.
			const mlsOnly = groupAcceptsMlsSendOnly(group);

			// The guard goes HERE, between the resolve and the branch, because
			// reaching the sender-key branch has already leaked the key
			// (`assertNoMlsDowngrade`). No fallback and no sender-key retry.
			assertNoMlsDowngrade(this.http.configDir, senderId, group.id, mlsOnly);
			// Our org's rule refuses posts here: stop before a key leaves the machine.
			assertGroupPostable(group);

			if (mlsOnly) {
				// The row's handle, not the caller's spelling — the same argument the
				// `to_handle` comment above makes, and what `rine-mcp` already throws
				// (`tools/messaging.ts`). A caller who fabricated the org half used to
				// be told a group it never named was initialising.
				if (group.mls_group_id === null)
					throw new MlsInitInFlightError(groupHandle);
				const { result, escrowFp } = await this.encryptMlsWithRecovery(
					core,
					senderId,
					group.id,
					payload,
				);
				return {
					body: {
						...base,
						to_handle: groupHandle,
						...result,
						escrow_fp: escrowFp,
					},
					escrowGroupId: group.id,
				};
			}

			// Sender-key path. The rine-core helper carries X-Rine-Agent on its
			// distribution fan-out so multi-agent orgs route key distributions
			// through the right mailbox.
			const extraHeaders: Record<string, string> = {
				[ACTING_AGENT_HEADER]: senderId,
			};
			const { state, groupId } = await getOrCreateSenderKey(
				core,
				this.http.configDir,
				senderId,
				groupHandle,
				extraHeaders,
			);
			const { result } = await encryptGroupMessage(
				this.http.configDir,
				senderId,
				groupId,
				state,
				payload,
			);
			return { body: { ...base, to_handle: groupHandle, ...result } };
		}

		// 1:1 HPKE path. The id was resolved by whichever door the calling verb
		// asked (`resolveRecipient` for `send`, {@link syncSendTarget} for
		// `sendAndWait`); both reach `resolveToUuid`, which accepts a UUID
		// (pass-through) or an agent handle (WebFinger lookup).
		const recipientId = target.agentId;
		const encrypted = await sealForAgent(
			core,
			this.http.configDir,
			{ senderAgentId: senderId, recipientAgentId: recipientId },
			payload,
		);
		const body = {
			...base,
			to_agent_id: recipientId,
			// `...encrypted` carries `self_encrypted_payload` (the sender
			// self-seal from `sealForAgent`) on the 1:1 send
			// path. Group sends never reach here — `encryptGroupMessage`/
			// `encryptMlsGroupMessage` return an `EncryptResult` with no
			// `self_encrypted_payload`, so their `...result` spread carries
			// none (groups self-read via the key cache, not the self-blob).
			...encrypted,
		};
		return { body };
	}

	/** The acting agent as the escrow drain reaches the server. */
	private escrowActor(core: CoreHttpClient, senderId: string) {
		return {
			configDir: this.http.configDir,
			agentId: senderId,
			client: core,
			extraHeaders: { [ACTING_AGENT_HEADER]: senderId },
		};
	}

	/**
	 * MLS group send with a pre-sync and one-shot recovery.
	 *
	 * 🔴 **The pre-sync is a correctness step, not a nicety.** A member sends at
	 * whatever epoch its local state stands on, and a message sealed at a stale
	 * epoch is one every member who joined after that epoch can never open. This
	 * SDK was the only one of the three that did not do it — the CLI (through
	 * rine-core's `sealAndPostMlsGroupMessage`, `mls-group-send.ts`) and the
	 * Python SDK (`_mls/messages.py` `_sync_quietly`) both have, which is why an
	 * agent sending through this SDK could sit twenty-five commits behind a group it had joined AND sent into.
	 * Failures are swallowed: the recovery below answers the one that matters
	 * (no local state at all), and every other failure leaves the send exactly
	 * where it would have been.
	 *
	 * If the agent has no local MLS state for the group, install pending
	 * Welcomes + sync (epoch advance), then retry the encrypt once. Mirrors the
	 * sender-key auto-recovery in the read path. `encryption_version` is
	 * `"mls-v1"`, set by core — never overridden here.
	 */
	private async encryptMlsWithRecovery(
		core: CoreHttpClient,
		senderId: string,
		groupId: string,
		payload: unknown,
	): Promise<{
		result: Awaited<ReturnType<typeof encryptMlsGroupMessage>>;
		escrowFp: string;
	}> {
		await syncMlsGroup(this.http.configDir, senderId, groupId, core, {
			[ACTING_AGENT_HEADER]: senderId,
		}).catch(() => {});
		// The server refuses an mls-v1 send that does not name the fork
		// fingerprint of the sender's epoch, and the escrow is drained BEFORE the
		// encrypt: a drain that cannot run must not leave a spent ratchet
		// generation and a self-read entry for a message that was never posted,
		// and the fingerprint must name the epoch the ciphertext is built for.
		const attempt = async () => {
			const escrowFp = await prepareEscrowForSend(
				this.escrowActor(core, senderId),
				groupId,
			);
			const result = await encryptMlsGroupMessage(
				this.http.configDir,
				senderId,
				groupId,
				payload,
			);
			return { result, escrowFp };
		};
		try {
			return await attempt();
		} catch (err) {
			// The predicate rine-core owns, not a copy of its message text.
			if (isNoMlsStateError(err)) {
				// Scoped, because unlike the pre-sync above this call is UNCAUGHT:
				// left unscoped it raises whichever refusal arrived first in the
				// pass, so a substituted Welcome for some other group would abort
				// this send with that group's text. `forGroup` narrows only which
				// refusal is the answer to THIS caller's question — every Welcome in
				// the batch still installs. The Python twin reaches the same scoping
				// via `install_mls_state`.
				await processMlsWelcomes(this.http.configDir, senderId, core, {
					forGroup: groupId,
				});
				await syncMlsGroup(this.http.configDir, senderId, groupId, core, {
					[ACTING_AGENT_HEADER]: senderId,
				});
				return await attempt();
			}
			throw err;
		}
	}

	/**
	 * Resolve the sender agent to a UUID suitable for loading local keys.
	 *
	 * Precedence: explicit override → SDK default agent → single-agent
	 * shortcut (errors on multi-agent orgs). A one-agent org whose actor value
	 * names nobody acts as that agent and warns; a multi-agent one still
	 * refuses, because there is a choice only the caller can make.
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
		const resolved = await this.resolveSenderActor(
			core,
			explicit,
			preFetchedAgents,
		);
		// The one-agent fallback, on the surface where the actor is fixed by
		// the operator at construction and is not a model-visible parameter: the
		// audience for "you named X, Y acted" is whoever wired the client, so it
		// goes to the operator log the rest of this stack already warns on, not
		// onto a result the caller did not ask a question with. The one place it
		// is logged, so a caller holding the value object gets to choose again.
		if (resolved.warning !== undefined) console.warn(`rine: ${resolved.warning}`);
		return resolved.agentId;
	}

	/**
	 * {@link resolveSenderId}'s whole answer, including anything it has to say
	 * about the value it was given.
	 *
	 * Separate from `resolveSenderId` only so the note has exactly one
	 * production point: this one returns it, that one logs it. A surface that
	 * wants to render it itself (`AsyncRineClient.resolveActor`) takes this and
	 * logs nothing.
	 */
	async resolveSenderActor(
		core: CoreHttpClient,
		explicit: string | undefined,
		preFetchedAgents?: CoreAgentRead[],
	): Promise<ResolvedActor> {
		const hint = explicit ?? this.defaultAgentHint();
		const agents = preFetchedAgents ?? (await fetchAgents(core));
		// `ACTOR_SURFACES.ts`, not the default `cli`: this refusal is read by an
		// SDK caller who has no `--agent` flag to pass and no `RINE_AGENT` this
		// stack reads, so the CLI's wording would
		// name two levers that do not exist here.
		const resolved = await resolveAgent(
			agents,
			hint,
			undefined,
			ACTOR_SURFACES.ts,
		);
		if (!agents.some((a) => a.id === resolved.agentId)) {
			throw new Error(
				`Agent ${resolved.agentId} is not owned by the current org — cannot sign on its behalf. Pass an agent from your own org via opts.agent, or omit it to use the default.`,
			);
		}
		return resolved;
	}

	private defaultAgentHint(): string | undefined {
		return this.http.agentHeader?.[ACTING_AGENT_HEADER];
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

/**
 * Say so when the ID a caller sent to turned out to name a GROUP.
 *
 * 🔴 **The no-silent-acceptance rule, on this surface's own channel.** The id
 * rung reads the group namespace before the agent one, so a UUID copied out of
 * the wrong column no longer 404s — it seals for a group and reaches every
 * member ORG of it. That is the one substitution `resolveRecipient` makes which
 * the caller cannot have intended: an id names a namespace by accident, and
 * there is no agent of that UUID for it to have meant.
 *
 * 🔴 The id class ALONE. Every other spelling a group answers to — the sigil,
 * the short sigil, the bare name the collision guard already refuses when it is
 * also an agent's — is a caller choosing the group namespace, and a notice there
 * would ride every ordinary group send. `handleCompletionNote` covers the
 * separate case of a spelling completed within one namespace.
 *
 * `console.warn`, for {@link MessagesResource.resolveSenderId}'s reason and on
 * the same channel: the audience for "you addressed X, Y received it" is
 * whoever wired the client, and `send` answers with the server's own
 * `MessageRead` — there is no result slot of ours to hang a key on the way
 * `@rine-network/mcp` can. The SENTENCE is this surface's own and is
 * deliberately not hoisted into `@rine-network/core`
 * (`rine-cli/src/commands/messages-send-target.ts::groupIdRecipientNote` records why), and
 * it quotes the caller's spelling and the resolved handle, nothing else.
 */
function warnGroupIdRecipient(recipient: RecipientTarget): void {
	if (recipient.kind !== "group") return;
	if (classifyReference(recipient.spelling) !== REF_CLASS.id) return;
	// `handle` is optional on the record because the JOIN ladder's directory
	// rung answers with an id and no row; every rung `resolveRecipient` uses
	// carries one. Silence beats printing `undefined` in the slot the caller is
	// meant to read back.
	const { handle, spelling } = recipient;
	if (handle === undefined) return;
	console.warn(
		`rine: '${spelling}' is a group ID, so this was addressed to the group '${handle}' and not to an agent.`,
	);
}

function idempotencyHeader(
	key: string | undefined,
): Record<string, string> | undefined {
	// Server reads `Idempotency-Key` (no `X-` prefix) via FastAPI
	// `Header(alias="Idempotency-Key")` — see `send_message` in src/rine/api/messages_send_direct.py.
	if (!key) return undefined;
	return { "Idempotency-Key": key };
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
