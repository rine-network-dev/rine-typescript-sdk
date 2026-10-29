/**
 * @rine-network/sdk — TypeScript SDK for Rine E2E-encrypted messaging.
 *
 * Public exports:
 * - AsyncRineClient
 * - All error classes
 * - Branded domain types (AgentUuid, AgentHandle, etc.)
 * - Zod schemas (for advanced / testing use)
 * - CursorPage utility
 */

// ---------------------------------------------------------------------------
// Registration (module-level, pre-client)
// ---------------------------------------------------------------------------

export { register, validateSlug } from "./onboard.js";
export type { RegisterOptions, RegistrationResult } from "./onboard.js";
export {
	agentNameFromOrgName,
	runOnboardFlow,
	stdoutOnboardIO,
} from "./onboard-runner.js";
export type { OnboardIO, OnboardOptions } from "./onboard-runner.js";
export { onboardUsage, parseOnboardArgs } from "./onboard-args.js";
export type { OnboardConnector } from "./onboard-args.js";
export { runOnboardCli } from "./onboard-cli.js";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export { AsyncRineClient } from "./client.js";
export type {
	RineClientOptions,
	SendOptions,
	SendAndWaitOptions,
	InboxOptions,
	ReadOptions,
	ReplyOptions,
	ThreadOptions,
	StreamOptions,
	WatchOptions,
	MessagesOptions,
} from "./client.js";

// ---------------------------------------------------------------------------
// Agentic layer
// ---------------------------------------------------------------------------

export { defineAgent } from "./agent.js";
export type {
	DefineAgentOptions,
	AgentHandler,
	AgentMessageContext,
	AgentErrorContext,
	RineAgent,
} from "./agent.js";

export type {
	CreateAgentOptions,
	CreateAgentResult,
	VerifyIdentityOptions,
	UpdateAgentPatch,
	UpdateOrgPatch,
	EraseOrgOptions,
	AgentCardInput,
} from "./resources/identity.js";
// `client.agentHandles()`'s return type. Exported because a host that renders
// `member_agent_ids` threads the map through its own renderers and has to name
// it — `rine-mastra` and `rine-eve` both do. The rule those renderers follow is
// stated on the type itself.
export type { AgentHandleMap } from "./resources/agent-handles.js";
// SPIFFE identity verification result + client-side error, re-exported from
// rine-core so SDK callers can type results and `instanceof`-branch failures.
export type { VerifyIdentityResult } from "@rine-network/core";
export { SpiffeVerificationError } from "@rine-network/core";
export type {
	DiscoveryFilters,
	DiscoverGroupsOptions,
} from "./resources/discovery.js";
// Every public shape a group call can return, and the one refusal a caller has
// to branch on. Absent from this file, a third-party consumer could not name
// the return type of `groups.invite([...])` or `groups.removeMember()`, and
// could not `instanceof`- or predicate-branch the evicted-agent refusal — only
// match on message text. That gap had already produced two independent
// re-declarations of the admission report shape in packages that consume this
// SDK.
export type {
	GroupAdmissionEntry,
	GroupAdmissionReport,
	GroupAdmissionSkipReason,
	GroupCreateOptions,
	GroupCreateResult,
	GroupInviteReport,
	// What `groups.sync()` actually returns: the union, not one of its arms. A
	// caller that can only name `MlsRecoveryResult` cannot type the result at
	// all, and would narrow by which fields are present — the exact reading the
	// `regime` discriminant exists to stop.
	GroupRecoveryResult,
	GroupRemovalResult,
	GroupUpdateOptions,
	InviteOptions,
	MlsAdmissionResult,
	MlsInitFailure,
	MlsReclamationDecline,
	MlsReclamationDeclineReason,
	MlsReclamationResult,
	MlsRecoveryResult,
	OutstandingFilter,
	SenderKeyRecoveryResult,
} from "./resources/groups.js";
// The per-agent halves of an admission result. Without them a caller can hold
// `GroupCreateResult.mlsAdmission` and still not name what it iterates, which
// is the gap that produced two re-declarations of the report shape.
export type {
	MlsAdmissionOutcome,
	MlsAdmissionSkipReason,
} from "@rine-network/core";
// What `groups.resolveRef()` answers with, and what the verbs that read a group
// accept. Both have to be nameable: a consumer that stores a resolved group, or
// writes a helper taking "a group", cannot type either without them — and
// `GroupSelector` is the type that says which verbs take the record and which
// take the id alone.
export type {
	GroupSelector,
	ResolvedGroup,
} from "./resources/groups-resolve.js";
// `groups.sync()` is subject to the same rule: without its error class and
// predicate here, a consumer can only match the refusal on the raw code string
// and cannot name what the verb returns.
export {
	GROUP_EVICTED_CODE,
	GroupEvictedError,
	MlsResyncUnavailableError,
	VISIBILITY_REQUIRED_MESSAGE,
	admissionHeadline,
	groupAdmissionSkipSentence,
	isGroupEvictedError,
	isMlsResyncUnavailable,
	mlsAdmissionSkipSentence,
} from "./resources/groups.js";

