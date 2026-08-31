/**
 * Posting the commit that authorises a removal, and reporting what it did.
 *
 * Two things ride on one commit. It takes the target's ratchet-tree leaf, when
 * the target still holds one — and it **declares** the target, which
 * is what `DELETE /groups/{id}/members/{id}` spends. A commit that declares
 * nobody authorises no removal at all.
 *
 * Neither the identity nor the leaf **index** is resolved here. `rine-core`
 * resolves the agent's identity itself, so the leaf it takes and the name it
 * declares cannot be two different members, and it re-resolves the index once
 * per attempt because an index is only true of the epoch it was read at.
 */

import type { MlsRemovalCommit } from "@rine-network/core";
import { ACTING_AGENT_HEADER, removeMlsGroupMember } from "@rine-network/core";
import type { AgentUuid, GroupRead } from "../types.js";
import { type GroupMlsContext, asGroupFailure } from "./groups-mls-context.js";

/**
 * Post the commit and report the epoch it landed at and whether a leaf went
 * with it.
 *
 * 🔴 A target holding **no** leaf still earns a commit — a path-only one that
 * declares the removal. That is the rescue for a removal whose commit
 * landed and whose DELETE then failed: the leaf is already out, so no second
 * Remove can be built for it, and without this the client could produce no
 * epoch, every retry was refused, and the member row was stuck for good. It
 * claims nothing about an eviction — `removedLeaf` says plainly that none
 * happened — and what it does prove is what the server's gate asks for: the
 * caller is still committing to this group, and named this target in advance.
 *
 * A failed commit is raised, and the member row stays where it is. An admin
 * whose own leaf is gone is told it was evicted, rather than being handed the
 * native core's ratchet-tree invariant.
 */
export async function postRemoveCommit(
  ctx: GroupMlsContext,
  actingId: string,
  group: GroupRead,
  agentId: AgentUuid,
  signal: AbortSignal | undefined,
): Promise<MlsRemovalCommit> {
  const core = ctx.http.getCoreHttpClient({ signal });
  try {
    return await removeMlsGroupMember(
      ctx.http.configDir,
      actingId,
      group.id,
      agentId,
      core,
      { [ACTING_AGENT_HEADER]: actingId },
    );
  } catch (err) {
    throw asGroupFailure(err, group.id);
  }
}
