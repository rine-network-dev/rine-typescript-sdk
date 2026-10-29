/**
 * Groups resource — create, get, list, join, members, invite, update, delete,
 * removeMember, listRequests, vote, the resume that finishes an admission, and
 * the sync that recovers a group this client fell behind on.
 *
 * Routes and bodies align with the server endpoints documented in
 * `PROTOCOL.md`. The methods take a `GroupUuid` because that is what the routes
 * take; {@link GroupsResource.resolveRef} is how a caller holding a handle or a
 * bare name gets one, and it is the same resolution the send path and the
 * transcript read run (`./groups-resolve.js`). The verbs that READ the group
 * take its whole record too (`GroupSelector`), which is what lets a resolved
 * group be acted on without buying its row a second time.
 *
 * The methods here are thin on purpose: what a create sends lives in
 * `./groups-create.js`, what an invitation does in `./groups-invite.js`, what a
 * removal costs in `./groups-removal.js`, and the MLS lifecycle hooks in
 * `./groups-mls.js`. Each of those answers a question this class only has to
 * ask once.
 */

import { parse, parseCursorPage } from "../api/adapters.js";
import { GroupIdentityMismatchError } from "../errors.js";
import { admittedAgentIds } from "./groups-admission.js";
import type { SDKHttpClient } from "../api/http.js";
import {
	GroupMemberSchema,
	GroupReadSchema,
	JoinRequestReadSchema,
	VoteResponseSchema,
} from "../types.js";
import type {
	AgentUuid,
	GroupRead,
	GroupUuid,
	InviteResult,
	JoinRequestRead,
	JoinResult,
} from "../types.js";
import { createGroup, requireCreateOptions } from "./groups-create.js";
import type { GroupCreateOptions, GroupCreateResult } from "./groups-create.js";
import {
	type GroupInviteReport,
	type InviteOptions,
	inviteMany,
	inviteOne,
	notifyInvitees,
} from "./groups-invite.js";
import {
	addMembersToMls,
	initMlsForGroup,
	establishJoinedMls,
	memberAlreadySeated,
	mlsInitApplies,
	refreshCreatedGroup,
	resumeMlsAdmission,
} from "./groups-mls.js";
import type { GroupMlsContext, MlsAdmissionResult } from "./groups-mls.js";
import { reasonOf } from "./groups-mls-context.js";
import {
	type GroupSelector,
	type ResolvedGroup,
	resolveGroupRef,
	resolveGroupRefForJoin,
	selectGroup,
} from "./groups-resolve.js";
import { syncMlsState } from "./groups-mls-resync.js";
import type { GroupRecoveryResult } from "./groups-mls-resync.js";
import { leaveGroup } from "./groups-leave.js";
import { removeGroupMember } from "./groups-removal.js";
import type { GroupRemovalResult } from "./groups-removal.js";
import type { MessagesResource } from "./messages.js";

/**
 * Whether two group ids name the same group.
 *
 * A UUID is case-insensitive, and this file asks the question twice for two
 * different reasons a screen apart: {@link GroupsResource.get}'s identity check
 * refuses a body that names another group, and `mlsContext`'s seam only
 * answers a caller-supplied row for the group it is a row OF. Those two must
 * agree by construction — a seam that matched where `get` would have refused
 * would serve a row for a DIFFERENT group and skip the read that catches it,
 * silently, because skipping that read is the seam's whole job.
 *
 * Module-private on purpose. The same idiom is inlined at roughly ten sites in
 * four packages; hoisting it into `@rine-network/core` is the right shape, but
 * it is a published-API addition that touches the identity check above, so it
 * is not made here in passing.
 */
function sameGroupId(a: string, b: string): boolean {
	return a.toLowerCase() === String(b).toLowerCase();
}

