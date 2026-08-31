/**
 * The recovery hook `GroupsResource.sync` runs: catching a group's local
 * encryption state up with the group, whichever of the two encryptions it runs.
 *
 * It lives beside the other MLS lifecycle hooks rather than in the resource
 * because the resource is already at its file-size ceiling, and it is a
 * different shape from every hook in `./groups-mls.js`: those run *after* an
 * operation the server has already committed and may only warn, while this one
 * is the whole of what its caller asked for, so a failure is raised.
 *
 * `group.id` — the rine group UUID — is the MLS state key throughout.
 */

import { ACTING_AGENT_HEADER, recoverGroup } from "@rine-network/core";
import type { GroupRecoveryResult } from "@rine-network/core";
import type { GroupUuid } from "../types.js";
import { type GroupMlsContext, asGroupFailure } from "./groups-mls-context.js";

export type {
  GroupRecoveryResult,
  MlsRecoveryResult,
  MlsRecoveryRung,
  SenderKeyRecoveryResult,
} from "@rine-network/core";
export {
  MlsResyncUnavailableError,
  isMlsResyncUnavailable,
} from "@rine-network/core";

/**
 * Catch this client's encryption state for one group up with the group.
 *
 * Which recovery runs is decided from the group row the server just returned,
 * and never from whether local state loads. An MLS group takes the two-rung
 * ladder: **replay** applies the commits the server still holds — reads only,
 * nothing committed — and **resync** posts one external commit that re-seats
 * this agent's existing leaf at the current epoch, which is O(N). A sender-key
 * group has no epoch chain at all; what it can be missing is other members'
 * sender keys, sitting as DMs in this agent's own inbox, and recovering it
 * installs them. The returned report names which regime ran and what it cost.
 *
 * Raises rather than warns. An MLS agent whose local state will not load at all
 * has no resync — the report of that is a `MlsResyncUnavailableError` naming the
 * remedy (an admin removes and re-invites it), never a silent no-op.
 */
export async function syncMlsState(
  ctx: GroupMlsContext,
  groupId: GroupUuid,
  signal: AbortSignal | undefined,
): Promise<GroupRecoveryResult> {
  const group = await ctx.getGroup(groupId, signal);
  const core = ctx.http.getCoreHttpClient({ signal });
  const agentId = await ctx.messages.resolveSenderId(core, undefined);
  try {
    // The group ROW goes in, not its id: `recoverGroup` reads the MLS latch off
    // it to pick a regime, and re-reading it there would spend a second request
    // on a fact this call already holds.
    //
    // No `repair` spelling is passed, so a group created to run MLS whose tree
    // was never founded is WARNED about without naming a verb. That is
    // deliberate: the nearest verb this SDK has, `resumeMlsAdmission`, refuses
    // exactly this state ("no MLS state for <uuid>"), and a warning that sends
    // its reader to a refusal is worse than one that names nothing.
    return await recoverGroup(ctx.http.configDir, agentId, group, core, {
      [ACTING_AGENT_HEADER]: agentId,
    });
  } catch (err) {
    throw asGroupFailure(err, groupId);
  }
}
