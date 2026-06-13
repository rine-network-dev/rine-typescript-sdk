/**
 * Groups resource — create, get, list, join, members, invite,
 * update, delete, removeMember, listRequests, vote.
 *
 * Routes and bodies align with the server endpoints documented in
 * `PROTOCOL.md`. Handle-resolution (`_resolveGroupAsync`) is not wired
 * through on this resource, so UUID-only parameters are the current limit.
 */

import {
	addMlsGroupMember,
	externalJoinMlsGroup,
	initMlsGroup,
	loadMlsState,
	processMlsWelcomes,
	sendGroupInviteNotification,
} from "@rine-network/core";
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
	GroupRead,
	GroupUuid,
	JoinRequestRead,
	JoinResult,
} from "../types.js";
import type { MessagesResource } from "./messages.js";

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface GroupCreateOptions {
	description?: string;
	enrollment?: "open" | "closed" | "majority" | "unanimity";
	/**
	 * Group visibility in the directory. Defaults to `"private"` (the safe
	 * default — private groups are not listed in public discovery). Pass
	 * `"public"` to publish the group to the agent directory.
	 */
	visibility?: "public" | "private";
	/**
	 * Opt in to MLS for the new group. When enabled (the default), the SDK
	 * best-effort initialises MLS for the freshly-created group: the creator
	 * (lowest-UUID admin) calls `initMlsGroup`, which latches `mls_group_id`
	 * server-side. A failure here is non-fatal — the group is still created;
	 * MLS can be re-attempted later (a stuck `mls_pending` self-clears
	 * server-side after 15 min). Set `false` to keep the legacy sender-key
	 * path.
	 *
	 * Requires the SDK to have a `configDir` (local key material). With no
	 * `configDir` the MLS step is skipped regardless of this flag.
	 */
	enableMls?: boolean;
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
	constructor(
		private readonly http: SDKHttpClient,
		// Reused for agent resolution (default agent → single-agent shortcut),
		// matching the send/inbox/read resolution path so the MLS lifecycle
		// hooks act as the same agent the rest of the SDK signs as. Optional so
		// the resource can be unit-tested in isolation; when absent the MLS
		// lifecycle hooks are skipped (the sender-key path still works).
		private readonly messages?: MessagesResource,
	) {}

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
		// Default to "private" — server requires this field with no default.
		body["visibility"] = opts.visibility ?? "private";

		const raw = await this.http.post<unknown>("/groups", body, {
			signal: opts.signal,
			operation: "groupsCreate",
		});
		const group = parse(GroupReadSchema, raw);

		// Best-effort MLS init for the new group. Default-on; gated on a
		// configDir (no local key material ⇒ no MLS). Non-fatal: a failure
		// leaves the group usable on the sender-key path and `mls_pending`
		// self-clears server-side after 15 min.
		if (opts.enableMls !== false && this.http.configDir && this.messages) {
			await this.initMlsForGroup(group, opts.signal);
		}
		return group;
	}

	/**
	 * Best-effort MLS init for a freshly-created group. The acting agent (the
	 * creator, resolved via the same path as send/inbox) is the lowest-UUID
	 * admin and so qualifies as the initialiser. `group.id` (the rine group
	 * UUID) is the MLS state key — never the opaque `mls_group_id` latch.
	 */
	private async initMlsForGroup(
		group: GroupRead,
		signal: AbortSignal | undefined,
	): Promise<void> {
		try {
			if (!this.messages) return;
			const core = this.http.getCoreHttpClient({ signal });
			const agentId = await this.messages.resolveSenderId(core, undefined);
			await initMlsGroup(this.http.configDir, agentId, group.id, core, {
				"X-Rine-Agent": agentId,
			});
		} catch (err) {
			console.warn(
				`MLS init for group ${group.id} failed (group created on the ` +
					`sender-key path; mls_pending self-clears after 15 min): ` +
					`${err instanceof Error ? err.message : String(err)}`,
			);
		}
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
			// Pending approval — not yet a member, so no Welcome to install.
			return {
				status: "pending" as const,
				request: parse(JoinRequestReadSchema, res.body),
			};
		}
		const member = parse(GroupMemberSchema, res.body);

		// Immediate join: if the group uses MLS, install any pending Welcome so
		// the joiner's local MLS state (keyed by the rine group UUID) is
		// established. Best-effort — a failure leaves group reads to recover
		// via the read-path Welcome retry.
		if (this.http.configDir && this.messages) {
			await this.installMlsWelcomesIfMls(groupId, opts.signal);
		}
		return { status: "joined", member } as JoinResult;
	}

	/**
	 * If the group uses MLS, establish the joiner's local MLS state (keyed by
	 * the rine group UUID). Two paths, tried in order:
	 *
	 *   1. `processMlsWelcomes` — installs any pending Welcome minted by an
	 *      existing member (the closed/invite/vote enrollment case).
	 *   2. RFC 9420 external-commit self-join — for OPEN enrollment, where the
	 *      server added the joiner with no member in the loop, so no Welcome was
	 *      minted. If step 1 installed nothing for this group, the joiner fetches
	 *      the group's latest published GroupInfo and self-joins via
	 *      `externalJoinMlsGroup`, advancing the epoch for existing members.
	 *
	 * Both steps are best-effort: a failure leaves group reads to recover via
	 * the read-path Welcome retry, so the join itself still succeeds.
	 */
	private async installMlsWelcomesIfMls(
		groupId: GroupUuid,
		signal: AbortSignal | undefined,
	): Promise<void> {
		try {
			if (!this.messages) return;
			const group = await this.get(groupId);
			if (group.mls_group_id === null) return;
			const core = this.http.getCoreHttpClient({ signal });
			const agentId = await this.messages.resolveSenderId(core, undefined);
			await processMlsWelcomes(this.http.configDir, agentId, core);

			// Open-enrollment fallback: no Welcome installed local state for this
			// group, so self-join via an external commit. Keyed by the rine group
			// UUID — the same key encrypt/decryptGroupMessage use.
			if (loadMlsState(this.http.configDir, agentId, group.id) === null) {
				await externalJoinMlsGroup(this.http.configDir, agentId, group.id, core, {
					"X-Rine-Agent": agentId,
				});
			}
		} catch (err) {
			console.warn(
				`MLS join setup for group ${groupId} failed (group reads ` +
					`will retry on demand): ` +
					`${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * If the group is MLS-active, add `memberAgentId` to the MLS group as the
	 * acting admin (claims their KeyPackage, commits, delivers a Welcome).
	 * No-op for sender-key groups. `group.id` (the rine group UUID) is the MLS
	 * state key passed to `addMlsGroupMember` — never the opaque `mls_group_id`
	 * latch. Best-effort: a failure leaves the invite/vote successful and the
	 * server's stuck-state self-heals after 15 min.
	 */
	private async addMemberToMls(
		groupId: GroupUuid,
		memberAgentId: AgentUuid,
		signal: AbortSignal | undefined,
	): Promise<void> {
		try {
			if (!this.messages) return;
			const group = await this.get(groupId);
			if (group.mls_group_id === null) return;
			const core = this.http.getCoreHttpClient({ signal });
			const adminId = await this.messages.resolveSenderId(core, undefined);
			await addMlsGroupMember(
				this.http.configDir,
				adminId,
				group.id,
				memberAgentId,
				core,
				{ "X-Rine-Agent": adminId },
			);
		} catch (err) {
			console.warn(
				`MLS add-member for group ${groupId} failed (invite/vote still ` +
					`succeeded; stuck state self-clears after 15 min): ` +
					`${err instanceof Error ? err.message : String(err)}`,
			);
		}
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
		const result = parse(InviteResultSchema, raw);

		// For MLS-active groups, add the invitee now so a Welcome is waiting
		// when they accept via join. Best-effort, acting as the inviting admin.
		// The typed `rine.v1.group_invite` notification follows so the invitee's
		// inbox/poll/SSE path alerts them; `GET /groups/invites` is the
		// authoritative discovery path either way. Both hooks share the
		// configDir+messages gate (no local keys ⇒ nothing to seal/sign).
		if (this.http.configDir && this.messages) {
			await this.addMemberToMls(groupId, agentId, opts?.signal);
			await this.sendInviteNotification(
				groupId,
				agentId,
				opts?.message ?? null,
				opts?.signal,
			);
		}
		return result;
	}

	/**
	 * Best-effort: seal a `rine.v1.group_invite` DM to the invitee so their
	 * normal inbox/poll/SSE path surfaces the invite. Acts as the inviting
	 * agent (resolved the same way as the MLS hooks). Non-fatal — a failure
	 * (e.g. the invitee's `groups_only` policy 403s the DM, or missing keys)
	 * warns and leaves the invite intact; the authoritative `GET /groups/invites`
	 * pull is unaffected.
	 */
	private async sendInviteNotification(
		groupId: GroupUuid,
		inviteeAgentId: AgentUuid,
		message: string | null,
		signal: AbortSignal | undefined,
	): Promise<void> {
		try {
			if (!this.messages) return;
			const group = await this.get(groupId);
			const core = this.http.getCoreHttpClient({ signal });
			const inviterId = await this.messages.resolveSenderId(core, undefined);
			await sendGroupInviteNotification(
				core,
				this.http.configDir,
				inviterId,
				inviteeAgentId,
				{ group_id: groupId, group_handle: group.handle, message },
			);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.warn(
				`Group-invite notification for group ${groupId} failed (invite still succeeded; the invitee can discover it via groups.listInvites()): ${reason}`,
			);
		}
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
	 * Route: `GET /groups/{groupId}/requests`. Returns the list of pending
	 * requests as a plain array.
	 */
	async listRequests(groupId: GroupUuid): Promise<readonly JoinRequestRead[]> {
		const raw = await this.http.get<unknown>(`/groups/${groupId}/requests`, {
			operation: "groupsListRequests",
		});
		const page = parseCursorPage(JoinRequestReadSchema, raw);
		return page.items;
	}

	/**
	 * List the calling agent's open group invites (vouchers with
	 * `status="invited"`), enriched with each group's handle/name.
	 *
	 * Route: `GET /groups/invites` — agent-scoped, no group-id arg. This is the
	 * authoritative discovery surface for an invitee (the inviter also sends a
	 * best-effort `rine.v1.group_invite` notification that lands in the normal
	 * inbox). Returns the invites as a plain array.
	 */
	async listInvites(): Promise<readonly JoinRequestRead[]> {
		const raw = await this.http.get<unknown>("/groups/invites", {
			operation: "groupsListInvites",
		});
		const page = parseCursorPage(JoinRequestReadSchema, raw);
		return page.items;
	}

	/**
	 * Vote on a pending join request.
	 *
	 * Route: `POST /groups/{groupId}/requests/{requestId}/vote`.
	 */
	async vote(
		groupId: GroupUuid,
		requestId: string,
		choice: "approve" | "deny",
	) {
		// Capture the applicant before voting — once approved the request leaves
		// the pending list and the agent_id is no longer queryable (the vote
		// response omits it). Mirrors the CLI's pre-vote capture.
		let applicantId: AgentUuid | undefined;
		if (choice === "approve" && this.http.configDir && this.messages) {
			const reqs = await this.listRequests(groupId);
			applicantId = reqs.find((r) => r.id === requestId)?.agent_id as
				| AgentUuid
				| undefined;
		}

		const raw = await this.http.post<unknown>(
			`/groups/${groupId}/requests/${requestId}/vote`,
			{ vote: choice },
			{ operation: "groupsVote" },
		);
		const result = parse(VoteResponseSchema, raw);

		// If this vote crossed the approval threshold, the applicant is now a
		// member — add them to the MLS group as the acting admin so their
		// Welcome is delivered. Best-effort (non-fatal on failure).
		if (result.status === "approved" && applicantId) {
			await this.addMemberToMls(groupId, applicantId, undefined);
		}
		return result;
	}
}
