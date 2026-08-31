/**
 * Inviting one agent, or many, and what follows an invitation server-side.
 *
 * One route answers both (`POST /groups/{id}/invite`):
 * `agent_id` answers exactly what it always answered, and `agent_ids` answers a
 * per-member report. A sibling bulk route was rejected on the server for the
 * same reason there is one function here — two copies of the authorization
 * ladder that must never diverge.
 *
 * The plural form is not sugar. A closed group's invitation has to put a leaf
 * in the ratchet tree, and an MLS commit is O(N) in the group's size: seating
 * 32 invitees one at a time is 32 commits every member downloads, against one.
 *
 * On `majority` and `unanimity` an invite does something else entirely: it
 * NOMINATES. The row it files is a pending join request the group's
 * electorate decides, so nobody is seated by it, nothing is minted for the
 * nominee to spend, and the request can still be denied. Those two policies are
 * therefore the ones where this module posts no MLS commit at all — see
 * {@link seatAndNotify}.
 */

import {
  inviteNominates,
  sendGroupInviteNotification,
} from "@rine-network/core";
import { parse } from "../api/adapters.js";
import type { SDKHttpClient } from "../api/http.js";
import { InviteResultSchema } from "../types.js";
import type {
  AgentUuid,
  GroupRead,
  GroupUuid,
  InviteResult,
} from "../types.js";
import {
  type GroupAdmissionReport,
  GroupAdmissionReportSchema,
  admittedAgentIds,
} from "./groups-admission.js";
import { addMembersToMls } from "./groups-mls.js";
import type { GroupMlsContext } from "./groups-mls-context.js";
import { reasonOf } from "./groups-mls-context.js";
import type { MlsAdmissionResult } from "./groups-mls.js";

export interface InviteOptions {
  message?: string;
  signal?: AbortSignal;
}

/**
 * What a plural invite did, per agent.
 *
 * `entries` is the server's verdict on each requested id — was a voucher
 * minted, or a nomination filed — and `mls` is the client's, on whether that
 * agent's ratchet-tree leaf was minted with it. The two answer different
 * questions and an agent can be `invited` in one and skipped in the other: the
 * invitation exists, the leaf does not yet, and the next
 * {@link GroupsResource.resumeMlsAdmission} run seats it.
 */
export interface GroupInviteReport extends GroupAdmissionReport {
  /**
   * Absent when the group is not MLS-active, when nobody new was invited, and
   * when the invite NOMINATED — a nomination is decided by a vote, and no leaf
   * is minted before it carries.
   */
  mls?: MlsAdmissionResult;
}

/** POST one invitation. The response shape is unchanged from every 0.x SDK. */
export async function inviteOne(
  ctx: GroupMlsContext | null,
  http: SDKHttpClient,
  groupId: GroupUuid,
  agentId: AgentUuid,
  opts: InviteOptions | undefined,
): Promise<InviteResult> {
  const raw = await http.post<unknown>(
    `/groups/${groupId}/invite`,
    { agent_id: agentId, ...(opts?.message && { message: opts.message }) },
    { signal: opts?.signal, operation: "groupsInvite" },
  );
  const result = parse(InviteResultSchema, raw);
  if (ctx) await seatAndNotify(ctx, groupId, [agentId], opts);
  return result;
}

/** POST a batch of invitations and report what became of each one. */
export async function inviteMany(
  ctx: GroupMlsContext | null,
  http: SDKHttpClient,
  groupId: GroupUuid,
  agentIds: readonly AgentUuid[],
  opts: InviteOptions | undefined,
): Promise<GroupInviteReport> {
  const raw = await http.post<unknown>(
    `/groups/${groupId}/invite`,
    {
      agent_ids: [...agentIds],
      ...(opts?.message && { message: opts.message }),
    },
    { signal: opts?.signal, operation: "groupsInvite" },
  );
  const report = parse(GroupAdmissionReportSchema, raw);
  if (!ctx) return report;
  const mls = await seatAndNotify(ctx, groupId, admittedAgentIds(report), opts);
  return mls ? { ...report, mls } : report;
}

