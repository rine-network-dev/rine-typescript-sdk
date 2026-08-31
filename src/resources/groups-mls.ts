/**
 * The MLS lifecycle hooks `GroupsResource` runs around the membership routes:
 * installing a joiner's local MLS state, seating the agents an invitation or a
 * vote just admitted, and finishing an admission that stopped part-way.
 *
 * They live beside the resource rather than inside it because the resource is
 * already at the file-size ceiling, and because every one of them is the same
 * shape: resolve the acting agent, call the `rine-core` orchestrator, and
 * decide what a failure means for the operation the user actually asked for.
 *
 * The two that run after a membership change the server has already committed
 * warn rather than refuse, with the one exception below — refusing there would
 * turn a successful invitation into a thrown one. {@link resumeMlsAdmission} is
 * different again, because it is the whole of what its caller asked for.
 *
 * 🔴 **One failure is never best-effort: a Welcome the group substitution guard
 * REFUSED.** That is a security verdict about who minted it, so
 * {@link installMlsWelcomesIfMls} re-raises it and `groups.join()` states it
 * rather than logging it. The Python twin
 * `rine._mls.join.join_mls_state` raises the same refusal, and one that is loud
 * on one stack and a log line on the other is a defect a user only meets on the
 * quiet one. Everything else on these paths still warns.
 *
 * The create-time half of the lifecycle lives in `./groups-mls-create.js` and
 * the removal half in `./groups-removal.js`; the create half is re-exported
 * here, so the resource keeps one import for the whole set.
 *
 * `group.id` — the rine group UUID — is the MLS state key throughout. The
 * server's opaque `mls_group_id` latch is a different value with a
 * confusingly similar name, and is only ever read as "does this group have
 * MLS state?".
 */

import {
  ACTING_AGENT_HEADER,
  addMlsGroupMembers,
  externalJoinMlsGroup,
  isMlsWelcomeRefusedError,
  loadMlsState,
  notAnMlsGroupResume,
  processMlsWelcomes,
  resumeMlsGroupAdmission,
} from "@rine-network/core";
import type { MlsAdmissionResult } from "@rine-network/core";
import { groupIsMls } from "../format/groups.js";
import type { GroupRead, GroupUuid } from "../types.js";
import {
  type GroupMlsContext,
  asGroupFailure,
  reasonOf,
  warnUnseated,
} from "./groups-mls-context.js";

export type {
  MlsAdmissionResult,
  MlsReclamationDecline,
  MlsReclamationDeclineReason,
  MlsReclamationResult,
} from "@rine-network/core";
export type { GroupMlsContext } from "./groups-mls-context.js";
export type { MlsInitFailure } from "./groups-mls-create.js";
export {
  initMlsForGroup,
  mlsInitApplies,
  refreshCreatedGroup,
} from "./groups-mls-create.js";

/**
 * If the group uses MLS, establish the joiner's local MLS state. Two paths,
 * tried in order:
 *
 *   1. `processMlsWelcomes` — installs any pending Welcome minted by an
 *      existing member (the closed/invite/vote enrollment case).
 *   2. RFC 9420 external-commit self-join — for OPEN enrollment, where the
 *      server added the joiner with no member in the loop, so no Welcome was
 *      minted. If step 1 installed nothing for this group, the joiner fetches
 *      the group's latest published GroupInfo and self-joins, advancing the
 *      epoch for existing members.
 *
 * Both steps are best-effort with one exception: a failure leaves group reads to
 * recover via the read-path Welcome retry, so the join itself still succeeds —
 * but a Welcome the guard REFUSED for this group is raised, because the rine
 * membership standing does not make a substituted Welcome a transient hiccup.
 */
export async function installMlsWelcomesIfMls(
  ctx: GroupMlsContext,
  groupId: GroupUuid,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    const group = await ctx.getGroup(groupId, signal);
    if (!groupIsMls(group)) return;
    const core = ctx.http.getCoreHttpClient({ signal });
    const agentId = await ctx.messages.resolveSenderId(core, undefined);
    try {
      // 🔴 `forGroup` is what keeps the choice of refusal off the server.
      // Unscoped, the pass raises "the first refusal whose bytes arrived",
      // ordered by the server's own welcomes response — so one throwaway decoy
      // for another group made the arm below answer "not this group", and the
      // join carried on into the external-commit fallback for the group whose
      // Welcome this client had just refused to trust — the verb's outcome
      // flips from warn to raise on this argument alone.
      // The id the CALLER named, never the one the response carried: this
      // scope is a security control, so it must not be derived from the thing
      // it defends against. `GroupsResource.get` refuses a mismatch outright,
      // and this is the second layer — a future read path that skips that
      // assert must not silently widen the scope back out.
      await processMlsWelcomes(ctx.http.configDir, agentId, core, {
        forGroup: groupId,
      });
    } catch (err) {
      // A refusal names ONE group, and the batch installed everything else it
      // could before raising. This call establishes ONE group's state, so a
      // refusal naming a different group is reported and the setup carries on;
      // one naming this group goes to the caller. Same two arms as the Python
      // twin, `rine._mls.join.install_mls_state`.
      if (!refusedAnotherGroup(err, groupId)) throw err;
      console.warn(
        `Group ${group.id}: a pending MLS welcome for a different group was ` +
          `refused while joining this one, and is kept for a later attempt: ` +
          reasonOf(err),
      );
    }

    if (loadMlsState(ctx.http.configDir, agentId, group.id) === null) {
      await externalJoinMlsGroup(ctx.http.configDir, agentId, group.id, core, {
        [ACTING_AGENT_HEADER]: agentId,
      });
    }
  } catch (err) {
    // Only a refusal for THIS group can reach here as a refusal — the arm above
    // has already absorbed the ones naming another. It is the one failure this
    // hook does not swallow.
    if (isMlsWelcomeRefusedError(err)) throw err;
    console.warn(
      `MLS join setup for group ${groupId} failed (group reads ` +
        `will retry on demand): ${reasonOf(err)}`,
    );
  }
}