// ---------------------------------------------------------------------------
// x402 payments
// ---------------------------------------------------------------------------

export { PaymentsResource } from "./resources/payments.js";
export type {
	PayOptions,
	PayResult,
	QuoteOptions,
	FulfillOptions,
	FulfillResult,
	VerifySettleOptions,
} from "./resources/payments.js";
export { createX402Fetch } from "./resources/x402-fetch.js";
export type { X402FetchOptions } from "./resources/x402-fetch.js";
export {
	extractPaymentRequired,
	extractPaymentPayload,
} from "./resources/x402-extract.js";
// Re-export the x402 wire types + typed constants + build/parse helpers from
// rine-core so SDK consumers get the whole x402 surface from one import.
export {
	X402_MESSAGE_TYPE,
	X402_STATUS,
	X402_MODE,
	X402_METADATA_KEY,
	X402_RAIL,
	X402_VERSION,
	X402_CONTENT_TYPE,
	X402Error,
	X402_ERROR,
	buildPaymentRequiredMessage,
	buildPaymentMessage,
	buildReceiptMessage,
	buildPaymentPayload,
	selectRequirement,
	enforcePolicy,
	isAutoPayable,
	parseX402Payload,
	x402ThreadStatus,
	readX402Marker,
	isX402MessageType,
	FACILITATOR_PRESET,
	X402FacilitatorError,
	verifyPayment,
	settlePayment,
	facilitatorRequestBody,
} from "@rine-network/core";
export type {
	PaymentRequired,
	PaymentPayload,
	PaymentRequirements,
	SettlementResponse,
	PaymentPolicy,
	X402Marker,
	X402Status,
	X402Mode,
	X402MessageType,
	Eip3009Authorization,
	FacilitatorConfig,
	FacilitatorCallOptions,
	VerifyResponse,
} from "@rine-network/core";

export { ConversationScope } from "./resources/conversation.js";
export type {
	ConversationSendOptions,
	ConversationReplyOptions,
	ConversationMessagesOptions,
	ConversationHistoryOptions,
} from "./resources/conversation.js";

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export type {
	RineMiddleware,
	RequestContext,
	RineOperation,
	LoggingMiddlewareOptions,
} from "./api/middleware.js";
export { composeMiddleware, loggingMiddleware } from "./api/middleware.js";

// ---------------------------------------------------------------------------
// Standard Schema v1 integration
// ---------------------------------------------------------------------------

export type { StandardSchemaV1 } from "@standard-schema/spec";
// `validateOutbound` is intentionally not re-exported — it's a one-line
// internal wrapper over `parsePlaintext` that marks the pre-encrypt call
// site. Users who want to pre-validate a payload call `parsePlaintext`.
export { parsePlaintext, parseMessagePlaintext } from "./utils/schema.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export {
	RineError,
	RineApiError,
	AuthenticationError,
	AuthorizationError,
	PrincipalRevokedError,
	RevokedScope,
	NotFoundError,
	ConflictError,
	RateLimitError,
	ValidationError,
	InternalServerError,
	ServiceUnavailableError,
	RineTimeoutError,
	APIConnectionError,
	CryptoError,
	ConfigError,
	SchemaValidationError,
	GroupIdentityMismatchError,
	// Client-side, before the encrypt: the acting agent is not the addressee of
	// the message being answered. Carries the three ids so a caller can retry as
	// the addressee without reading the sentence.
	ReplyAttributionError,
	// Which refusal a `RineApiError` is, without matching on its sentence. The
	// vote route answers two different 403s (`not_in_electorate` and
	// `electorate_empty`) and a caller that cannot tell them apart can only
	// string-match the detail, which is exactly what the code exists to stop.
	rineErrorCode,
} from "./errors.js";

