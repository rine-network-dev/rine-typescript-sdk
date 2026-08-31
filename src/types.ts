/**
 * Branded domain types + Zod schemas co-located.
 *
 * Branded types prevent mixing handles, UUIDs, and group IDs at compile time.
 * Zod schemas serve as single source of truth for both runtime parsing and
 * static type inference (via `z.infer<typeof schema>`).
 *
 * NOTE: All datetime fields use ISO-8601 strings (not Date objects) to match
 * the API wire format.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Brand helpers
// ---------------------------------------------------------------------------

declare const BrandSymbol: unique symbol;
type Brand<T, B extends string = string> = T & { readonly [BrandSymbol]: B };

// ---------------------------------------------------------------------------
// Domain value types (branded)
// ---------------------------------------------------------------------------

/** Agent UUID — e.g. "550e8400-e29b-41d4-a716-446655440000" */
export type AgentUuid = Brand<string, "AgentUuid">;

/** Group UUID */
export type GroupUuid = Brand<string, "GroupUuid">;

/** Message UUID */
export type MessageUuid = Brand<string, "MessageUuid">;

/** Organisation UUID */
export type OrgUuid = Brand<string, "OrgUuid">;

/** Webhook UUID */
export type WebhookUuid = Brand<string, "WebhookUuid">;

/** Agent handle — e.g. "bot@acme" */
export type AgentHandle = Brand<string, "AgentHandle">;

/** Group handle — e.g. "#my-group@acme" */
export type GroupHandle = Brand<string, "GroupHandle">;

// ---------------------------------------------------------------------------
// Validation / coercion helpers
// ---------------------------------------------------------------------------

export const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_HANDLE_RE = /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9_.+-]+$/;
const GROUP_HANDLE_RE = /^#[a-zA-Z0-9_-]+@[a-zA-Z0-9_.+-]+$/;

export function isAgentHandle(s: string): s is AgentHandle {
	return AGENT_HANDLE_RE.test(s);
}

export function isGroupHandle(s: string): s is GroupHandle {
	return GROUP_HANDLE_RE.test(s);
}

export function asAgentUuid(s: string): AgentUuid {
	if (!UUID_RE.test(s)) throw new TypeError(`Invalid UUID: ${s}`);
	return s as AgentUuid;
}

export function asGroupUuid(s: string): GroupUuid {
	if (!UUID_RE.test(s)) throw new TypeError(`Invalid UUID: ${s}`);
	return s as GroupUuid;
}

export function asMessageUuid(s: string): MessageUuid {
	if (!UUID_RE.test(s)) throw new TypeError(`Invalid UUID: ${s}`);
	return s as MessageUuid;
}

export function asOrgUuid(s: string): OrgUuid {
	if (!UUID_RE.test(s)) throw new TypeError(`Invalid UUID: ${s}`);
	return s as OrgUuid;
}

export function asWebhookUuid(s: string): WebhookUuid {
	if (!UUID_RE.test(s)) throw new TypeError(`Invalid UUID: ${s}`);
	return s as WebhookUuid;
}

// ---------------------------------------------------------------------------
// MessageType — const-object enum
// ---------------------------------------------------------------------------

/**
 * Canonical rine message type strings.
 *
 * Use these rather than raw strings — IDE autocomplete + compile-time
 * validation + no typo-drift between consumers.
 */
export const MessageType = {
	// Generic DM (not in PROTOCOL.md but widely used by tests + MCP)
	Dm: "rine.v1.dm",

	// Task lifecycle
	TaskRequest: "rine.v1.task_request",
	TaskResponse: "rine.v1.task_response",
	StatusUpdate: "rine.v1.status_update",
	Negotiation: "rine.v1.negotiation",
	Receipt: "rine.v1.receipt",
	// `Error` shadows the global — use ErrorNotice
	ErrorNotice: "rine.v1.error",

	// Capabilities
	CapabilityQuery: "rine.v1.capability_query",
	CapabilityResponse: "rine.v1.capability_response",

	// Payments
	PaymentRequest: "rine.v1.payment_request",
	PaymentConfirmation: "rine.v1.payment_confirmation",

	// Consent
	ConsentRequest: "rine.v1.consent_request",
	ConsentGrant: "rine.v1.consent_grant",
	ConsentRevoke: "rine.v1.consent_revoke",

	// Identity
	IdentityVerification: "rine.v1.identity_verification",

	// Group E2EE management
	SenderKeyDistribution: "rine.v1.sender_key_distribution",
	SenderKeyRequest: "rine.v1.sender_key_request",
	GroupInvite: "rine.v1.group_invite",

	// Text (used by e2e tests)
	Text: "rine.v1.text",

	// Inbound Funnel webhook — a relayed external HTTP request delivered to the
	// agent's own inbox as a self-addressed message (from == to). The cleartext
	// hook name is carried in `metadata["rine.hook_name"]`.
	Webhook: "rine.v1.webhook",

	// A2A Protocol Bridge (forward-looking)
	A2AMessage: "a2a.v1.message",
} as const;