/**
 * Whether a failure is the Welcome guard refusing a Welcome for some group
 * OTHER than the one being established.
 *
 * Classified by rine-core's exported code check, never by matching the message
 * — that export exists for this. The `groupId` a refusal carries is the rine
 * group UUID the delivery was filed under, compared case-insensitively because
 * the two ids arrive from different reads, as the Python twin compares them.
 *
 * Kept even though the scoped call above should never hand it a foreign
 * refusal: the two answer different questions — `forGroup` decides WHICH
 * refusal a pass raises, this decides what THIS verb does with the one it got —
 * and the published SDK floats its `@rine-network/core` floor as a caret range,
 * so a consumer's lockfile can resolve a core old enough to ignore the option
 * entirely. It is the second layer, not a duplicate of the first.
 */
function refusedAnotherGroup(err: unknown, groupId: string): boolean {
  if (!isMlsWelcomeRefusedError(err)) return false;
  const named = (err as { groupId?: unknown }).groupId;
  return (
    typeof named !== "string" || named.toLowerCase() !== groupId.toLowerCase()
  );
}

/**
 * If the group is MLS-active, put every named agent in its ratchet tree as the
 * acting admin — one commit per batch, not one per agent — so a Welcome is
 * waiting when each of them joins. A no-op for sender-key groups.
 *
 * Best-effort: an invitation or a vote the server has already committed cannot
 * be undone by a failed commit here, and nothing is lost that a later
 * {@link resumeMlsAdmission} cannot finish. What it returns is the per-member
 * report, so a caller can say which invitees are seated and which are not.
 */
export async function addMembersToMls(
  ctx: GroupMlsContext,
  group: GroupRead,
  memberAgentIds: readonly string[],
  signal: AbortSignal | undefined,
): Promise<MlsAdmissionResult | undefined> {
  if (!groupIsMls(group) || memberAgentIds.length === 0) return undefined;
  try {
    const core = ctx.http.getCoreHttpClient({ signal });
    const adminId = await ctx.messages.resolveSenderId(core, undefined);
    const result = await addMlsGroupMembers(
      ctx.http.configDir,
      adminId,
      group.id,
      [...memberAgentIds],
      core,
      { [ACTING_AGENT_HEADER]: adminId },
    );
    warnUnseated(group.id, result);
    return result;
  } catch (err) {
    console.warn(
      `MLS admission for group ${group.id} failed (the invitation or vote ` +
        `still succeeded; run groups.resumeMlsAdmission() to seat them, and ` +
        `stuck state self-clears after 15 min): ` +
        reasonOf(asGroupFailure(err, group.id)),
    );
    return undefined;
  }
}

/**
 * Seat everyone this group has invited and not yet given a ratchet-tree leaf.
 *
 * `mls_group_id` is a one-way latch, so a founding that stopped at commit 5 of
 * 39 can never be re-initialised — and does not need to be. Every batch after
 * the first was an add commit already, so what a part-founded group needs is
 * the add path re-run over its still-unseated invitees. Run it twice and the
 * second run seats nobody, reporting every invitee `already_in_group`.
 *
 * Unlike the hooks above this is not best-effort: it is the whole of what the
 * caller asked for, so a failure is raised. An evicted member gets rine's own
 * refusal rather than the native core's ratchet-tree invariant.
 *
 * `reclaim` adds the other half of the job: after everyone entitled to a leaf
 * has one, retire the leaves nobody is entitled to. Off unless asked for,
 * because it removes leaves and costs one O(N) commit per leaf. Nothing else
 * retires a leaf — the server holds no MLS keys, so a group nobody asks keeps
 * accumulating them. Any member may ask; the O(N)-per-leaf cost, billed to
 * every member, is the only thing holding it back.
 */
export async function resumeMlsAdmission(
  ctx: GroupMlsContext,
  groupId: GroupUuid,
  signal: AbortSignal | undefined,
  reclaim = false,
): Promise<MlsAdmissionResult> {
  // The sender-key refusal, before any key material is touched, and mirroring
  // the Python twin `group_resume._refuse_sender_key_group`. Without it the
  // call reaches the native core and comes back as "no MLS state for <uuid>" —
  // which is what an agent that genuinely belongs to this group and lost its
  // local state also gets, and whose remedy is `sync`, not "there is nothing
  // here". The group's own handle is named because a caller that passed a
  // `#handle` never typed the UUID.
  const group = await ctx.getGroup(groupId, signal);
  if (group.enrollment_policy === "open") {
    throw new Error(notAnMlsGroupResume(group.handle ?? groupId));
  }
  const core = ctx.http.getCoreHttpClient({ signal });
  // Not an admin: posting the add and Remove commits takes membership and no
  // role beyond it, so the acting agent is whichever member is running it.
  // 🔴 Do NOT restate this as "every route this verb calls is member-gated":
  // the verb reads `GET /groups/{id}/members`, which is ORG-gated
  // (`has_read_access` admits any org holding a member agent), and
  // `GET /agents/keys`, which is unauthenticated. The conclusion is right and
  // that reason is not — the same 🔴 `rine-core/src/mls-orphans.ts` carries.
  const actingId = await ctx.messages.resolveSenderId(core, undefined);
  try {
    return await resumeMlsGroupAdmission(
      ctx.http.configDir,
      actingId,
      groupId,
      core,
      { [ACTING_AGENT_HEADER]: actingId },
      { reclaim },
    );
  } catch (err) {
    throw asGroupFailure(err, groupId);
  }
}
