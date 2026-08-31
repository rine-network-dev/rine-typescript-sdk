/**
 * Taking a member out of a group — which is two different operations wearing
 * one route, and only one of them is a leave.
 *
 * **A kick costs a commit.** Deleting the member row evicts nobody on an MLS
 * group: the leaf stays in the ratchet tree and every epoch secret the evicted
 * agent holds stays valid, so the removal would be enforced by the server's
 * delivery filter and nothing else. So a real Remove commit is posted — while
 * the target is still a member, which is what puts the commit in their delivery
 * queue, so their client learns it was removed instead of going quiet — and the
 * DELETE is then repeated naming the epoch it landed at.
 *
 * **The commit declares who it removes.** The server spends that
 * declaration once per named agent, so a commit posted without `removes`
 * authorises no removal at all. 🔴 It is client-asserted: a passthrough server
 * never opens the commit blob and does not verify that the leaf really went.
 * A target holding no leaf still gets a commit — a path-only one — because that
 * is the only way to finish a removal whose commit landed and whose DELETE did
 * not, and the result says plainly that no leaf was taken.
 *
 * 🔴 **The DELETE goes first, and the commit only when the server asks for it.**
 * Which removals need one is the server's answer, not a guess made here, and
 * the order is a security control rather than a style: `POST /mls/commit` is
 * membership-gated only, so committing before the DELETE evicts the target
 * before the server has said whether the caller may. A refused removal leaves
 * the member row exactly where it was, so the commit still lands while the
 * target is a member.
 *
 * 🔴 `mls_removal_epoch` is a **query parameter**, not a body field. Sending it
 * in a JSON body — the shape every other rine mutation uses — binds nothing
 * server-side, and the removal is then refused for want of the commit that was
 * just posted.
 *
 * **A leave costs the keys.** MLS gives nobody a way to commit their own
 * removal, so leaving carries no commit; what it carries is the local wipe, and
 * the server DELETE runs first so a refused leave never leaves a still-member
 * without the keys to read its own group.
 *
 * What the wipe means is **not the same for the two group types**, which is why
 * this module returns the sentence rather than leaving each surface to invent
 * one.
 */

import { ACTING_AGENT_HEADER } from "@rine-network/core";
import type { MlsRemovalCommit } from "@rine-network/core";
import {
  agentKeysExist,
  deleteGroupReadCache,
  deleteMlsState,
  deleteSenderKey,
  holdsMlsState,
  needsRemovalCommit,
  senderKeyStateExists,
} from "@rine-network/core";
import type { SDKHttpClient } from "../api/http.js";
import { groupIsMls } from "../format/groups.js";
import type { AgentUuid, GroupRead, GroupUuid } from "../types.js";
import { postRemoveCommit } from "./groups-removal-leaf.js";
import { removalMessage } from "./groups-removal-message.js";
import { type GroupMlsContext, reasonOf } from "./groups-mls-context.js";

/** What a removal did, and what to tell the operator about it. */
export interface GroupRemovalResult {
  /** True when the acting agent removed itself — a leave, not a kick. */
  left: boolean;
  /**
   * The crypto this group runs, or `null` when this client could not tell:
   * with no local key material it never reads the group, because there is
   * nothing it could have done differently either way.
   */
  encryption: "mls" | "sender-key" | null;
  /** The epoch the Remove commit landed at. Absent when none was posted. */
  mlsRemovalEpoch?: number;
  /**
   * Whether that commit actually took a ratchet-tree leaf. Absent when no
   * commit was posted; `false` when one was, but the target held no leaf to
   * take. The commit still declares the removal, so the DELETE can land
   * without claiming an eviction that did not happen.
   */
  mlsRemovedLeaf?: boolean;
  /** True when this agent's local key material for the group was retired. */
  localStateRetired: boolean;
  /**
   * One accurate sentence for this removal and this group type. Surfaces print
   * it rather than composing their own, because the true sentence differs
   * between the two group types and nine surfaces guessing produced one that
   * was false for open groups.
   */
  message: string;
}

