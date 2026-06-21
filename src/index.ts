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
// Registration (module-level, pre-client) — REQ-01, REQ-02, REQ-03
// ---------------------------------------------------------------------------

export { register, validateSlug } from "./onboard.js";
export type { RegisterOptions, RegistrationResult } from "./onboard.js";

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
	AddPostQuantumKeyOptions,
	CreateAgentOptions,
	UpdateAgentPatch,
	UpdateOrgPatch,
	EraseOrgOptions,
	AgentCardInput,
} from "./resources/identity.js";
export type {
	DiscoveryFilters,
	DiscoverGroupsOptions,
} from "./resources/discovery.js";
export type {
	GroupCreateOptions,
	GroupUpdateOptions,
} from "./resources/groups.js";

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
export {
	composeMiddleware,
	loggingMiddleware,
} from "./api/middleware.js";

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
} from "./errors.js";

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
	type WebhookJobStatusString,
	type EncryptionVersionString,
	MessageType,
	ConversationStatus,
	JoinRequestStatus,
	VoteChoice,
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