/** Union of the canonical `MessageType.*` values. */
export type KnownMessageType = (typeof MessageType)[keyof typeof MessageType];

/**
 * `MessageType` with an escape hatch for namespaced custom types. The
 * `string & {}` trick preserves autocomplete for the canonical union while
 * still accepting any other string.
 */
export type MessageTypeString = KnownMessageType | (string & {});

// ---------------------------------------------------------------------------
// ConversationStatus — const-object enum
// ---------------------------------------------------------------------------

export const ConversationStatus = {
	Submitted: "submitted",
	Open: "open",
	Paused: "paused",
	InputRequired: "input_required",
	Completed: "completed",
	Rejected: "rejected",
	Canceled: "canceled",
	Failed: "failed",
} as const;

export type ConversationStatusString =
	(typeof ConversationStatus)[keyof typeof ConversationStatus];

// ---------------------------------------------------------------------------
// JoinRequestStatus — const-object enum
// ---------------------------------------------------------------------------

export const JoinRequestStatus = {
	Pending: "pending",
	Approved: "approved",
	Denied: "denied",
	Expired: "expired",
} as const;

export type JoinRequestStatusString =
	(typeof JoinRequestStatus)[keyof typeof JoinRequestStatus];

// ---------------------------------------------------------------------------
// VoteChoice — const-object enum
// ---------------------------------------------------------------------------

export const VoteChoice = {
	Approve: "approve",
	Deny: "deny",
} as const;

export type VoteChoiceString = (typeof VoteChoice)[keyof typeof VoteChoice];

// ---------------------------------------------------------------------------
// VoteEligibility — const-object enum
// ---------------------------------------------------------------------------

/**
 * Why this caller's vote on a join request would, or would not, count.
 *
 * The server reports one of these on every listed request, and it predicts the
 * status `POST /groups/{id}/requests/{rid}/vote` would answer one-to-one:
 * `InElectorate` and `NotRecorded` → 200, `NotInElectorate` → 403 carrying the
 * same code, `ElectorateEmpty` and `BarUnreachable` → 403 carrying
 * `electorate_empty`, `IsApplicant` → 403, `AlreadyVoted` → 409, `NotPending`
 * → 422. A surface renders the reason so an agent can tell whether voting is
 * worth a call, without making the call and reading the refusal.
 *
 * `IsApplicant`'s 403 arrives in two shapes. The vote route is member-gated and
 * an applicant is ordinarily not a member, so the membership dependency answers
 * first with a bare refusal carrying no machine-readable `error` key. A caller
 * the group seated by some other route while its own request still stands
 * passes that dependency and reaches the vote's own refusal, which carries
 * `error: is_applicant` — the shape a surface branches on to report "this is
 * your own request" rather than "you are not in this group".
 *
 * The precedence the server applies, because ten surfaces have to agree on it:
 * `NotPending` → `IsApplicant` → `ElectorateEmpty`/`BarUnreachable` →
 * `NotInElectorate` → `AlreadyVoted` → `NotRecorded` → `InElectorate`.
 * `IsApplicant` and `NotInElectorate` deliberately outrank `AlreadyVoted`: if
 * the vote cannot count, that is the fact to report.
 */
export const VoteEligibility = {
	/** In the electorate: the vote counts. */
	InElectorate: "in_electorate",
	/** Filed before the server recorded electorates — any member may vote. */
	NotRecorded: "electorate_not_recorded",
	/** Not a member when the request was filed, so the vote cannot count. */
	NotInElectorate: "not_in_electorate",
	/** This caller has already voted; a second vote is refused. */
	AlreadyVoted: "already_voted",
	/** Nobody who was a member when it was filed is still in the group. */
	ElectorateEmpty: "electorate_empty",
	/**
	 * No electorate was recorded for this request and the bar is zero, so
	 * nobody can decide it. Distinct from `ElectorateEmpty`, which asserts
	 * something about a recorded set: this one is the honest answer for a row
	 * filed before electorates existed, where saying "the electorate is empty"
	 * states a fact about a set nobody ever wrote.
	 */
	BarUnreachable: "bar_unreachable",
	/**
	 * This is the caller's own request. It is not a refusal about the
	 * electorate — an applicant is simply not a member of the group yet — and
	 * it exists because reporting `NotInElectorate` there mis-predicted the
	 * refusal, which breaks the one invariant this vocabulary rests on.
	 */
	IsApplicant: "is_applicant",
	/** The request is no longer open for voting. */
	NotPending: "not_pending",
} as const;

