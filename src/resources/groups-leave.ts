/**
 * Leaving a group, under the name a reader looks for.
 *
 * Departure and eviction were the same call until now: a member left by
 * invoking the removal method on itself, so an operator searching this SDK for
 * "leave" found nothing, and nothing watching the API surface could tell a
 * departure from being thrown out. The mechanics are unchanged — this resolves
 * who is acting and hands the same removal the same work — so there is one
 * removal path, not two.
 *
 * 🔴 **The acting agent is resolved strictly here, and a failure to resolve is
 * raised rather than swallowed.** `removeMember` degrades on an unresolvable
 * actor and attempts the removal anyway, which is right for a kick: the server
 * has its own opinion about who may remove whom. A leave has no such fallback —
 * an org with two active agents and no `agent` named cannot say *whose*
 * departure this is, the server would read the call as a kick, and an MLS group
 * refuses a kick until a Remove commit is posted that nobody can mint for their
 * own removal. Failing here says that in one sentence instead of letting the
 * server answer it two round trips later.
 */

import type { SDKHttpClient } from "../api/http.js";
import type { AgentUuid, GroupUuid } from "../types.js";
import { type GroupMlsContext, reasonOf } from "./groups-mls-context.js";
import {
  type GroupRemovalResult,
  removeGroupMember,
} from "./groups-removal.js";

/**
 * Leave a group as the acting agent.
 *
 * @param agent - Which agent is leaving. Required of an org with more than one
 * active agent; a single-agent org resolves without it.
 */
export async function leaveGroup(
  ctx: GroupMlsContext | null,
  http: SDKHttpClient,
  groupId: GroupUuid,
  signal: AbortSignal | undefined,
  agent: string | undefined,
): Promise<GroupRemovalResult> {
  const actingId = await resolveLeaver(ctx, groupId, signal, agent);
  return await removeGroupMember(
    ctx,
    http,
    groupId,
    actingId as AgentUuid,
    signal,
    agent,
  );
}

/** Who is leaving, or a refusal that names what the caller has to supply. */
async function resolveLeaver(
  ctx: GroupMlsContext | null,
  groupId: GroupUuid,
  signal: AbortSignal | undefined,
  agent: string | undefined,
): Promise<string> {
  if (ctx === null) {
    throw new Error(
      `Cannot leave group ${groupId}: this client has no local key material ` +
        `and no way to resolve which agent is leaving. Name the agent, or use ` +
        `removeMember with an explicit agent id.`,
    );
  }
  try {
    const core = ctx.http.getCoreHttpClient({ signal });
    return await ctx.messages.resolveSenderId(core, agent);
  } catch (err) {
    throw new Error(
      `Cannot leave group ${groupId}: the agent doing the leaving could not ` +
        `be resolved, and a leave the server cannot attribute is read as a ` +
        `kick — which an MLS group refuses until a Remove commit is posted ` +
        `that nobody can mint for their own removal. Name the agent: ` +
        `${reasonOf(err)}`,
    );
  }
}
