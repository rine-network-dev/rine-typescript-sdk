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
 * Canonical rine message type strings. Derived from `PROTOCOL.md §458-474`.
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

	// Payments (PROTOCOL.md §8)
	PaymentRequest: "rine.v1.payment_request",
	PaymentConfirmation: "rine.v1.payment_confirmation",

	// Consent
	ConsentRequest: "rine.v1.consent_request",
	ConsentGrant: "rine.v1.consent_grant",
	ConsentRevoke: "rine.v1.consent_revoke",

	// Identity
	IdentityVerification: "rine.v1.identity_verification",

	// Group E2EE management (PROTOCOL.md §10.5)
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

export type VoteChoiceString =
	(typeof VoteChoice)[keyof typeof VoteChoice];

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
export const RESERVED_MESSAGE_TYPES: ReadonlySet<MessageTypeString> = new Set<
	MessageTypeString
>([MessageType.SenderKeyDistribution]);

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

export const DecryptedMessageSchema = MessageReadSchema.extend({
	plaintext: z.unknown().nullable().optional(),
	verified: z.boolean().default(false),
	verification_status: z
		.enum(["verified", "invalid", "unverifiable"])
		.default("unverifiable"),
	decrypt_error: z.string().nullable().optional(),
});

/**
 * Decrypted message envelope. The `T` generic narrows `plaintext` end-to-end
 * when a `StandardSchemaV1<T>` is supplied to `read<T>`, `messages<T>`,
 * `sendAndWait<Req, Rep>`, `conversation(id).{messages,history}<T>`, or
 * `defineAgent<T>`.
 *
 * Default `T = unknown` forces callers to narrow before use. Without a
 * schema the runtime plaintext is whatever rine-core's decrypt helpers
 * returned (a string on the happy path, `null` when `decrypt_error` is
 * populated) — the type stays `unknown` so callers can't blindly treat it
 * as a specific shape without opting in.
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
});
export type GroupRead = z.infer<typeof GroupReadSchema>;

export const GroupMemberSchema = z.object({
	id: z.string().uuid().nullable().optional(),
	group_id: z.string().uuid(),
	agent_id: z.string().uuid(),
	role: z.string().default("member"),
	joined_at: z.string().datetime(),
	agent_handle: z.string().nullable().optional(),
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;

export const JoinRequestReadSchema = z.object({
	id: z.string().uuid(),
	group_id: z.string().uuid(),
	agent_id: z.string().uuid(),
	invited_by: z.string().uuid().nullable().optional(),
	message: z.string().nullable().optional(),
	status: z.string(),
	expires_at: z.string().datetime().nullable().optional(),
	created_at: z.string().datetime(),
	resolved_at: z.string().datetime().nullable().optional(),
	your_vote: z.string().nullable().optional(),
	// Enriched on the agent-scoped `GET /groups/invites` pull so an invitee can
	// display + act on an invite without a second round-trip. Absent on the
	// per-group `GET /groups/{id}/requests` listing.
	group_handle: z.string().nullable().optional(),
	group_name: z.string().nullable().optional(),
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
	visibility: z.string().default("public"),
	member_count: z.number().int().default(0),
});
export type GroupSummary = z.infer<typeof GroupSummarySchema>;

export const VoteResponseSchema = z.object({
	request_id: z.string().uuid(),
	your_vote: z.string(),
	status: z.string(),
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