export type VoteEligibilityReason =
	(typeof VoteEligibility)[keyof typeof VoteEligibility];

// ---------------------------------------------------------------------------
// WebhookJobStatus — const-object enum
// ---------------------------------------------------------------------------

export const WebhookJobStatus = {
	Pending: "pending",
	Processing: "processing",
	Delivered: "delivered",
	Failed: "failed",
	Dead: "dead",
} as const;

export type WebhookJobStatusString =
	(typeof WebhookJobStatus)[keyof typeof WebhookJobStatus];

// ---------------------------------------------------------------------------
// EncryptionVersion — const-object enum
// ---------------------------------------------------------------------------

export const EncryptionVersion = {
	HpkeV1: "hpke-v1",
	SenderKeyV1: "sender-key-v1",
} as const;

export type EncryptionVersionString =
	(typeof EncryptionVersion)[keyof typeof EncryptionVersion];

// Server-side regex from `src/rine/api/schemas.py::_validate_message_type`.
const MESSAGE_TYPE_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*){2,}$/;

/** Validate a custom message type against the server-side regex. */
export function isValidMessageType(s: string): boolean {
	return MESSAGE_TYPE_RE.test(s);
}

/**
 * Message types the E2EE layer consumes internally and that must NEVER
 * surface to user code. Enforced by `client.messages()` and `defineAgent`
 * via the `includeReserved` debug escape hatch.
 */
export const RESERVED_MESSAGE_TYPES: ReadonlySet<MessageTypeString> =
	new Set<MessageTypeString>([MessageType.SenderKeyDistribution]);

// ---------------------------------------------------------------------------
// Zod schemas — all API response types
// ---------------------------------------------------------------------------

// --- Org ---

export const OrgReadSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	slug: z.string().nullable().optional(),
	contact_email: z.string().nullable().optional(),
	country_code: z.string().nullable().optional(),
	trust_tier: z.number().int().default(0),
	agent_count: z.number().int().default(0),
	created_at: z.string().datetime(),
});
export type OrgRead = z.infer<typeof OrgReadSchema>;

// --- Agent ---

export const AgentReadSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	handle: z.string(),
	human_oversight: z.boolean().default(true),
	incoming_policy: z.string().default("accept_all"),
	outgoing_policy: z.string().default("send_all"),
	created_at: z.string().datetime(),
	revoked_at: z.string().datetime().nullable().optional(),
	unlisted: z.boolean().optional(),
	verification_words: z.string().nullable().optional(),
	warnings: z.array(z.string()).nullish(),
	poll_url: z.string().nullable().optional(),
});
export type AgentRead = z.infer<typeof AgentReadSchema>;

export const WhoAmISchema = z.object({
	org: OrgReadSchema,
	agents: z.array(AgentReadSchema),
	trust_tier: z.number().int().default(0),
});
export type WhoAmI = z.infer<typeof WhoAmISchema>;

// --- Messages ---

export const MessageReadSchema = z.object({
	id: z.string().uuid(),
	conversation_id: z.string().uuid(),
	from_agent_id: z.string().uuid().nullable().optional(),
	to_agent_id: z.string().uuid().nullable().optional(),
	sender_handle: z.string().nullable().optional(),
	recipient_handle: z.string().nullable().optional(),
	type: z.string(),
	encrypted_payload: z.string(),
	self_encrypted_payload: z.string().nullable().optional(),
	direction: z.enum(["sent", "received"]).optional(),
	encryption_version: z.string(),
	sender_signing_kid: z.string().nullable().optional(),
	content_type: z.string().nullable().optional(),
	metadata: z.record(z.unknown()).default({}),
	created_at: z.string().datetime(),
	delivered_at: z.string().datetime().nullable().optional(),
	read_at: z.string().datetime().nullable().optional(),
	status: z.enum(["new", "delivered", "read"]).optional(),
	group_id: z.string().uuid().nullable().optional(),
	group_handle: z.string().nullable().optional(),
});
export type MessageRead = z.infer<typeof MessageReadSchema>;

/**
 * Both-sided conversation thread page returned by
 * `GET /conversations/{id}/messages`. The server emits
 * `{ messages, truncated }` (ascending, oldest→newest) — NOT a cursor page —
 * so this is parsed directly rather than through `parseCursorPage`.
 */
export const ConversationMessagesPageSchema = z.object({
	messages: z.array(MessageReadSchema),
	truncated: z.boolean().default(false),
});
export type ConversationMessagesPage = z.infer<
	typeof ConversationMessagesPageSchema
>;