/**
 * Give the newly invited their ratchet-tree leaves, then tell them.
 *
 * Both halves are best-effort and neither may undo an invitation the server has
 * already minted: `GET /groups/invites` is the authoritative discovery path, and
 * an unseated invitee is seated by the next resume rather than being left out.
 *
 * The group read and the acting-agent resolve happen once for the whole batch,
 * so inviting 32 agents costs one of each rather than 32 — the same reason the
 * MLS side batches.
 *
 * 🔴 **A nomination gets the notification and no leaf.** On
 * `majority` and `unanimity` this call filed a request the electorate has not
 * decided; claiming the nominee's KeyPackage and Welcoming them here would put
 * an agent the vote may deny inside the ratchet tree, holding an epoch secret,
 * with only the manual reclamation pass able to retire the leaf afterwards —
 * and that pass cannot reach it until the row resolves. The vote seats the
 * member, and seating is what grants the key: `GroupsResource.vote` posts the
 * Add on the approve that carries, which is what the self-application path has
 * always done. The notification still goes out, because the nominee has to be
 * able to see the nomination to consent to it.
 */
async function seatAndNotify(
  ctx: GroupMlsContext,
  groupId: GroupUuid,
  agentIds: readonly string[],
  opts: InviteOptions | undefined,
): Promise<MlsAdmissionResult | undefined> {
  if (agentIds.length === 0) return undefined;
  let group: GroupRead;
  try {
    group = await ctx.getGroup(groupId, opts?.signal);
  } catch (err) {
    console.warn(
      `Invitations to group ${groupId} were minted, but the group could not ` +
        `be re-read, so no MLS leaf was added and nobody was notified (the ` +
        `invitees can still find the invitation with groups.listInvites()): ` +
        reasonOf(err),
    );
    return undefined;
  }
  // The GROUP's policy decides this, not the response: it is the same question
  // the server asked when it chose what to file, and it is answerable before
  // any per-entry status is read.
  const mls = inviteNominates(group.enrollment_policy)
    ? undefined
    : await addMembersToMls(ctx, group, agentIds, opts?.signal);
  await notifyInvitees(ctx, group, agentIds, opts);
  return mls;
}

/**
 * Best-effort: seal a `rine.v1.group_invite` DM to each invitee so their normal
 * inbox/poll/SSE path surfaces the invitation. Acts as the inviting agent
 * (resolved the same way the MLS hooks do).
 *
 * Non-fatal, per invitee — one agent whose `groups_only` policy 403s the DM
 * must not cost the other 31 their notification, and none of it can cost anyone
 * their invitation: `GET /groups/invites` is authoritative either way.
 */
export async function notifyInvitees(
  ctx: GroupMlsContext,
  group: GroupRead,
  agentIds: readonly string[],
  opts: InviteOptions | undefined,
): Promise<void> {
  const core = ctx.http.getCoreHttpClient({ signal: opts?.signal });
  let inviterId: string;
  try {
    inviterId = await ctx.messages.resolveSenderId(core, undefined);
  } catch (err) {
    console.warn(
      `Group-invite notifications for group ${group.id} were skipped: the ` +
        `inviting agent could not be resolved (the invitations still stand; ` +
        `invitees can find them with groups.listInvites()): ${reasonOf(err)}`,
    );
    return;
  }
  for (const inviteeAgentId of agentIds) {
    try {
      await sendGroupInviteNotification(
        core,
        ctx.http.configDir,
        inviterId,
        inviteeAgentId,
        {
          group_id: group.id,
          group_handle: group.handle,
          message: opts?.message ?? null,
        },
      );
    } catch (err) {
      console.warn(
        `Group-invite notification to ${inviteeAgentId} for group ${group.id} ` +
          `failed (the invitation still succeeded; they can discover it via ` +
          `groups.listInvites()): ${reasonOf(err)}`,
      );
    }
  }
}