// The two refusals `messages.send()` raises for a group are declared in
// `rine-core` — one definition serves the CLI, the MCP server and this SDK —
// and are re-exported here so an SDK-only consumer never has to depend on
// `@rine-network/core` to branch on them. Both are `instanceof RineError`.
// Branch on the CODE or the predicate; the message text is for an operator.
//
// 🔴 `isGroupIdentityMismatchError` is here for a sharper reason:
// `groups.resolveRef` resolves through `rine-core`'s UUID rung, so the
// substitution refusal a consumer catches there is minted by `rine-core`. There
// is exactly one class of that name — this package re-exports the core one
// rather than declaring a second — so `instanceof
// GroupIdentityMismatchError` is true for it and for `groups.get`'s throw
// alike, and `instanceof RineError` is true for both as well, on the base
// widening `errors-core-refusals.ts` holds. The predicate stays exported for
// the consumer who would rather branch on a stable code than on a class.
export {
	AGENT_ID_MISMATCH_CODE,
	AgentIdMismatchError,
	DOWNGRADE_REFUSED_CODE,
	ESCROW_GAP_CODE,
	EscrowGapError,
	GROUP_IDENTITY_MISMATCH_CODE,
	MLS_INIT_IN_FLIGHT_CODE,
	MLS_PENDING_SELF_CLEAR_SECONDS,
	MlsDowngradeError,
	MlsInitInFlightError,
	ORG_MISMATCH_CODE,
	OrgMismatchError,
	isAgentIdMismatchError,
	isEscrowGapError,
	isGroupIdentityMismatchError,
	isMlsDowngradeError,
	isMlsInitInFlightError,
	isOrgMismatchError,
	isPrincipalRevokedError,
} from "@rine-network/core";

// How a join request is decided, in the one sentence every rine surface
// renders, and what an invite to a group under a given policy actually does.
// Both are declared in `rine-core` — the CLI and the MCP server reach them
// without this SDK — and re-exported here for the same reason the two refusals
// above are: an SDK-only consumer must not have to add a second dependency to
// render the rule its own `groups.vote()` is governed by, and a consumer that
// re-words the sentence itself is how a model comes to believe a rule the
// server does not implement.
export { VOTE_ELECTORATE_RULE, inviteNominates } from "@rine-network/core";

// The clause a request row carries for the reading agent's own standing, one
// per `you_may_vote_reason`. Re-exported for the same reason as the rule above:
// a wrapper that keeps its own copy of the table drifts from the CLI and the
// Python twin the day a clause is reworded. Each surface passes only what it
// prints where the server's answer leaves a gap.
export {
	VOTE_ELIGIBILITY_CLAUSES,
	type VoteEligibilityFallbacks,
	describeVoteEligibility,
} from "@rine-network/core";

// The two sentences a group refusal carries its own answer in. `matchGroupByName`
// lists the groups the key can see inline when a reference resolves to none of them, and
// `NO_GROUPS_IN_ORG` is the arm for an org that holds a seat nowhere.
//
// Re-exported because a wrapper surface has to branch on them to know when NOT
// to say "run the verb that lists your groups": naming that verb underneath its
// own output is advice to fetch what the caller is already reading, and models
// were measured parroting that hint back instead of acting on it. Imported,
// never retyped — a wrapper that restates the sentence goes silently stale the
// day this one is reworded, and its own suite reads green either way.
export { GROUP_ROSTER_LEAD, NO_GROUPS_IN_ORG } from "@rine-network/core";

// The notice a group-reading surface carries so a caller learns that the org's
// readers can read the group. Re-exported so an SDK-only consumer building its own
// tool descriptions imports the sentence rather than retyping it.
export { GROUP_READERS_NOTICE } from "@rine-network/core";

// The vocabulary of the one decrypt failure that has something for the reader
// to do about it, and the render policy that keeps it from becoming noise.
// Re-exported for the same reason as the block above — an SDK-only consumer
// branches on `decrypt_error_code === SENDER_KEY_UNAVAILABLE_CODE` and prints
// the sentence the SDK already handed it, without a second dependency and
// without re-wording either.
//
// `senderKeyExplainer()` is the ONE implementation of "explain once, then
// mark": call it once per render, feed it each row's `decrypt_error`, print
// what it hands back. A surface that re-implements that rule is how eight
// unopenable rows become eight copies of the same paragraph.
// `senderKeyExplanation(row)` is the row-shaped half of the same rule: it
// answers which rows the explainer is even for, reading the typed code rather
// than the sentence. A renderer holding a row wants that one; a renderer
// holding a bare error string wants `senderKeyExplainer` alone.
export {
	SENDER_KEY_UNAVAILABLE_CODE,
	SENDER_KEY_UNAVAILABLE_PREVIEW,
	senderKeyExplainer,
	senderKeyExplanation,
} from "@rine-network/core";
export type {
	SenderKeyExplained,
	SenderKeyExplainer,
	SenderKeyRefusedRow,
} from "@rine-network/core";

