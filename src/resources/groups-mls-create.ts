/**
 * The two MLS hooks `GroupsResource.create` runs: founding the new group's MLS
 * state, and re-reading the group once that init has landed.
 *
 * They are separated from the membership hooks in `./groups-mls.js` because
 * they answer to a different caller obligation. A membership hook runs after an
 * operation the server has already committed and may only warn. These two run
 * inside `create`, where the group exists server-side from the POST onwards, so
 * every failure here has to be handed back or absorbed — never allowed to take
 * a created group, and its id, away from the caller.
 *
 * `group.id` — the rine group UUID — is the MLS state key. The server's opaque
 * `mls_group_id` latch is a different value with a confusingly similar name.
 */

import {
  ACTING_AGENT_HEADER,
  MLS_PENDING_SELF_CLEAR_SECONDS,
  initMlsGroup,
} from "@rine-network/core";
import type { MlsAdmissionResult } from "@rine-network/core";
import type { GroupRead, GroupUuid } from "../types.js";
import {
  type GroupMlsContext,
  reasonOf,
  warnUnseated,
} from "./groups-mls-context.js";

/**
 * Why the MLS init a `create` attempted did not land. A created group is a
 * real product object either way — sender-key is a supported encryption — so
 * the failure is handed back rather than raised.
 *
 * Both ways out of it exist, and which one applies depends on whether the
 * server's `mls_group_id` latch was written before the failure:
 *
 *   - not latched (`mls_group_id` still null) — the init can simply be run
 *     again once whatever refused it is fixed; a stuck `mls_pending` clears
 *     itself server-side after {@link MLS_PENDING_SELF_CLEAR_SECONDS}.
 *   - latched — the founding got as far as some of its commits, and the latch
 *     is one-way, so it can never be re-initialised. It does not need to be:
 *     `groups.resumeMlsAdmission(groupId)` seats whoever is still unseated,
 *     which is what every commit after the first was doing anyway.
 */
export interface MlsInitFailure {
  ok: false;
  reason: string;
}

/**
 * What the founding did, when it landed: one outcome per agent the server
 * reported, in the order it reported them.
 *
 * Carrying it is the difference between "40 invited, 0 skipped" and the truth,
 * on a roster where three of the forty had published no key package. Those
 * three hold an invitation, hold no ratchet-tree leaf, and cannot read a word
 * of the group until somebody resumes the admission — and the create response
 * was the only place that fact existed.
 */
export interface MlsInitLanded {
  ok: true;
  admission: MlsAdmissionResult;
}

/** Either half of what an attempted MLS init answers. */
export type MlsInitOutcome = MlsInitLanded | MlsInitFailure;

/**
 * Should a freshly-created group have its MLS state founded at all?
 *
 * Open-enrolment groups are exempt: the server refuses MLS there (403
 * `mls_open_enrollment_disabled`), so an attempt could only ever fail. They run
 * over sender keys, which is a supported encryption and not a degraded one —
 * so the caller is told nothing, because nothing went wrong. Skipping is not
 * failing: `create` returns the plain group with no `mlsInit`, which is what
 * the Python SDK reports as "not attempted"
 * (`rine-sdk/src/rine/_mls/group_init.py`) and what the CLI does by the same
 * test.
 *
 * This is the one place the rule is stated for this SDK; callers ask the
 * question rather than re-deriving the policy from the enrollment field.
 */
export function mlsInitApplies(group: GroupRead): boolean {
  return group.enrollment_policy !== "open";
}

/**
 * Found the MLS state of a freshly-created group. The acting agent (the
 * creator) is the lowest-UUID admin and so qualifies as the initialiser.
 *
 * Returns the failure when the init did not land, so `create` can hand it back
 * to the caller instead of leaving it in a warning line nobody reads — and the
 * per-member admission when it did, because a founding that seated 37 of 40 is
 * not the same event as one that seated 40, and only this call can tell them
 * apart.
 */
export async function initMlsForGroup(
  ctx: GroupMlsContext,
  group: GroupRead,
  signal: AbortSignal | undefined,
): Promise<MlsInitOutcome> {
  try {
    const core = ctx.http.getCoreHttpClient({ signal });
    const agentId = await ctx.messages.resolveSenderId(core, undefined);
    const admission = await initMlsGroup(
      ctx.http.configDir,
      agentId,
      group.id,
      core,
      { [ACTING_AGENT_HEADER]: agentId },
    );
    warnUnseated(group.id, admission);
    return { ok: true, admission };
  } catch (err) {
    const reason = reasonOf(err);
    const minutes = Math.round(MLS_PENDING_SELF_CLEAR_SECONDS / 60);
    console.warn(
      `MLS init for group ${group.id} failed (mls_pending self-clears after ` +
        `${minutes} min; if the group already latched mls_group_id, finish it ` +
        `with groups.resumeMlsAdmission("${group.id}") rather than re-running ` +
        `the init): ${reason}`,
    );
    return { ok: false, reason };
  }
}

/**
 * Re-read a group whose MLS init just landed, so the caller sees the
 * `mls_group_id` latch the init wrote after the create response was minted.
 *
 * Best-effort for the same reason {@link initMlsForGroup} is: the group exists
 * server-side by now, and a failed refresh that only improves one field must
 * never take a created group — and its id — away from the caller. The
 * unrefreshed group still describes a real group, and the latch shows on any
 * later read.
 */
export async function refreshCreatedGroup(
  ctx: GroupMlsContext,
  group: GroupRead,
  signal: AbortSignal | undefined,
): Promise<GroupRead> {
  try {
    return await ctx.getGroup(group.id as GroupUuid, signal);
  } catch (err) {
    console.warn(
      `Group ${group.id} was created and its MLS init landed, but the ` +
        `refresh read failed: ${reasonOf(err)}`,
    );
    return group;
  }
}