/**
 * Sender-signature verification outcome carried on a decrypted message.
 *
 * - `verified` — signed by the agent the server says sent the message.
 * - `invalid` — the signature does not check out against that agent's key.
 * - `sender-mismatch` — the signature is well-formed but names a different agent
 *   than the one the server authenticated as the sender.
 * - `unverifiable` — no verdict was reached (key lookup failed, the payload could
 *   not be opened, or the row carried no server-authenticated sender).
 *
 * `invalid` and `sender-mismatch` are authenticity failures: the message comes
 * back with no `plaintext` and a `decrypt_error` naming the failure, on 1:1 and
 * group messages alike, so bytes nobody is accountable for never reach your code
 * as text. `unverifiable` is the absence of a verdict rather than a finding
 * against the message, and a row that opened before the check could run still
 * carries its `plaintext` — untrusted, and `verified` is false.
 */
export const VerificationStatusSchema = z.enum([
	"verified",
	"invalid",
	"sender-mismatch",
	"unverifiable",
]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/**
 * A peer's published signing key differed from the copy this client had cached
 * when it verified this message. Fingerprints are hex SHA-256 over the raw
 * Ed25519 public key. Computed locally — never sent by the server.
 */
export const SenderKeyChangeSchema = z.object({
	agent_id: z.string(),
	previous_fingerprint: z.string(),
	current_fingerprint: z.string(),
});
export type SenderKeyChange = z.infer<typeof SenderKeyChangeSchema>;

/**
 * What reading a closed-group message did to this agent's MLS state.
 *
 * A read of a group whose regime is MLS advances that group's local state
 * first, and until now it did so silently: a member could apply thirty commits
 * on the way to opening one message and be told none of it. `processed` is how
 * many this read applied, `epoch` is where that left the local group, and
 * `evicted` is true when one of those commits removed this agent from the
 * tree — the correct outcome of a valid Remove, and the reason the row still
 * opens while the next send will not.
 *
 * It reports work, never distance. "You were N epochs behind" needs the group's
 * confirmed epoch from the server, a round trip this read does not otherwise
 * make; `groups.sync()` is where that question is asked and answered.
 *
 * Computed locally by rine-core, never sent by the server. Mirrors the Python
 * SDK's `GroupCatchUp`.
 */
export const GroupCatchUpSchema = z.object({
	processed: z.number(),
	epoch: z.number(),
	evicted: z.boolean(),
});
export type GroupCatchUp = z.infer<typeof GroupCatchUpSchema>;

export const DecryptedMessageSchema = MessageReadSchema.extend({
	plaintext: z.unknown().nullable().optional(),
	verified: z.boolean().default(false),
	verification_status: VerificationStatusSchema.default("unverifiable"),
	/**
	 * The signing key id carried inside the envelope, as read during
	 * verification. On a `verified` message this key belongs to `from_agent_id`;
	 * `null` on a row the client did not open and on a refused one. Distinct from
	 * the `sender_signing_kid` header, which the sender supplies and the server
	 * relays without checking.
	 */
	sender_kid: z.string().nullable().optional(),
	decrypt_error: z.string().nullable().optional(),
	/**
	 * Stable machine-readable cause for `decrypt_error`, set only where the SDK
	 * reached a NAMED verdict about why the row stayed closed. Absent on every
	 * other failure — a renderer must treat "no code" as "no claim", never as a
	 * default cause.
	 *
	 * It exists so a surface can pick how to say it without matching on the
	 * sentence: `decrypt_error` is prose meant for a reader and is free to be
	 * re-worded, this is the identity that survives that. The only value today is
	 * `SENDER_KEY_UNAVAILABLE_CODE` (`sender_key_unavailable`) — re-exported from
	 * this package, imported and compared against, never retyped.
	 *
	 * 🔴 It is a verdict, not a symptom: it is set only after the one-shot
	 * recovery has run and come back with nothing. A decrypt that never went
	 * looking (`retrySenderKey: false`) reports the same prose reason without a
	 * code, because it does not know the answer.
	 */
	decrypt_error_code: z.string().nullable().optional(),
	key_changed: SenderKeyChangeSchema.optional(),
	/**
	 * Present only on a closed-group row whose read ran an MLS catch-up. Absent
	 * therefore means "this read applied nothing" — never "you are current".
	 */
	catch_up: GroupCatchUpSchema.optional(),
});

/**
 * Decrypted message envelope. The `T` generic narrows `plaintext` end-to-end
 * when a `StandardSchemaV1<T>` is supplied to `read<T>`, `messages<T>`,
 * `sendAndWait<Req, Rep>`, `conversation(id).{messages,history}<T>`, or
 * `defineAgent<T>`.
 *
 * Default `T = unknown` forces callers to narrow before use. Without a
 * schema the runtime plaintext is whatever rine-core's decrypt helpers
 * returned (a string on the happy path, absent when `decrypt_error` is
 * populated — which includes every refused row) — the type stays `unknown`
 * so callers can't blindly treat it as a specific shape without opting in.
 *
 * The Zod-inferred shape is preserved on `DecryptedMessage<unknown>` for
 * all fields except `plaintext`, which is replaced with `T | null` so
 * `msg.plaintext` is assignment-compatible with the user's validated
 * output type.
 */
export type DecryptedMessage<T = unknown> = Omit<
	z.infer<typeof DecryptedMessageSchema>,
	"plaintext"
> & {
	plaintext?: T | null;
};

/**
 * One rendered turn in a conversation thread, as returned by
 * `client.conversation(id).thread()`.
 *
 * `text` is the decoded, human-readable message body (the `{text}` payload
 * shape connectors use is unwrapped to its string; any other plaintext is
 * stringified) or `"[unavailable]"` for a row the caller cannot decrypt (a
 * legacy sent message with no self-blob, or a decrypt failure). The same shape
 * is mirrored by the Python SDK's `ThreadEntry` so every surface renders the
 * transcript identically. Entries are ordered oldest→newest.
 *
 * One closed row does NOT read `"[unavailable]"`: a row sealed under a sender
 * key this agent never received says so, because it is the only failure here
 * the reader can act on. It is said in full on the first such row of a
 * transcript and as `SENDER_KEY_UNAVAILABLE_PREVIEW` on every later one, so a
 * long thread of them stays readable. Do not match on either string — the
 * machine-readable form of that fact is `decrypt_error_code` on the message.
 *
 * `verificationStatus` reports the sender-signature outcome for the row. A
 * received turn whose signature is `"invalid"` or whose author is a
 * `"sender-mismatch"` is fail-closed to `text: "[unavailable]"` (a turn that was
 * tampered with, or attributed to an agent that did not sign it, never renders
 * as trusted content), so downstream consumers that inject the transcript into a
 * model's context can also mark or exclude `"unverifiable"` turns.
 */
export interface ThreadEntry {
	direction: "sent" | "received";
	senderHandle: string | null;
	text: string;
	verificationStatus: VerificationStatus;
	type: string;
	createdAt: string;
}

/**
 * Wire-format Zod schema for `{ sent, reply }` — retained for symmetry with
 * the other `*Schema` exports even though the resource layer no longer calls
 * `parse(SendAndWaitResultSchema, …)` directly (Step 19 replaced that with
 * an explicit object literal so the generic `Rep` narrowing could flow
 * through). The hand-rolled `SendAndWaitResult<Rep>` below is the type
 * `client.sendAndWait<Req, Rep>()` returns; the two are structurally
 * equivalent at `Rep = unknown` but the Zod inference does not carry
 * the generic, so consumers that want typed plaintext should rely on
 * the function return type, not `z.infer<typeof SendAndWaitResultSchema>`.
 */
export const SendAndWaitResultSchema = z.object({
	sent: MessageReadSchema,
	// Server returns null reply on long-poll timeout (SyncMessageResponse.reply).
	// Callers that require a reply should check `result.reply !== null`.
	reply: DecryptedMessageSchema.nullable(),
});
/**
 * Result of `client.sendAndWait<Req, Rep>()`. The `Rep` generic narrows the
 * decrypted reply plaintext end-to-end when `opts.replySchema` is supplied.
 */
export type SendAndWaitResult<Rep = unknown> = {
	sent: MessageRead;
	reply: DecryptedMessage<Rep> | null;
};

// --- Groups ---

export const GroupReadSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	handle: z.string(),
	description: z.string().nullable().optional(),
	enrollment_policy: z.string().default("closed"),
	visibility: z.string().default("private"),
	isolated: z.boolean().default(false),
	vote_duration_hours: z.number().int().default(72),
	member_count: z.number().int().default(0),
	created_at: z.string().datetime(),
	// MLS group fields. `mls_group_id` is an opaque "MLS-active" latch:
	// non-null ⇒ the group uses MLS. It is never used as a storage key — the
	// rine group UUID (`id`) is the only MLS state key.
	mls_enabled: z.boolean().default(false),
	mls_group_id: z.string().nullable().default(null),
	mls_pending: z.boolean().default(false),
	mls_cipher_suite: z.number().int().nullable().default(null),
	// The group's running conversation — hand it to
	// `client.conversation(id).thread()` to read the group's backlog. This
	// schema is the ONLY thing that keeps the field: `z.object` strips what it
	// is not told about, so without this line the server's value never reaches
	// a caller (and never reaches `rine-eve`/`rine-mastra`, which infer their
	// `GroupRead` from here).
	//
	// A group's thread is created lazily on its first post, so `null` is a fact
	// — "nothing has been said in this group yet" — never an error. `.default`
	// makes a server that predates the field parse to that same `null` instead
	// of throwing the whole page away, which is why callers always read
	// `string | null` and never `undefined`.
	conversation_id: z.string().uuid().nullable().default(null),
	// Which of the CALLER'S OWN agents hold a seat in this group.
	//
	// `GET /groups` is org-scoped: it lists every group any agent of the org is
	// in, so the row alone never said whether the agent behind THIS call may act
	// in it. That is the question this answers, and it is answered per row, from
	// the same page the caller already has.
	//
	// The values are agent UUIDs, which is the actionable form: `X-Rine-Agent`
	// accepts a UUID or a handle, so an id off this list is a value a caller can
	// send back verbatim. An empty array is a FACT — no agent of this org is
	// seated — never a null and never an absence; `.default` keeps an older
	// server that omits the key parsing to that same empty array rather than
	// throwing the whole page away.
	//
	// 🔴 This is the WIRE, and the wire stays UUIDs. What the surfaces PRINT is
	// handles — resolved client-side against the org's own agent list by
	// `client.agentHandles()`, never smuggled onto this schema. Widening it to
	// accept a handle would make a rendering choice into a parse rule and hand
	// every consumer a field whose contents depend on which client filled it.
	// The render rule lives on `AgentHandleMap` in `resources/agent-handles.ts`.
	member_agent_ids: z.array(z.string().uuid()).default([]),
});
export type GroupRead = z.infer<typeof GroupReadSchema>;

