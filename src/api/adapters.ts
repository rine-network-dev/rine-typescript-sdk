/**
 * Zod response adapters for all API types.
 *
 * Every API response is parsed through its Zod schema here before being
 * returned to SDK consumers. This ensures:
 * - Unknown fields are stripped (no leaky passthrough)
 * - Type safety is enforced at runtime
 * - Errors are raised early (not buried in business logic)
 *
 * Usage:
 * ```ts
 * const raw = await http.get('/agents');
 * const agent = parse(AgentReadSchema, raw);
 * ```
 *
 * For paginated responses, use parseCursorPage():
 * ```ts
 * const raw = await http.get('/directory/agents');
 * return parseCursorPage(AgentSummarySchema, raw);
 * ```
 */

import type { z } from "zod";
import {
	AgentCardSchema,
	AgentProfileSchema,
	AgentReadSchema,
	AgentSummarySchema,
	DecryptedMessageSchema,
	ErasureResultSchema,
	GroupMemberSchema,
	GroupReadSchema,
	GroupSummarySchema,
	InviteResultSchema,
	JoinRequestReadSchema,
	JoinResultSchema,
	MessageReadSchema,
	OrgQuotasSchema,
	OrgReadSchema,
	PaginatedResponseSchema,
	PollTokenResponseSchema,
	QuotaEntrySchema,
	SendAndWaitResultSchema,
	VoteResponseSchema,
	WebhookCreatedSchema,
	WebhookDeliveryReadSchema,
	WebhookJobSummarySchema,
	WebhookReadSchema,
	WhoAmISchema,
	cursorPageSchema,
} from "../types.js";
import { CursorPage } from "../utils/cursor-page.js";
import type { CursorPage as CursorPageType } from "../utils/cursor-page.js";

export { z } from "zod";

// ---------------------------------------------------------------------------
// Re-export all schemas for direct use
// ---------------------------------------------------------------------------

export {
	AgentReadSchema,
	AgentCardSchema,
	AgentProfileSchema,
	AgentSummarySchema,
	DecryptedMessageSchema,
	ErasureResultSchema,
	GroupMemberSchema,
	GroupReadSchema,
	GroupSummarySchema,
	InviteResultSchema,
	JoinRequestReadSchema,
	JoinResultSchema,
	MessageReadSchema,
	OrgQuotasSchema,
	OrgReadSchema,
	PaginatedResponseSchema,
	PollTokenResponseSchema,
	QuotaEntrySchema,
	SendAndWaitResultSchema,
	VoteResponseSchema,
	WebhookCreatedSchema,
	WebhookDeliveryReadSchema,
	WebhookJobSummarySchema,
	WebhookReadSchema,
	WhoAmISchema,
	cursorPageSchema,
};

// ---------------------------------------------------------------------------
// Adapter helpers
// ---------------------------------------------------------------------------

/**
 * Parse a raw API response through a Zod schema.
 * Throws ZodError with descriptive messages on validation failure.
 */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
	return schema.parse(data);
}

/**
 * Parse a raw paginated API response into a CursorPage instance.
 *
 * The raw response shape: { items: T[], total, next_cursor?, prev_cursor? }
 * We validate each item through the provided schema, then construct a CursorPage.
 *
 * @param itemSchema - Zod schema for each item in the items array.
 * @param raw        - Raw API response (unknown).
 *
 * @example
 * ```ts
 * const raw = await http.get<unknown>('/directory/agents', { params: { q: 'bot' } });
 * return parseCursorPage(AgentSummarySchema, raw);
 * ```
 */
export function parseCursorPage<S extends z.ZodType>(
	itemSchema: S,
	raw: unknown,
): CursorPageType<z.infer<S>> {
	const responseSchema = cursorPageSchema(itemSchema);
	const parsed = responseSchema.parse(raw);

	return new CursorPage(
		parsed.items as z.infer<S>[],
		parsed.total_estimate ?? parsed.total ?? parsed.items.length,
		parsed.next_cursor ?? null,
		parsed.prev_cursor ?? null,
	);
}
