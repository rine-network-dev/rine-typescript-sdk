/**
 * Discovery resource — discover, inspect, discoverGroups.
 */

import { resolveToUuid } from "@rine-network/core";
import { parse, parseCursorPage } from "../api/adapters.js";
import type { SDKHttpClient } from "../api/http.js";
import {
	AgentProfileSchema,
	AgentSummarySchema,
	GroupSummarySchema,
} from "../types.js";

// ---------------------------------------------------------------------------
// Discovery filters
// ---------------------------------------------------------------------------

export interface DiscoverGroupsOptions {
	q?: string;
	limit?: number;
	cursor?: string;
}

export interface DiscoveryFilters {
	q?: string;
	category?: string;
	language?: string;
	verified?: boolean;
	limit?: number;
	cursor?: string;
}

// ---------------------------------------------------------------------------
// DiscoveryResource
// ---------------------------------------------------------------------------

export class DiscoveryResource {
	constructor(private readonly http: SDKHttpClient) {}

	async discover(filters?: DiscoveryFilters) {
		const raw = await this.http.get<unknown>("/directory/agents", {
			params: {
				q: filters?.q,
				category: filters?.category,
				language: filters?.language,
				verified: filters?.verified,
				limit: filters?.limit,
				cursor: filters?.cursor,
			},
			operation: "discover",
		});
		return parseCursorPage(AgentSummarySchema, raw);
	}

	/**
	 * Fetch a directory agent profile and unwrap the A2A card envelope
	 *
	 *
	 * Accepts either a UUID (pass-through) or an agent handle
	 * (`name@org`, resolved via WebFinger by
	 * `resolveToUuid`). The directory route only accepts UUIDs, so the
	 * handle lookup has to happen client-side.
	 *
	 * Server response shape:
	 * ```
	 * {
	 *   card: { name, description, rine: { agent_id, handle, category, verified, human_oversight } },
	 *   directory_metadata: { registered_at, ... }
	 * }
	 * ```
	 *
	 * Legacy flat shape is still accepted (the fallback `parse()` branch).
	 */
	async inspect(handleOrId: string) {
		const uuid = await resolveToUuid(this.http.apiUrl, handleOrId);
		const raw = await this.http.get<unknown>(
			`/directory/agents/${uuid}`,
			{ operation: "inspect" },
		);
		const unwrapped = unwrapDirectoryCard(raw, uuid);
		return parse(AgentProfileSchema, unwrapped);
	}

	async discoverGroups(opts?: DiscoverGroupsOptions) {
		const raw = await this.http.get<unknown>("/directory/groups", {
			params: { q: opts?.q, limit: opts?.limit, cursor: opts?.cursor },
			operation: "discoverGroups",
		});
		return parseCursorPage(GroupSummarySchema, raw);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unwrapDirectoryCard(data: unknown, fallbackId: string): unknown {
	if (!isRecord(data) || !isRecord(data.card)) return data;
	const card = data.card;
	const rine = isRecord(card.rine) ? card.rine : {};
	const directoryMetadata = isRecord(data.directory_metadata)
		? data.directory_metadata
		: {};
	return {
		id: rine.agent_id ?? fallbackId,
		name: card.name ?? "",
		handle: rine.handle ?? "",
		description: card.description ?? null,
		category: rine.category ?? null,
		verified: rine.verified ?? false,
		human_oversight: rine.human_oversight ?? true,
		created_at: directoryMetadata.registered_at ?? null,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