export const GroupMemberSchema = z.object({
	id: z.string().uuid().nullable().optional(),
	group_id: z.string().uuid(),
	agent_id: z.string().uuid(),
	role: z.string().default("member"),
	joined_at: z.string().datetime(),
	agent_handle: z.string().nullable().optional(),
	// Whether this roster row is one of the caller's own org's agents.
	//
	// A MARKER, never a filter. `GET /groups/{id}/members` still returns every
	// member and `member_count` is still the whole roster — no surface may hide
	// the rows where this is false. `.default(false)` means an older server that
	// omits the key marks nothing rather than mis-marking every row as own.
	is_own_org: z.boolean().default(false),
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;

const JoinRequestReadFields = z.object({
	id: z.string().uuid(),
	group_id: z.string().uuid(),
	agent_id: z.string().uuid(),
	invited_by: z.string().uuid().nullable().optional(),
	message: z.string().nullable().optional(),
	status: z.string(),
	expires_at: z.string().datetime().nullable().optional(),
	created_at: z.string().datetime(),
	resolved_at: z.string().datetime().nullable().optional(),
	// How many members the group had when this request was filed. Reporting
	// only: the bar is computed against `electorate_size`, the ones who are
	// still in the group. It is what makes a shrunk group explainable — nine
	// when you applied, three still here, two approvals needed. Declared here
	// because `z.object` STRIPS what it is not told about: without this a voter
	// can see the approvals cast but never how far the group has moved. Null on
	// an invitation (nobody votes on one) and on any request filed before the
	// server recorded it, where the stored quorum or the live roster decides.
	quorum_total_members: z.number().int().nullable().optional(),
	// How many of those members are still in the group. THIS is the denominator
	// the bar comes from: majority needs more than half of it, unanimity all of
	// it. Null on an invitation, and on a request the server recorded no
	// electorate for. Zero means nobody who was there when it was filed is
	// still in the group, so no vote can decide it and it stands until it
	// expires.
	electorate_size: z.number().int().nullable().optional(),
	// The approvals and denials that COUNT — cast by agents in the electorate.
	// A vote from outside it is refused rather than recorded, so these are also
	// every vote there is. Null on an invitation.
	approvals: z.number().int().nullable().optional(),
	denials: z.number().int().nullable().optional(),
	// How many more approvals would resolve this request, already netted
	// against the ones cast. Null on an invitation, and when the electorate is
	// empty — there is no reachable bar to count down to.
	approvals_needed: z.number().int().nullable().optional(),
	// How many more denials would REFUSE it, on that same electorate — half of
	// it under majority, one under unanimity. Null exactly when
	// `approvals_needed` is, because the rule is "no bar is reachable" and not
	// "the number happens to be zero". Declared here for the same reason
	// `quorum_total_members` is: `z.object` STRIPS what it is not told about,
	// so without this line a voter reads the denials cast against a request and
	// cannot tell whether one more refuses it. It is the bar that moves under
	// them — the electorate shrinks as members leave, so a departure can refuse
	// a request nobody has voted on since.
	denials_needed: z.number().int().nullable().optional(),
	your_vote: z.string().nullable().optional(),
	// Whether THIS caller's vote would count right now, and why. Read the two
	// together with `your_vote`: `your_vote` records what was cast,
	// `you_may_vote` says whether it counts. The reason predicts the status the
	// vote route would answer, one-to-one — see {@link VoteEligibility}.
	//
	// Optional on the wire and always present on the parsed row: a server that
	// predates the electorate sends neither, and the transform below fills them
	// in from that server's own rule rather than leaving ten surfaces to each
	// invent a fallback. Loose `string` (as `status` and `enrollment_policy`
	// are), so a reason this SDK predates degrades to an unrecognised value
	// rather than throwing the page away.
	you_may_vote: z.boolean().optional(),
	you_may_vote_reason: z.string().optional(),
	// Enriched on the agent-scoped `GET /groups/invites` pull so an invitee can
	// display + act on an invite without a second round-trip. Absent on the
	// per-group `GET /groups/{id}/requests` listing.
	group_handle: z.string().nullable().optional(),
	group_name: z.string().nullable().optional(),
});

/**
 * What a server that predates the electorate implies about a row it said
 * nothing about, resolved from `status` — which is the same derivation the
 * Python twin `rine.vote_words.vote_eligibility_reason` makes.
 *
 * A flat `electorate_not_recorded` default was wrong on exactly one population
 * and it is the one this schema meets most: an **invitation**. Nobody votes on
 * one, `POST …/vote` answers 422 "Request is no longer pending", and every
 * surface rendering the row told the agent "you can vote". That breaks the one
 * invariant the whole read model is built on — the reason predicts the refusal,
 * one-to-one.
 */
function impliedVoteReason(status: string): string {
	return status === JoinRequestStatus.Pending
		? VoteEligibility.NotRecorded
		: VoteEligibility.NotPending;
}

export const JoinRequestReadSchema = JoinRequestReadFields.transform((r) => {
	const reason = r.you_may_vote_reason ?? impliedVoteReason(r.status);
	return {
		...r,
		you_may_vote:
			r.you_may_vote ??
			(reason === VoteEligibility.InElectorate ||
				reason === VoteEligibility.NotRecorded),
		you_may_vote_reason: reason,
	};
});
export type JoinRequestRead = z.infer<typeof JoinRequestReadSchema>;

export const JoinedResultSchema = z.object({
	status: z.literal("joined"),
	member: GroupMemberSchema,
});
export const PendingJoinResultSchema = z.object({
	status: z.literal("pending"),
	request: JoinRequestReadSchema,
});
export const JoinResultSchema = z.discriminatedUnion("status", [
	JoinedResultSchema,
	PendingJoinResultSchema,
]);
export type JoinResult = z.infer<typeof JoinResultSchema>;

export const InviteResultSchema = z.object({
	status: z.string(),
	request_id: z.string().uuid().nullable().optional(),
});
export type InviteResult = z.infer<typeof InviteResultSchema>;

export const GroupSummarySchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	handle: z.string(),
	description: z.string().nullable().optional(),
	// A directory result is the one place a stranger decides whether to knock.
	// Without this the server's policy is parsed away and every discovered group
	// looks alike, so a self-joinable group cannot be told from one that will
	// make the caller wait for a vote. Loose `string` (as `GroupReadSchema`), so
	// a policy this SDK predates degrades to an unrecognised value rather than
	// throwing the whole page away.
	enrollment_policy: z.string().default("closed"),
	visibility: z.string().default("public"),
	member_count: z.number().int().default(0),
});
export type GroupSummary = z.infer<typeof GroupSummarySchema>;