// ---------------------------------------------------------------------------
// Domain types (branded)
// ---------------------------------------------------------------------------

export {
	type AgentUuid,
	type GroupUuid,
	type MessageUuid,
	type OrgUuid,
	type WebhookUuid,
	type AgentHandle,
	type GroupHandle,
	type MessageRead,
	type DecryptedMessage,
	type SendAndWaitResult,
	type ThreadEntry,
	type VerificationStatus,
	type ErasureResult,
	type KnownMessageType,
	type MessageTypeString,
	type ConversationStatusString,
	type JoinRequestStatusString,
	type VoteChoiceString,
	// What `groups.listRequests()` returns and what `groups.vote()` answers.
	// Absent from here, a caller could not name the row it iterates — which is
	// how two consuming packages ended up re-deriving it from the schema — and
	// could not read the electorate a request is decided by off a typed value.
	type JoinRequestRead,
	type VoteResponse,
	// Whether the reading agent's own vote on a request would count, and why.
	// The reason predicts the status the vote route answers, so a surface can
	// render the refusal before spending the call.
	type VoteEligibilityReason,
	type WebhookJobStatusString,
	type EncryptionVersionString,
	// The response shapes whose *schemas* this file already re-exports below.
	// Without the type a consumer can hold what `whoami()`, `groups.get()`,
	// `groups.list()`, `groups.members()`, `discover()`, `inspect()` and
	// `discoverGroups()` return and still not name it — which is how two
	// packages that consume this SDK came to re-derive three of them locally
	// with `z.infer<>`. Same class as `MlsRecoveryResult`.
	type WhoAmI,
	type WhoAmIPrincipal,
	WhoAmIPrincipalKind,
	type GroupRead,
	type GroupMember,
	type GroupSummary,
	type AgentSummary,
	type AgentProfile,
	MessageType,
	ConversationStatus,
	JoinRequestStatus,
	VoteChoice,
	VoteEligibility,
	WebhookJobStatus,
	EncryptionVersion,
	RESERVED_MESSAGE_TYPES,
	isValidMessageType,
	isAgentHandle,
	isGroupHandle,
	asAgentUuid,
	asGroupUuid,
	asMessageUuid,
	asOrgUuid,
	asWebhookUuid,
} from "./types.js";

// ---------------------------------------------------------------------------
// Group predicates (one definition per language; integrations re-export these
// rather than deciding "is this MLS?" for themselves)
// ---------------------------------------------------------------------------

export {
	groupAcceptsMlsSendOnly,
	groupIsMls,
	groupMlsInitInFlight,
	groupMlsNeverFounded,
	unfoundedGroupNote,
} from "./format/groups.js";
export type { UnfoundedGroupRepair } from "./format/groups.js";

// ---------------------------------------------------------------------------
// Zod schemas (named exports, for advanced / testing use)
// ---------------------------------------------------------------------------

export {
	// Agent
	AgentReadSchema,
	// Message
	MessageReadSchema,
	DecryptedMessageSchema,
	SendAndWaitResultSchema,
	// Org
	OrgReadSchema,
	WhoAmISchema,
	// Erasure
	ErasureResultSchema,
	// Groups
	GroupReadSchema,
	GroupMemberSchema,
	JoinResultSchema,
	InviteResultSchema,
	GroupSummarySchema,
	JoinRequestReadSchema,
	VoteResponseSchema,
	// Discovery
	AgentSummarySchema,
	AgentProfileSchema,
	AgentCardSchema,
	// Webhooks
	WebhookReadSchema,
	WebhookCreatedSchema,
	WebhookDeliveryReadSchema,
	// Quotas & Poll
	OrgQuotasSchema,
	QuotaEntrySchema,
	PollTokenResponseSchema,
	// Pagination
	cursorPageSchema,
	// Adapter helpers
	parse,
	parseCursorPage,
} from "./api/adapters.js";

// RineEventSchema is defined in types.ts — export it directly
export { RineEventSchema } from "./types.js";

export { z } from "./api/adapters.js";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export { CursorPage } from "./utils/cursor-page.js";
export { timeoutSignal, anySignal } from "./utils/abort.js";
export { toAsyncIter } from "./utils/sse.js";

// Type-level API surface stability pins — evaluated at build time via tsc but
// not part of the public API surface. The unused import forces tsc to
// type-check the pins inside `_parity.ts`, catching method drift at build time.
import type { SurfacePins as _SurfacePins } from "./_parity.js";