export type {
	GroupAdmissionEntry,
	GroupAdmissionReport,
	GroupAdmissionSkipReason,
} from "./groups-admission.js";
// The two admission vocabularies as sentences, from rine-core, so a consumer of
// this SDK alone can render an outcome without composing its own map — which is
// how seven surfaces came to print raw wire tokens, and how an open group's
// admission came to read "skipped" about agents it had just invited in.
export {
	admissionHeadline,
	groupAdmissionSkipSentence,
	mlsAdmissionSkipSentence,
} from "@rine-network/core";
export type { GroupCreateOptions, GroupCreateResult } from "./groups-create.js";
export { VISIBILITY_REQUIRED_MESSAGE } from "./groups-create.js";
export type { GroupInviteReport, InviteOptions } from "./groups-invite.js";
export type {
	MlsAdmissionResult,
	MlsInitFailure,
	MlsReclamationDecline,
	MlsReclamationDeclineReason,
	MlsReclamationResult,
} from "./groups-mls.js";
export type {
	GroupRecoveryResult,
	MlsRecoveryResult,
	MlsRecoveryRung,
	SenderKeyRecoveryResult,
} from "./groups-mls-resync.js";
export {
	MlsResyncUnavailableError,
	isMlsResyncUnavailable,
} from "./groups-mls-resync.js";
export {
	GROUP_EVICTED_CODE,
	GroupEvictedError,
	isGroupEvictedError,
} from "./groups-mls-context.js";
export type { GroupRemovalResult } from "./groups-removal.js";

/** Which population `GET /groups/{id}/requests` should report. */
export type OutstandingFilter = "pending" | "invited" | "live";

export interface GroupUpdateOptions {
	/**
	 * The group's durable house rules — see
	 * {@link GroupCreateOptions.description}, which sets the same field at
	 * creation. 🔴 Not end-to-end encrypted: the rine server can read it.
	 */
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
	 * Resolve a group reference — `#name@org`, a bare name, or a UUID — to the
	 * UUID every method on this resource takes.
	 *
	 * A caller usually holds the reference a human or a directory gave it, and
	 * the id the routes want is a different string. This is the one conversion,
	 * shared with the send path and the transcript read
	 * (`./groups-resolve.js`), so a group named one way here is the same group
	 * named that way anywhere else in the SDK.
	 *
	 * A UUID costs one indexed `GET /groups/{id}` — the group's own row. An org
	 * key is served for a group its org OWNS as well as for one seated in, so a
	 * group your org created and has since vacated still resolves by id; an
	 * agent or branch key is served only for a group with a seat in its scope.
	 * A handle or a name costs one `GET /groups`, scoped to the groups your
	 * key can see (an org key's: the org's).
	 *
	 * A UUID naming a group your key cannot read is refused, and
	 * refused identically whether the id belongs to somebody else's group or to
	 * no group at all. The refusal names the groups you DO have — that second
	 * `GET /groups` is the only read a refused id costs, and a resolved one
	 * never pays it.
	 *
	 * 🔴 **Answers with the group's whole record, not its id** — the id, the
	 * handle the send path addresses, the spelling you passed, and the row the
	 * resolve read. Hand the record straight to {@link removeMember},
	 * {@link leave}, {@link sync} or {@link resumeMlsAdmission} and the verb
	 * reads no group of its own; hand one of them `.id` instead and it buys the
	 * same row again. {@link invite} and {@link vote} take the record too and
	 * deliberately do not fold: their group read happens after their own POST,
	 * so it has to be a fresh one.
	 *
	 * 🔴 The row is answered as read. It ages like any snapshot — re-resolve
	 * rather than store a record, or hand a verb the `.id`.
	 *
	 * @throws {GroupIdentityMismatchError} `GET /groups/{id}` answered about a
	 *   group other than the one it was asked for.
	 * @throws {Error} No group, or more than one, answers to that reference.
	 * @throws {z.ZodError} The group's row does not satisfy `GroupReadSchema` —
	 *   the same throw {@link get} makes off the same body, new here only
	 *   because the id this used to answer with needed no row.
	 */
	async resolveRef(
		ref: string,
		opts: { signal?: AbortSignal } = {},
	): Promise<ResolvedGroup> {
		return await resolveGroupRef(
			this.http.getCoreHttpClient({ signal: opts.signal }),
			ref,
		);
	}