export const VoteResponseSchema = z.object({
	request_id: z.string().uuid(),
	your_vote: z.string(),
	status: z.string(),
	// Whether this vote also minted the applicant's ratchet-tree leaf and
	// Welcome. **Derived by this client, never sent by the server** — the server
	// holds no MLS keys and its response carries no seat field, so `vote()`
	// overwrites whatever parsed here.
	//
	// `undefined` means no seat was attempted: the vote was a deny, it did not
	// cross the threshold, it carried a nomination whose subject has not
	// consented — which answers `invited` and seats nobody, so there is nothing
	// to mint until the nominee accepts — or this client cannot do MLS at all. A
	// surface that reads this enumeration back must carry the `invited` case: the
	// bar *was* crossed there, and reporting "it did not cross the threshold"
	// states the opposite. `false` means one
	// was and it did not happen — the group runs Sender Keys and has no tree, the
	// add commit failed, or the applicant published no key package. A surface
	// that says "their leaf and Welcome were minted" must condition on `true`.
	mls_seated: z.boolean().optional(),
});
export type VoteResponse = z.infer<typeof VoteResponseSchema>;

// --- Discovery ---

export const AgentSummarySchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	handle: z.string(),
	description: z.string().nullable().optional(),
	category: z.string().nullable().optional(),
	verified: z.boolean().default(false),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const AgentProfileSchema = z.object({
	id: z.string().uuid(),
	name: z.string(),
	handle: z.string(),
	description: z.string().nullable().optional(),
	category: z.string().nullable().optional(),
	verified: z.boolean().default(false),
	human_oversight: z.boolean().default(true),
	created_at: z.string().datetime().nullable().optional(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentCardSchema = z.object({
	id: z.string().uuid(),
	agent_id: z.string().uuid(),
	name: z.string(),
	description: z.string().nullable().optional(),
	version: z.string().nullable().optional(),
	is_public: z.boolean().default(false),
	skills: z.array(z.record(z.unknown())).optional().default([]),
	rine: z.record(z.unknown()).optional().default({}),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime().nullable().optional(),
});
export type AgentCardRead = z.infer<typeof AgentCardSchema>;

// --- Webhooks ---

export const WebhookReadSchema = z.object({
	id: z.string().uuid(),
	agent_id: z.string().uuid(),
	url: z.string(),
	active: z.boolean().default(true),
	created_at: z.string().datetime(),
});
export type WebhookRead = z.infer<typeof WebhookReadSchema>;

export const WebhookCreatedSchema = WebhookReadSchema.extend({
	secret: z.string(),
});
export type WebhookCreated = z.infer<typeof WebhookCreatedSchema>;

export const WebhookDeliveryReadSchema = z.object({
	id: z.string().uuid(),
	webhook_id: z.string().uuid(),
	message_id: z.string().uuid(),
	status: z.string(),
	attempts: z.number().int().default(0),
	max_attempts: z.number().int().default(5),
	last_error: z.string().nullable().optional(),
	created_at: z.string().datetime(),
	delivered_at: z.string().datetime().nullable().optional(),
	next_attempt_at: z.string().datetime().nullable().optional(),
});
export type WebhookDeliveryRead = z.infer<typeof WebhookDeliveryReadSchema>;

export const WebhookJobSummarySchema = z.object({
	total: z.number().int().default(0),
	delivered: z.number().int().default(0),
	failed: z.number().int().default(0),
	dead: z.number().int().default(0),
	pending: z.number().int().default(0),
	processing: z.number().int().default(0),
});
export type WebhookJobSummary = z.infer<typeof WebhookJobSummarySchema>;

// --- Quotas ---

export const QuotaEntrySchema = z.object({
	limit: z.number().int().nullable(),
	// `used` is omitted for per-resource quotas (e.g. max_webhooks_per_agent)
	// where a single org-level aggregate doesn't make sense.
	used: z.number().int().nullable().optional(),
});
export type QuotaEntry = z.infer<typeof QuotaEntrySchema>;

export const OrgQuotasSchema = z.object({
	tier: z.number().int(),
	quotas: z.record(QuotaEntrySchema),
});
export type OrgQuotas = z.infer<typeof OrgQuotasSchema>;

// --- Poll Tokens ---

export const PollTokenResponseSchema = z.object({
	poll_url: z.string(),
});
export type PollTokenResponse = z.infer<typeof PollTokenResponseSchema>;

// --- SSE Events ---

// The server emits `message`, `heartbeat`, `status`; the SDK synthesizes
// `disconnect` on stream close. `ack` is intentionally absent (the server
// never emits it). `data` is the raw event string — higher-level typed
// payloads are not currently surfaced on this envelope.
export const RineEventSchema = z.object({
	type: z.enum(["message", "heartbeat", "status", "disconnect"]),
	data: z.string(),
	id: z.string().nullable().optional(),
});
export type RineEvent = z.infer<typeof RineEventSchema>;

// --- Erasure (GDPR) ---

export const ErasureResultSchema = z.object({
	org_id: z.string().uuid(),
	erased_at: z.string().datetime(),
	messages_deleted: z.number().int(),
	agents_deleted: z.number().int(),
	conversations_deleted: z.number().int(),
	groups_deleted: z.number().int().default(0),
});
export type ErasureResult = z.infer<typeof ErasureResultSchema>;

// --- Pagination helpers ---

export const PaginatedResponseSchema = <T extends z.ZodTypeAny>(
	itemSchema: T,
) =>
	z.object({
		items: z.array(itemSchema),
		// Server sends `total_estimate` (see DirectorySearchResponse).
		// Older endpoints still emit `total`; accept both so the SDK stays
		// decoupled from the exact field name.
		total_estimate: z.number().int().nullish(),
		total: z.number().int().nullish(),
		next_cursor: z.string().nullable().optional(),
		prev_cursor: z.string().nullable().optional(),
	});

/**
 * CursorPage raw response schema — used by adapters.parsePaginated().
 * This is NOT a generic schema; it accepts a Zod schema for the item type
 * and returns the full paginated response schema.
 */
export function cursorPageSchema<T extends z.ZodTypeAny>(itemSchema: T) {
	return PaginatedResponseSchema(itemSchema);
}
