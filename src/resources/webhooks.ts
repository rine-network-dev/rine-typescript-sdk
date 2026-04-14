/**
 * Webhooks resource — create, list, update, delete, deliveries.
 *
 * `create()` takes the required `agentId` + optional `events` list per the
 * server schema; `update()` accepts only the `active` toggle.
 */

import { parse, parseCursorPage } from "../api/adapters.js";
import type { SDKHttpClient } from "../api/http.js";
import {
	WebhookCreatedSchema,
	WebhookDeliveryReadSchema,
	WebhookJobSummarySchema,
	WebhookReadSchema,
} from "../types.js";
import type { AgentUuid, WebhookUuid } from "../types.js";

// ---------------------------------------------------------------------------
// WebhooksResource
// ---------------------------------------------------------------------------

export class WebhooksResource {
	constructor(private readonly http: SDKHttpClient) {}

	/**
	 * Register a webhook.
	 *
	 * Route: `POST /webhooks` with body `{agent_id, url, events?}`.
	 * `agent_id` is required by the server schema.
	 */
	async create(
		agentId: AgentUuid,
		url: string,
		opts: { events?: readonly string[]; signal?: AbortSignal } = {},
	) {
		const body: Record<string, unknown> = { agent_id: agentId, url };
		if (opts.events !== undefined) body.events = opts.events;

		const raw = await this.http.post<unknown>("/webhooks", body, {
			signal: opts.signal,
			operation: "webhooksCreate",
		});
		return parse(WebhookCreatedSchema, raw);
	}

	async list(
		opts: {
			agentId?: AgentUuid;
			includeInactive?: boolean;
			signal?: AbortSignal;
		} = {},
	) {
		const raw = await this.http.get<unknown>("/webhooks", {
			params: {
				agent_id: opts.agentId,
				include_inactive: opts.includeInactive,
			},
			signal: opts.signal,
			operation: "webhooksList",
		});
		return parseCursorPage(WebhookReadSchema, raw);
	}

	/**
	 * Toggle a webhook's active flag.
	 *
	 * Body restricted to `{active}` per server schema.
	 */
	async update(
		id: WebhookUuid,
		opts: { active: boolean; signal?: AbortSignal },
	) {
		const raw = await this.http.patch<unknown>(
			`/webhooks/${id}`,
			{ active: opts.active },
			{ signal: opts.signal, operation: "webhooksUpdate" },
		);
		return parse(WebhookReadSchema, raw);
	}

	async delete(id: WebhookUuid): Promise<void> {
		await this.http.delete(`/webhooks/${id}`, { operation: "webhooksDelete" });
	}

	async deliveries(
		id: WebhookUuid,
		opts: {
			status?: "pending" | "processing" | "delivered" | "failed" | "dead";
			limit?: number;
			offset?: number;
			signal?: AbortSignal;
		} = {},
	) {
		const raw = await this.http.get<unknown>(`/webhooks/${id}/deliveries`, {
			params: {
				status: opts.status,
				limit: opts.limit,
				offset: opts.offset,
			},
			signal: opts.signal,
			operation: "webhooksDeliveries",
		});
		return parseCursorPage(WebhookDeliveryReadSchema, raw);
	}

	/**
	 * Aggregated delivery counts for a webhook.
	 *
	 * Route: `GET /webhooks/{id}/deliveries/summary`.
	 */
	async deliverySummary(id: WebhookUuid, opts: { signal?: AbortSignal } = {}) {
		const raw = await this.http.get<unknown>(
			`/webhooks/${id}/deliveries/summary`,
			{
				signal: opts.signal,
				operation: "webhooksDeliverySummary",
			},
		);
		return parse(WebhookJobSummarySchema, raw);
	}
}