/** Remove a member, doing whatever this group's crypto requires of it. */
export async function removeGroupMember(
  ctx: GroupMlsContext | null,
  http: SDKHttpClient,
  groupId: GroupUuid,
  agentId: AgentUuid,
  signal: AbortSignal | undefined,
  agent?: string,
): Promise<GroupRemovalResult> {
  const actingId = ctx
    ? await resolveActingAgent(ctx, agentId, signal, agent)
    : null;
  if (ctx === null || actingId === null) {
    await deleteMember(http, groupId, agentId, undefined, signal, undefined);
    return {
      left: false,
      encryption: null,
      localStateRetired: false,
      message: `Removed ${agentId} from group ${groupId}.`,
    };
  }

  const left = actingId.toLowerCase() === agentId.toLowerCase();
  const group = await readGroup(ctx, groupId, signal);
  const mls = group !== null && groupIsMls(group);
  const removal = await deleteMemberEvictingIfAsked(
    ctx,
    http,
    groupId,
    agentId,
    { actingId, group, left, mls },
    signal,
  );

  const retired = left && retireLocalState(ctx, actingId, groupId);
  return {
    left,
    encryption: group === null ? null : mls ? "mls" : "sender-key",
    ...(removal === undefined
      ? {}
      : {
          mlsRemovalEpoch: removal.epoch,
          mlsRemovedLeaf: removal.removedLeaf,
        }),
    localStateRetired: retired,
    message: removalMessage(group, groupId, agentId, left, removal),
  };
}

/** What this removal is, as far as the client could tell before asking. */
interface RemovalShape {
  actingId: string;
  group: GroupRead | null;
  left: boolean;
  mls: boolean;
}

/**
 * Drop the membership row, posting the Remove commit only when the server asks
 * for one. Returns what that commit did, or `undefined` when none was needed.
 *
 * 🔴 **The order is the security control.** `POST /groups/{id}/mls/commit` is
 * gated on membership alone — the commit blob is opaque, so the server cannot
 * see that it evicts anybody — while the authorization to evict is decided on
 * the DELETE. Committing first therefore takes the target's leaf out of the
 * ratchet tree *before* the server has said whether the caller may take it, and
 * the two refusals a kick can draw both leave real, irreversible damage: a
 * plain member's 403'd kick evicts the victim permanently from a group that
 * still lists them, and a 422 "cannot remove the last admin" strands that admin
 * without a leaf, so nobody can ever commit to the group again.
 *
 * So the DELETE goes first and the server names the rule, exactly as the CLI
 * and the Python SDK already did. A sender-key group pays nothing for this: it
 * is never asked for a commit.
 */
async function deleteMemberEvictingIfAsked(
  ctx: GroupMlsContext,
  http: SDKHttpClient,
  groupId: GroupUuid,
  agentId: AgentUuid,
  shape: RemovalShape,
  signal: AbortSignal | undefined,
): Promise<MlsRemovalCommit | undefined> {
  const { actingId, group, left, mls } = shape;
  try {
    await deleteMember(http, groupId, agentId, undefined, signal, actingId);
    return undefined;
  } catch (err) {
    if (!needsRemovalCommit(err) || left || !mls || group === null) throw err;
    // A target holding no leaf gets a path-only commit rather than a re-raise:
    // the rescue is the whole point, because a removal whose commit landed and
    // whose DELETE failed can be completed no other way.
    const removal = await postRemoveCommit(
      ctx,
      actingId,
      group,
      agentId,
      signal,
    );
    await deleteMember(http, groupId, agentId, removal.epoch, signal, actingId);
    return removal;
  }
}

/**
 * `DELETE /groups/{id}/members/{id}`, naming the Remove commit's epoch and the
 * agent doing the removing.
 *
 * 🔴 `X-Rine-Agent` is what makes a **leave** possible at all. The server tells
 * a leave from a kick by comparing the acting agent to the target, and it
 * resolves the actor from this header (`get_optional_acting_agent`); with no
 * header and more than one active agent in the org it cannot decide, treats the
 * call as a kick, and refuses it until a Remove commit is posted — a commit MLS
 * gives nobody a way to mint for their own removal. So an unpinned multi-agent
 * org could neither leave nor kick. The commit path next door has always named
 * the agent; this one did not, and that asymmetry was the whole defect.
 */
