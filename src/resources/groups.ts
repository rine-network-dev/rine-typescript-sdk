/**
 * Groups resource — create, get, list, join, members, invite,
 * update, delete, removeMember, listRequests, vote.
 *
 * Step 10 — Track B: routes + bodies aligned with server endpoints per
 * SPEC §10.6. Handle-resolution (`_resolveGroupAsync`) is not added here
 * (Step 11+), so UUID-only parameters remain the current limit.
 */

import { parse, parseCursorPage } from "../api/adapters.js";
import type { SDKHttpClient } from "../api/http.js";
import {
	GroupMemberSchema,
	GroupReadSchema,
	InviteResultSchema,
	JoinRequestReadSchema,
	VoteResponseSchema,
} from "../types.js";
import type {
	AgentUuid,
	GroupUuid,
	JoinRequestRead,
	JoinResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface GroupCreateOptions {
	description?: string;
	enrollment?: "open" | "closed" | "majority" | "unanimity";
	visibility?: "public" | "private";
	signal?: AbortSignal;
}

export interface InviteOptions {
	message?: string;
	signal?: AbortSignal;
}

export interface GroupUpdateOptions {
	description?: string;
	enrollment?: "open" | "closed" | "majority" | "unanimity";
	visibility?: "public" | "private";
	voteDurationHours?: number;
	signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// GroupsResource
// ---------------------------------------------------------------------------

export class GroupsResource {
	constructor(private readonly http: SDKHttpClient) {}

	async list() {
		const raw = await this.http.get<unknown>("/groups", {
			operation: "groupsList",
		});
		return parseCursorPage(GroupReadSchema, raw);
	}

	/**
	 * Create a new group. Two call styles:
	 *
	 *   client.groups.create('my-group', { visibility: 'public' })
	 *   client.groups.create({ name: 'my-group', visibility: 'public' })
	 *
	 * The options-bag form matches the rest of the SDK surface (`inbox`,
	 * `discover`, `sendAndWait`) and is the recommended ergonomic for
	 * first-time users; the positional form is kept for existing callers.
	 */
	async create(
		nameOrOpts: string | ({ name: string } & GroupCreateOptions),
		maybeOpts: GroupCreateOptions = {},
	) {
		const { name, opts } =
			typeof nameOrOpts === "string"
				? { name: nameOrOpts, opts: maybeOpts }
				: { name: nameOrOpts.name, opts: nameOrOpts };

		const body: Record<string, unknown> = { name };
		if (opts.description !== undefined) body["description"] = opts.description;
		if (opts.enrollment !== undefined)
			body["enrollment_policy"] = opts.enrollment;
		if (opts.visibility !== undefined) body["visibility"] = opts.visibility;

		const raw = await this.http.post<unknown>("/groups", body, {
			signal: opts.signal,
			operation: "groupsCreate",
		});
		return parse(GroupReadSchema, raw);
	}

	async get(groupId: GroupUuid) {
		const raw = await this.http.get<unknown>(`/groups/${groupId}`, {
			operation: "groupsGet",
		});
		return parse(GroupReadSchema, raw);
	}

	/**
	 * Update group metadata.
	 *
	 * Route: `PATCH /groups/{id}` with body of camelCase → snake_case
	 * mapped fields. Previously missing from the TS SDK.
	 */
	async update(groupId: GroupUuid, opts: GroupUpdateOptions) {
		const body: Record<string, unknown> = {};
		if (opts.description !== undefined) body["description"] = opts.description;
		if (opts.enrollment !== undefined)
			body["enrollment_policy"] = opts.enrollment;
		if (opts.visibility !== undefined) body["visibility"] = opts.visibility;
		if (opts.voteDurationHours !== undefined)
			body["vote_duration_hours"] = opts.voteDurationHours;

		const raw = await this.http.patch<unknown>(`/groups/${groupId}`, body, {
			signal: opts.signal,
			operation: "groupsUpdate",
		});
		return parse(GroupReadSchema, raw);
	}

	/**
	 * Delete a group (owner only). Previously missing from the TS SDK.
	 */
	async delete(
		groupId: GroupUuid,
		opts: { signal?: AbortSignal } = {},
	): Promise<void> {
		await this.http.delete(`/groups/${groupId}`, {
			signal: opts.signal,
			operation: "groupsDelete",
		});
	}

	async join(
		groupId: GroupUuid,
		opts: { message?: string; signal?: AbortSignal } = {},
	): Promise<JoinResult> {
		const body: Record<string, unknown> = {};
		if (opts.message !== undefined) body["message"] = opts.message;
		const res = await this.http.postWithStatus<unknown>(
			`/groups/${groupId}/join`,
			body,
			{ signal: opts.signal, operation: "groupsJoin" },
		);
		if (res.status === 202) {
			return {
				status: "pending" as const,
				request: parse(JoinRequestReadSchema, res.body),
			};
		}
		const member = parse(GroupMemberSchema, res.body);
		return { status: "joined", member } as JoinResult;
	}

	async invite(
		groupId: GroupUuid,
		agentId: AgentUuid,
		opts?: InviteOptions,
	) {
		const raw = await this.http.post<unknown>(
			`/groups/${groupId}/invite`,
			{
				agent_id: agentId,
				...(opts?.message && { message: opts.message }),
			},
			{ signal: opts?.signal, operation: "groupsInvite" },
		);
		return parse(InviteResultSchema, raw);
	}

	/**
	 * Remove a member from a group. Previously missing from the TS SDK.
	 *
	 * Route: `DELETE /groups/{groupId}/members/{agentId}`.
	 */
	async removeMember(
		groupId: GroupUuid,
		agentId: AgentUuid,
		opts: { signal?: AbortSignal } = {},
	): Promise<void> {
		await this.http.delete(`/groups/${groupId}/members/${agentId}`, {
			signal: opts.signal,
			operation: "groupsRemoveMember",
		});
	}

	async members(groupId: GroupUuid) {
		const raw = await this.http.get<unknown>(`/groups/${groupId}/members`, {
			operation: "groupsMembers",
		});
		return parseCursorPage(GroupMemberSchema, raw);
	}

	/**
	 * List pending join requests for a group.
	 *
	 * Route: `GET /groups/{groupId}/requests` (fixes parity gap — TS
	 * previously used `/join-requests`). Returns a plain array to match
	 * Python SDK `groups.list_requests`.
	 */
	async listRequests(groupId: GroupUuid): Promise<readonly JoinRequestRead[]> {
		const raw = await this.http.get<unknown>(`/groups/${groupId}/requests`, {
			operation: "groupsListRequests",
		});
		const page = parseCursorPage(JoinRequestReadSchema, raw);
		return page.items;
	}

	/**
	 * Vote on a pending join request (fixes audit C-adjacent — missing
	 * group segment).
	 *
	 * Route: `POST /groups/{groupId}/requests/{requestId}/vote`.
	 */
	async vote(
		groupId: GroupUuid,
		requestId: string,
		choice: "approve" | "deny",
	) {
		const raw = await this.http.post<unknown>(
			`/groups/${groupId}/requests/${requestId}/vote`,
			{ vote: choice },
			{ operation: "groupsVote" },
		);
		return parse(VoteResponseSchema, raw);
	}
}