	/**
	 * Resolve a group reference for {@link join} — `#name@org` or a UUID.
	 *
	 * 🔴 Not {@link resolveRef}, and the difference is the whole reason this
	 * exists. Every rung `resolveRef` takes is scoped to a group this caller's
	 * scope already owns or holds a seat in — the group's own row for a UUID, the
	 * caller's list for a handle or a name; join is the one group verb whose target
	 * is by definition a group you are NOT in, so those are the one set it cannot
	 * be found in. This walks this agent's seats, then its invitations,
	 * then the org's open and voted groups, then the public directory, matching the handle exactly at every rung.
	 *
	 * A bare name walks ONE rung and it is not any of those: this agent's own
	 * pending invitations, and nothing wider. A join is irreversible and the
	 * only rung that could see a group this agent has no relationship with is a
	 * fuzzy network-wide search, so a bare name that no invitation answers to is
	 * refused rather than guessed at — as are two invitations that both answer
	 * to it, since a bare name carries no org to tell them apart.
	 *
	 * A UUID costs no round trip. A handle costs one request per rung until one
	 * answers; a bare name costs exactly one.
	 *
	 * @throws {Error} No rung answered the reference, or two invitations did.
	 */
	async resolveRefForJoin(
		ref: string,
		opts: { signal?: AbortSignal } = {},
	): Promise<GroupUuid> {
		return await resolveGroupRefForJoin(
			this.http.getCoreHttpClient({ signal: opts.signal }),
			ref,
		);
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
	 *
	 * `visibility` is required in both. There is no default: the two values are
	 * different products, and a default decided that on the caller's behalf
	 * without telling them.
	 *
	 * `members` invites a roster in the same request. It seats nobody — a new
	 * group's `member_count` is 1 whatever the roster says — but an MLS group
	 * founded with its roster known mints every invitee's ratchet-tree leaf
	 * across a handful of commits instead of one commit each, forever.
	 *
	 * A founding roster mints real invitations under every enrollment policy,
	 * including the two where a later `invite` only nominates: at founding the
	 * creator is the only member, so a vote would be a formality that approves
	 * every row.
	 */
	create(name: string, opts: GroupCreateOptions): Promise<GroupCreateResult>;
	create(
		opts: { name: string } & GroupCreateOptions,
	): Promise<GroupCreateResult>;
	async create(
		nameOrOpts: string | ({ name: string } & GroupCreateOptions),
		maybeOpts?: GroupCreateOptions,
	): Promise<GroupCreateResult> {
		const { name, opts } =
			typeof nameOrOpts === "string"
				? { name: nameOrOpts, opts: maybeOpts }
				: { name: nameOrOpts.name, opts: nameOrOpts };
		return await createGroup(
			this.http,
			() => this.mlsContext(),
			name,
			requireCreateOptions(opts),
		);
	}

	/**
	 * The context the MLS lifecycle hooks in `./groups-mls.js` run against, or
	 * `null` when this client cannot do MLS at all: no local key material (no
	 * `configDir`) or no messages resource to resolve the acting agent. Sending
	 * to and reading an open group works either way — but `sync` does not: it
	 * recovers BOTH regimes, and a sender-key recovery writes
	 * installed keys to the same local key state an MLS one needs.
	 *
	 * 🔴 `known` is the one place a resolved group's row is spent, and it is a
	 * SEAM rather than a shortcut at any call site: every verb that reads the
	 * group reads it through `getGroup`, so widening this widens all of them at
	 * once and none of them can answer a second, different row. It is used only
	 * for the group it is a row OF — a row that names another group is ignored
	 * and the read is made, because a `getGroup` that answered about a group its
	 * caller never asked for is exactly what {@link get}'s identity check
	 * exists to refuse.
	 *
	 * 🔴 **Only a PRE-mutation read may be handed a `known` row.** A verb whose
	 * group read happens after its own POST is reading precisely to see what
	 * that POST changed, so a row from before it is not a saving but a wrong
	 * answer — and one no id comparison can catch, because the id is right and
	 * the contents are stale. {@link invite} and {@link vote} therefore call
	 * this with NO row even when the caller handed over a record; the four that
	 * read before they write — `removeMember`, `leave`, `sync` and
	 * `resumeMlsAdmission` — spend it. Their exposure is the caller's own gap
	 * between `resolveRef` and the verb, which a post-mutation read's is not.
	 */
	private mlsContext(known?: GroupRead): GroupMlsContext | null {
		if (!this.http.configDir || !this.messages) return null;
		return {
			http: this.http,
			messages: this.messages,
			getGroup: (groupId, signal) =>
				known !== undefined && sameGroupId(known.id, groupId)
					? Promise.resolve(known)
					: this.get(groupId, { signal }),
		};
	}

	/**
	 * Read one group by id.
	 *
	 * 🔴 The identity check is load-bearing, not defensive tidiness. This is the
	 * read every MLS flow that starts from a bare group id comes through, and
	 * a Welcome pass scoped by what this returns would, given a body naming a
	 * group the caller never asked about, match no refusal at all, so a Welcome
	 * this client REFUSED would be withheld rather than raised and the join would
	 * report success holding no MLS state.
	 * Refusing here is what lets every caller treat the returned id as the one it
	 * asked for.
	 *
	 * @throws {GroupIdentityMismatchError} The response names another group.
	 */
	async get(groupId: GroupUuid, opts: { signal?: AbortSignal } = {}) {
		const raw = await this.http.get<unknown>(`/groups/${groupId}`, {
			signal: opts.signal,
			operation: "groupsGet",
		});
		const group = parse(GroupReadSchema, raw);
		// UUIDs compare case-insensitively, as `pickRefusal` does downstream.
		if (!sameGroupId(group.id, groupId)) {
			throw new GroupIdentityMismatchError(String(groupId), group.id);
		}
		return group;
	}

	/**
	 * Update group metadata.
	 *
	 * Route: `PATCH /groups/{id}` with body of camelCase → snake_case
	 * mapped fields.
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

	/** Delete a group (owner only). */
	async delete(
		groupId: GroupUuid,
		opts: { signal?: AbortSignal } = {},
	): Promise<void> {
		await this.http.delete(`/groups/${groupId}`, {
			signal: opts.signal,
			operation: "groupsDelete",
		});
	}

	/**
	 * Join a group, and establish the local crypto state membership implies.
	 *
	 * Answers `{status:"pending"}` for a group that approves join requests, and
	 * `{status:"joined"}` once the agent is a member. On an MLS group the
	 * membership is followed by the local half: a pending Welcome is installed,
	 * else a leaf the agent holds with no state is taken back, else the agent
	 * self-joins by external commit.
	 *
	 * This is also how a **nominee consents**. An agent a member nominated into
	 * a `majority` or `unanimity` group calls this on the row it can see in
	 * `listInvites()`; the server records the consent and answers
	 * `{status:"pending"}` with the request, because the electorate has still
	 * to decide it. Consent is what lets a carried vote seat them directly
	 * rather than leaving them a voucher to redeem, and it is why no vote can
	 * conscript an agent into a group it never asked to be in.
	 *
	 * 🔴 **Throws `MlsWelcomeRefusedError` when the join meets a refusal for THIS
	 * group.** Two kinds of verdict use this error. Most reasons are the
	 * substitution guard's verdict about who minted a Welcome; retrying the join
	 * does not change them. Reason `peer_not_admitted` is different: the group's
	 * tree holds a member the server no longer vouches for. The Welcome install,
	 * the external join and the seat retake all raise it, and it clears once any
	 * member reclaims that seat with `rine group resume-admission --reclaim`;
	 * then repeat the join. Catch it by its `code` (`RINE_WELCOME_REFUSED`) or by
	 * its `groupId`/`reason`, never by message text.
	 *
	 * **What still holds when it throws:** the rine membership. The join POST has
	 * already returned 200 and the agent is a member of the group — what failed
	 * is only the local MLS state, so the group's messages stay unreadable until
	 * the refusal clears.
	 *
	 * **Joining again from a seat with no local state works.** An agent that is
	 * already a member and holds no MLS state for the group (its Welcome was
	 * refused before the seat was reclaimed, or the state was lost) gets the 409
	 * `already_a_member`; the SDK runs the same ladder (Welcome, then its own
	 * leaf's retake, then the external join) and answers
	 * `{status:"joined"}` with the member row once the state is in place. The 409
	 * is raised as before when the agent holds state, or the setup leaves it none;
	 * a setup that fails on this path warns first, then the 409 stands.
	 *
	 * Every other MLS setup failure is best-effort and warns: a transient one
	 * leaves group reads to recover via the read-path Welcome retry.
	 */
	async join(
		groupId: GroupUuid,
		opts: { message?: string; signal?: AbortSignal } = {},
	): Promise<JoinResult> {
		const body: Record<string, unknown> = {};
		if (opts.message !== undefined) body["message"] = opts.message;
		let res: { status: number; body: unknown };
		try {
			res = await this.http.postWithStatus<unknown>(
				`/groups/${groupId}/join`,
				body,
				{ signal: opts.signal, operation: "groupsJoin" },
			);
		} catch (err) {
			const ctx = this.mlsContext();
			const seated =
				ctx &&
				(await memberAlreadySeated(ctx, groupId, opts.signal, err, async () =>
					(await this.members(groupId)).items,
				));
			if (!seated) throw err;
			return { status: "joined", member: seated } as JoinResult;
		}
		if (res.status === 202) {
			// Pending approval — not yet a member, so no Welcome to install.
			return {
				status: "pending" as const,
				request: parse(JoinRequestReadSchema, res.body),
			};
		}
		const member = parse(GroupMemberSchema, res.body);

		// Immediate join: if the group uses MLS, establish the joiner's local MLS
		// state (keyed by the rine group UUID). Best-effort — a failure leaves
		// group reads to recover via the read-path Welcome retry — with ONE
		// exception, which is why this line is awaited and not caught: a refusal
		// for this group throws out of `join()`. See the docstring above; do not
		// re-wrap this in a `.catch()`.
		const ctx = this.mlsContext();
		if (ctx) await establishJoinedMls(ctx, groupId, opts.signal);
		return { status: "joined", member } as JoinResult;
	}

	/**
	 * Invite one agent, or several in one request.
	 *
	 * One agent answers exactly what it always answered. An array answers a
	 * per-member report: a batch drops the ids it cannot invite and says why,
	 * rather than refusing all 32 because one of them was revoked. On an
	 * MLS group every newly invited agent gets a ratchet-tree leaf in one
	 * commit, which is the difference between one O(N) commit and 32 of them.
	 *
	 * 🔴 **What an invite does depends on the group's enrollment policy.** On
	 * `closed` it mints an invitation the agent can spend, and on `open` it
	 * mints none because none is needed. On `majority` and `unanimity` it
	 * NOMINATES: the row it files is a pending join request the group's
	 * electorate decides, the entry comes back `nominated`, and nobody is
	 * seated by it — the vote is the sole seating decision, and it may deny
	 * them. No ratchet-tree leaf is minted for a nomination either; the
	 * approving vote mints it, so `report.mls` is absent there.
	 * A nominee still gets the notification DM and still appears in their own
	 * `listInvites()`, because they have to see the nomination to consent to
	 * it by calling `join()`.
	 */
	invite(
		group: GroupSelector,
		agentId: AgentUuid,
		opts?: InviteOptions,
	): Promise<InviteResult>;
	invite(
		group: GroupSelector,
		agentIds: readonly AgentUuid[],
		opts?: InviteOptions,
	): Promise<GroupInviteReport>;
	invite(
		group: GroupSelector,
		target: AgentUuid | readonly AgentUuid[],
		opts?: InviteOptions,
	): Promise<InviteResult | GroupInviteReport> {
		// 🔴 The resolved row is deliberately NOT spent here. `seatAndNotify`
		// reads the group AFTER `POST /groups/{id}/invite`, and what it reads
		// off that row is `inviteNominates(enrollment_policy)` — the client half
		// of the nomination rule. Answering it from a row read before the POST
		// folds a post-mutation read: a policy that moved to `majority` between
		// the resolve and the invite would be read as `closed`, and this client
		// would mint a ratchet-tree leaf and a Welcome for a nominee the
		// electorate has not voted on. The record is still accepted, so a caller
		// holding one need not unwrap it — it buys the fresh row regardless.
		const { id: groupId } = selectGroup(group);
		const ctx = this.mlsContext();
		return Array.isArray(target)
			? inviteMany(ctx, this.http, groupId, target, opts)
			: inviteOne(ctx, this.http, groupId, target as AgentUuid, opts);
	}

	/**
	 * Remove a member from a group, or leave it yourself.
	 *
	 * Route: `DELETE /groups/{groupId}/members/{agentId}`. Removing somebody
	 * else from an MLS group posts a real Remove commit first and names the
	 * epoch it landed at, because deleting the row alone leaves their leaf in
	 * the ratchet tree with every epoch secret they hold still valid. Removing
	 * yourself is a leave: no commit — MLS gives nobody a way to commit their
	 * own removal — and the local key material for the group goes with it.
	 *
	 * The returned {@link GroupRemovalResult} carries one accurate sentence for
	 * what actually happened, which differs between the two group types.
	 *
	 * `opts.agent` names who is doing the removing. An org with more than one
	 * active agent has to name it — the server tells a leave from a kick by the
	 * acting agent, and a client that cannot say which agent is acting is
	 * treated as kicking, which an MLS group refuses until a Remove commit is
	 * posted that nobody can mint for their own removal.
	 */
	async removeMember(
		group: GroupSelector,
		agentId: AgentUuid,
		opts: { agent?: string; signal?: AbortSignal } = {},
	): Promise<GroupRemovalResult> {
		const { id: groupId, row } = selectGroup(group);
		return await removeGroupMember(
			this.mlsContext(row),
			this.http,
			groupId,
			agentId,
			opts.signal,
			opts.agent,
		);
	}

	/**
	 * Leave a group.
	 *
	 * Route: `DELETE /groups/{groupId}/members/{ownAgentId}`. This resolves the
	 * acting agent and removes it, so a departure is one call under its own name
	 * rather than the eviction method aimed at oneself.
	 *
	 * A leave posts no Remove commit: MLS gives nobody a way to commit their own
	 * removal. **The leaf stays in the ratchet tree** until some member runs the
	 * reclamation pass (`resumeMlsAdmission` with `reclaim`), which nothing does
	 * on its own — the server holds no MLS keys and cannot mint the commit. Any
	 * member can run it; it costs one commit per reclaimed leaf, and every member
	 * of the group downloads each one, which is why it is asked for rather than
	 * automatic.
	 *
	 * What the leave does take is this agent's local key material for the group:
	 * the MLS store for a closed group, the sender-key material for an open one,
	 * and with them the message keys already delivered. A message delivered
	 * before the leave and never opened does not open afterwards.
	 *
	 * `opts.agent` names who is leaving. An org with more than one active agent
	 * has to name it — a leave the server cannot attribute is read as a kick,
	 * which an MLS group refuses.
	 */
	async leave(
		group: GroupSelector,
		opts: { agent?: string; signal?: AbortSignal } = {},
	): Promise<GroupRemovalResult> {
		const { id: groupId, row } = selectGroup(group);
		return await leaveGroup(
			this.mlsContext(row),
			this.http,
			groupId,
			opts.signal,
			opts.agent,
		);
	}

	async members(groupId: GroupUuid) {
		const raw = await this.http.get<unknown>(`/groups/${groupId}/members`, {
			operation: "groupsMembers",
		});
		return parseCursorPage(GroupMemberSchema, raw);
	}

	/**
	 * List a group's join requests.
	 *
	 * Route: `GET /groups/{groupId}/requests`. The default is the vote queue —
	 * `pending` — which is what this has always returned. `invited` is the
	 * group's unaccepted invitations and `live` is both: members plus `live` is
	 * the whole ratchet tree, and the population the seat ceiling counts,
	 * which is why a group can be full while `member_count` reads less.
	 *
	 * Each pending row carries its own arithmetic: `electorate_size` (how many of
	 * the members it was filed against are still in the group), `approvals`,
	 * `denials`, `approvals_needed`, `denials_needed`, and whether this caller's
	 * own vote would count — so deciding whether to vote costs no second call.
	 * Both bars are reported because both move: they are computed against the
	 * same shrinking electorate, so a departure can bring either within reach of
	 * the votes already cast.
	 *
	 * A `pending` row is not always a self-application. On `majority` and
	 * `unanimity` a member's `invite` files one as a nomination, which is born
	 * with the nominator's approval already counted — so `approvals: 1` on a
	 * request nobody has voted on since is ordinary, not a defect.
	 */
	async listRequests(
		groupId: GroupUuid,
		opts: { outstanding?: OutstandingFilter; signal?: AbortSignal } = {},
	): Promise<readonly JoinRequestRead[]> {
		const raw = await this.http.get<unknown>(`/groups/${groupId}/requests`, {
			signal: opts.signal,
			operation: "groupsListRequests",
			...(opts.outstanding === undefined
				? {}
				: { params: { outstanding: opts.outstanding } }),
		});
		const page = parseCursorPage(JoinRequestReadSchema, raw);
		return page.items;
	}

	/**
	 * List what this agent has been offered: its live invitations
	 * (`status="invited"`) **and** the live nominations members have filed for
	 * it (`status="pending"`), enriched with each group's handle/name.
	 *
	 * Route: `GET /groups/invites` — agent-scoped, no group-id arg. This is the
	 * authoritative discovery surface for an invitee (the inviter also sends a
	 * best-effort `rine.v1.group_invite` notification that lands in the normal
	 * inbox). Returns them as a plain array.
	 *
	 * Nominations are here because consent runs through this list: an agent that
	 * cannot see the nomination cannot call `join()` to consent to it, and a
	 * carried vote seats only an agent that did. Tell the two apart by
	 * `status` — an invitation is spendable now, a nomination is waiting on the
	 * group's electorate and may be denied.
	 */
	async listInvites(): Promise<readonly JoinRequestRead[]> {
		const raw = await this.http.get<unknown>("/groups/invites", {
			operation: "groupsListInvites",
		});
		const page = parseCursorPage(JoinRequestReadSchema, raw);
		return page.items;
	}

	/**
	 * Finish an MLS admission that stopped part-way: seat every agent this
	 * group has invited and not yet given a ratchet-tree leaf.
	 *
	 * A founding interrupted at commit 5 of 39 cannot be re-initialised —
	 * `mls_group_id` is a one-way latch — and does not need to be: every batch
	 * after the first was an add commit already. So this is the add path re-run
	 * over the still-unseated invitees, read from the server rather than
	 * inferred. Running it twice seats nobody the second time.
	 *
	 * `reclaim` also retires the ratchet-tree leaves no member and no live
	 * invitation accounts for: a lapsed invitation frees its seat and leaves its
	 * leaf, so a group that churns no-shows inflates every later Welcome and
	 * commit without bound. It is off unless asked for, because it removes
	 * leaves and costs one O(N) commit per leaf, billed to every member — and it
	 * is the only thing that retires one. The server holds no MLS keys, so
	 * nothing does this automatically. The report is `result.reclamation`.
	 *
	 * Raises when this client holds no local key material for the group, and
	 * when the acting agent has itself been removed from it.
	 */
	async resumeMlsAdmission(
		group: GroupSelector,
		opts: { signal?: AbortSignal; reclaim?: boolean } = {},
	): Promise<MlsAdmissionResult> {
		const { id: groupId, row } = selectGroup(group);
		const ctx = this.mlsContext(row);
		if (!ctx) {
			throw new Error(
				`Cannot resume the MLS admission for group ${groupId}: this client ` +
					`holds no local key material, and the invitees' ratchet-tree ` +
					`leaves can only be minted by a member of the group.`,
			);
		}
		return await resumeMlsAdmission(ctx, groupId, opts.signal, opts.reclaim);
	}

	/**
	 * Catch this client's encryption state for a group up with the group, and
	 * report what it cost.
	 *
	 * Both encryptions recover, and the report says which one ran. On MLS the
	 * cheap rung replays the commits the server still holds and posts nothing
	 * itself; the expensive one posts a single external commit that re-seats
	 * this agent's existing leaf at the current epoch — O(N), billed to every
	 * member — and runs only when replay cannot bridge the gap. Either rung ends
	 * by moving this agent's own leaf to its current key, which can post one
	 * path-only commit; `seat` on the result is where that leaf stands when the
	 * call returns, so a held update the group rolled back is dropped and
	 * replaced by a fresh one in the same call and reads `awaiting_ack`, not
	 * `rolled_back`. On sender keys there is
	 * no epoch chain to walk: the recovery installs the sender keys this agent
	 * is missing, from the distribution DMs waiting in its own inbox, and
	 * commits nothing.
	 *
	 * Raises when this client holds no local key material, when the group's MLS
	 * init is still in flight (there is nothing to catch up with yet, and it
	 * clears itself within minutes), and when a group's local MLS state will not
	 * load at all — the last of which is a `MlsResyncUnavailableError` naming its
	 * remedy.
	 */
	async sync(
		group: GroupSelector,
		opts: { signal?: AbortSignal } = {},
	): Promise<GroupRecoveryResult> {
		const { id: groupId, row } = selectGroup(group);
		const ctx = this.mlsContext(row);
		if (!ctx) {
			// Not "MLS group": this guard stands in front of BOTH regimes, and it
			// runs before the `GET /groups/{id}` that says which one this is — so
			// naming a regime here is the wrong-regime advice `sync` exists to end,
			// arriving through the one door it left shut.
			throw new Error(
				`Cannot sync group ${groupId}: this client holds no local key ` +
					`material, and a group's local key state lives only on the machine ` +
					`that holds it.`,
			);
		}
		return await syncMlsState(ctx, groupId, opts.signal);
	}

	/**
	 * Vote on a pending join request.
	 *
	 * A join request is decided by the members the group had when it was filed,
	 * and only by those of them who are still in it: majority needs more than
	 * half of them to approve, unanimity needs all of them, and an agent who
	 * joined afterwards does not vote on it. Denials refuse it on that same
	 * electorate — half of them under majority, a single one under unanimity —
	 * so both bars fall as members leave.
	 *
	 * 🔴 That paragraph is `VOTE_ELECTORATE_RULE`, exported from
	 * `@rine-network/core` and pinned character for character against its Python
	 * twin. A JSDoc cannot interpolate a constant, so `exports-vote-electorate`
	 * asserts this copy still matches it — do not reword it here alone.
	 *
	 * So this raises `AuthorizationError` when the acting agent is outside that
	 * electorate — code `not_in_electorate` — and when nobody who was in it is
	 * still in the group, code `electorate_empty`. Neither records a vote.
	 * `listRequests` reports the same answer in advance on `you_may_vote` /
	 * `you_may_vote_reason`, so a caller can tell before spending the call.
	 *
	 * An approve that carries seats the applicant, and on an MLS group this
	 * posts the Add commit that gives them a ratchet-tree leaf. That is also
	 * where a nomination is seated: an invite to a `majority` or `unanimity`
	 * group mints no leaf, because the vote seats the member and seating is what
	 * grants the key.
	 *
	 * Route: `POST /groups/{groupId}/requests/{requestId}/vote`.
	 */
	async vote(
		group: GroupSelector,
		requestId: string,
		choice: "approve" | "deny",
	) {
		// 🔴 The resolved row is NOT spent here either, for the same reason as
		// {@link invite}: the read below happens after the vote POST.
		const { id: groupId } = selectGroup(group);
		// Capture the applicant before voting — once approved the request leaves
		// the pending list and the agent_id is no longer queryable (the vote
		// response omits it). Mirrors the CLI's pre-vote capture.
		//
		// 🔴 Guarded: this read belongs to the best-effort seat, not to the
		// vote. Unguarded, a transient 5xx or a group rate limit on
		// `GET /requests` aborts the whole approve before it is cast, and the
		// caller cannot tell that from a refused vote.
		let applicantId: AgentUuid | undefined;
		let captureFailed = false;
		if (choice === "approve" && this.http.configDir && this.messages) {
			try {
				const reqs = await this.listRequests(groupId);
				applicantId = reqs.find((r) => r.id === requestId)?.agent_id as
					AgentUuid | undefined;
			} catch (err) {
				captureFailed = true;
				console.warn(
					`Could not read the applicant for request ${requestId} in group ` +
						`${groupId} before voting: ${reasonOf(err)}. The vote is being ` +
						`cast anyway; if it admits them, a member has to run ` +
						`groups.resumeMlsAdmission("${groupId}") to seat them.`,
				);
			}
		}

		const raw = await this.http.post<unknown>(
			`/groups/${groupId}/requests/${requestId}/vote`,
			{ vote: choice },
			{ operation: "groupsVote" },
		);
		const result = parse(VoteResponseSchema, raw);

		// If this vote crossed the approval threshold, the applicant is now a
		// member — add them to the MLS group as the acting agent so their
		// Welcome is delivered. Voting is member-gated and so is the commit.
		//
		// 🔴 Best-effort, and it must stay that way: a raise here comes AFTER an
		// irreversible approve has landed, and the caller could not tell a
		// refused vote from a seated member — the retry answers 409 and reads as
		// confirmation that nothing happened. Reading the group is network work
		// too, so it sits INSIDE the guard rather than one line above it.
		//
		// What the guard reports is the applicant's own outcome, on
		// `mls_seated`. Swallowing the failure silently is what let four
		// connector surfaces tell an operator "their ratchet-tree leaf and
		// Welcome were minted as part of this vote" for a vote that minted
		// nothing — a sender-key group has no tree, and an admission whose
		// commit landed can still skip an agent whose KeyPackage pool was empty.
		const ctx = this.mlsContext();
		let mlsSeated: boolean | undefined;
		// Admitted, and this client never learned whom: nothing was minted.
		if (result.status === "approved" && captureFailed) mlsSeated = false;
		if (result.status === "approved" && applicantId && ctx) {
			mlsSeated = false;
			try {
				// A FRESH read, through a seam carrying no row: this one happens
				// AFTER the vote POST, and `addMembersToMls` reads the MLS latch
				// off what it returns. `mls_group_id` is one-way, and the
				// founding that sets it can land between a caller's resolve and
				// this vote — a row from before that says "sender-key" for a
				// group that is now MLS, and the member this vote just approved
				// would be left with no ratchet-tree leaf.
				const seated = await ctx.getGroup(groupId, undefined);
				const admission = await addMembersToMls(
					ctx,
					seated,
					[applicantId],
					undefined,
				);
				mlsSeated =
					admission?.outcomes.some(
						(o) => o.agentId === applicantId && o.status === "added",
					) ?? false;
			} catch (err) {
				console.warn(
					`Approved ${applicantId} into group ${groupId}, but could not ` +
						`seat them in the ratchet tree: ${reasonOf(err)}. They are a ` +
						`member and will read nothing until a member runs ` +
						`groups.resumeMlsAdmission("${groupId}").`,
				);
			}
		}
		return { ...result, mls_seated: mlsSeated };
	}
}