async function deleteMember(
  http: SDKHttpClient,
  groupId: GroupUuid,
  agentId: AgentUuid,
  epoch: number | undefined,
  signal: AbortSignal | undefined,
  actingId: string | undefined,
): Promise<void> {
  await http.delete(`/groups/${groupId}/members/${agentId}`, {
    signal,
    operation: "groupsRemoveMember",
    ...(actingId === undefined
      ? {}
      : { extraHeaders: { [ACTING_AGENT_HEADER]: actingId } }),
    // A query parameter, not a body field. As a body field it binds nothing and
    // the server then refuses the removal for want of a commit that was posted.
    ...(epoch === undefined ? {} : { params: { mls_removal_epoch: epoch } }),
  });
}

/**
 * Who is acting, or `null` when this client cannot tell — in which case it
 * cannot tell a leave from a kick either, and says so rather than guessing.
 * The removal itself is still attempted; the server has its own opinion about
 * whether it is allowed.
 *
 * `agent` is the caller's own answer to the question. Without it a multi-agent
 * org has no answer at all — `resolveAgent` refuses to guess between two — so
 * naming the agent is the only way those orgs reach either verb.
 */
async function resolveActingAgent(
  ctx: GroupMlsContext,
  agentId: AgentUuid,
  signal: AbortSignal | undefined,
  agent: string | undefined,
): Promise<string | null> {
  try {
    const core = ctx.http.getCoreHttpClient({ signal });
    return await ctx.messages.resolveSenderId(core, agent);
  } catch (err) {
    console.warn(
      `Removing ${agentId}: the acting agent could not be resolved, so this ` +
        `client cannot tell a leave from a kick — no Remove commit was posted ` +
        `and no local state was retired: ${reasonOf(err)}`,
    );
    return null;
  }
}

/** The group, or `null` when it could not be read. */
async function readGroup(
  ctx: GroupMlsContext,
  groupId: GroupUuid,
  signal: AbortSignal | undefined,
): Promise<GroupRead | null> {
  try {
    return await ctx.getGroup(groupId, signal);
  } catch (err) {
    console.warn(
      `Group ${groupId} could not be read before the removal, so this client ` +
        `does not know which crypto it runs: no Remove commit was posted ` +
        `(an MLS group will refuse the removal until one is): ${reasonOf(err)}`,
    );
    return null;
  }
}

/**
 * Retire this agent's local key material for the group it just left.
 *
 * Both primitives run, whichever crypto the group uses: each is idempotent and
 * costs one unlink that finds no file, and branching on a group read that may
 * have failed would be the one way to leave keys behind.
 *
 * 🔴 The return value reports what was **held**, sampled before the wipe — not
 * merely that this agent holds key material of some kind. `agentKeysExist`
 * answers the second question, and answering the first with it made an agent
 * that was invited into a closed group, seated by the admin's Add commit and
 * never installed its Welcome hear "its local MLS state is gone — the current
 * epoch secrets, every retained epoch secret and the plaintext the self-read
 * cache held", of which it had none. The Python twin
 * (`rine-sdk/src/rine/_mls/leave.py`) has always sampled first, so the two
 * shipped SDKs reported opposite facts about the same leave.
 */
function retireLocalState(
  ctx: GroupMlsContext,
  actingId: string,
  groupId: GroupUuid,
): boolean {
  if (!agentKeysExist(ctx.http.configDir, actingId)) return false;
  const held =
    holdsMlsState(ctx.http.configDir, actingId, groupId) ||
    senderKeyStateExists(ctx.http.configDir, actingId, groupId);
  deleteMlsState(ctx.http.configDir, actingId, groupId);
  deleteSenderKey(ctx.http.configDir, actingId, groupId);
  // The plaintext this client kept so an inbox entry could be read twice goes
  // with the keys. A re-read buffer that outlived the wipe would make the
  // sentence this leave prints — that the group's messages no longer open —
  // false.
  deleteGroupReadCache(ctx.http.configDir, actingId, groupId);
  return held;
}
