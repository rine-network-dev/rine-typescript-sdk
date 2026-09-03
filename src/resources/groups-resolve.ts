/**
 * Turning what a caller says into the group the server knows.
 *
 * Every group verb documents that it takes "a handle, a name or a UUID", and
 * until now this resource took a UUID and the send path kept a private handle
 * lookup of its own — so the promise was kept in one place and printed in
 * several. This module is that promise, once: `GroupsResource.resolveRef`
 * exposes it to callers, `MessagesResource` uses it on the send path, and the
 * transcript read uses it to find the group it is about to read.
 *
 * The lookup itself is `rine-core`'s (`resolveGroup`) — the CLI and the MCP
 * server reach the same three rungs through the same function, because a
 * refusal that differed per surface would be a refusal that drifts. What this module adds is the SDK's own
 * contract: every response crosses the boundary through its Zod schema, and an
 * id that is about to become a URL path segment is branded, not asserted.
 */

import { GroupReadSchema, parse } from "../api/adapters.js";
import { asGroupUuid } from "../types.js";
import type { GroupHandle, GroupRead, GroupUuid } from "../types.js";
import {
  type HttpClient as CoreHttpClient,
  resolveGroup,
  resolveGroupUuidForJoin,
} from "@rine-network/core";

/**
 * The group a reference named, and everything the resolve already knows.
 *
 * The same four fields, with the same meanings, as `rine-core`'s
 * `SeatedGroupTarget` and the Python SDK's `rine.GroupTarget` — plus this
 * package's two guarantees: `id` is branded, so it goes into a route without a
 * cast, and `row` has crossed `GroupReadSchema`, so it is the same shape
 * {@link GroupsResource.get} answers with and not the looser wire object.
 *
 * `row` is why this is a record and not an id. Hand it back to a group verb
 * that reads the group BEFORE it writes and the verb spends no
 * `GET /groups/{id}` of its own ({@link GroupSelector}); a caller that got an id
 * alone had to buy the row a second time.
 *
 * 🔴 The row is spent exactly as handed over, so it is as current as the
 * resolve that produced it. That is the point when the two calls are adjacent,
 * and it is a hazard when a record is stored: `mls_group_id` latches one way
 * and `enrollment_policy` is editable, so a long-lived record can tell
 * `removeMember` that an MLS group runs sender keys. Re-resolve rather than
 * cache, or pass `.id` and buy the fresh row. The verbs whose read happens
 * after their own POST never spend it at all — see {@link GroupSelector}.
 *
 * `handle` is what the send path addresses — `POST /messages` looks `to_handle`
 * up by exact equality — and `spelling` is the caller's own argument, byte for
 * byte: never the local part a fallback matched on, never a normalised form. It
 * is the only string a refusal may quote back.
 *
 * 🔴 `handle` is branded for one concrete reason: `client.send` takes
 * `AgentHandle | AgentUuid | GroupHandle | GroupUuid`, so an unbranded string
 * made `client.send(g.handle, …)` — the correct call — a compile error while
 * `client.send(g.id, …)` compiled and resolved the UUID in the AGENT namespace.
 * The brand is asserted, not guarded: it is the server's own handle off a row
 * that has already crossed `GroupReadSchema`, and refusing a resolve because a
 * server-side handle did not match a client-side regex would turn a naming
 * quirk into an unreachable group.
 *
 * 🔴 Named differently from both twins on purpose. A consumer of this SDK
 * routinely imports `@rine-network/core` as well, which exports a `GroupTarget`
 * of its own with an unbranded id and an unparsed row. Two types of one name
 * reached down two import paths is the confusion a distinct name here avoids.
 */
export interface ResolvedGroup {
  readonly id: GroupUuid;
  readonly handle: GroupHandle;
  readonly spelling: string;
  readonly row: GroupRead;
}

/**
 * What a group verb that READS the group accepts: the group's UUID, or the
 * record {@link GroupsResource.resolveRef} answered with.
 *
 * Handing the record over is what removes the duplicate read: the verb's own
 * `GET /groups/{id}` is served from the row the resolve already paid for, at
 * the one seam every such verb goes through (`GroupsResource.mlsContext`).
 * Nothing is re-derived at the call site — the id and the row come out of one
 * record and cannot name two different groups, which is the drift this shape
 * closes.
 *
 * 🔴 **Four of the six verbs that take this actually fold.** `removeMember`,
 * `leave`, `sync` and `resumeMlsAdmission` read the group before they write, so
 * the resolve's row is the answer. `invite` and `vote` read it AFTER their own
 * POST — the invite's nomination filing, the vote's approval — and a read whose
 * whole job is to see what the POST did cannot be served from a row read
 * before it. They accept a record for symmetry and buy the row anyway.
 *
 * 🔴 Only the verbs that read the group row take this. A verb that never reads
 * it saves nothing by being handed one, and `join` takes a `GroupUuid` alone by
 * design: its target is a group this org holds no seat in, so it resolves
 * through {@link resolveGroupRefForJoin}, which answers with an id and no row
 * on every rung. A record from `resolveRef` is the wrong answer to hand it.
 */
export type GroupSelector = GroupUuid | ResolvedGroup;

/** The id every route needs, and the row when the caller already had one. */
export function selectGroup(target: GroupSelector): {
  id: GroupUuid;
  row: GroupRead | undefined;
} {
  return typeof target === "string"
    ? { id: target, row: undefined }
    : { id: target.id, row: target.row };
}

/**
 * Resolve any group reference — handle, bare name, or UUID — to the group.
 *
 * A UUID costs one indexed `GET /groups/{id}` and no more — the group's own
 * row, served to the org that owns the group as well as to one seated in it.
 * An id this caller may not read is refused with the roster of the groups they
 * do have, and that second read is the only one a refused id costs.
 *
 * Every rung of the member ladder has the row in hand, so the answer carries it
 * ({@link ResolvedGroup}) rather than dropping it at this boundary: dropping it
 * is what made a caller pay `GET /groups/{id}` twice, one verb apart.
 *
 * @throws {TypeError} The reference resolved to something that is not a UUID.
 * @throws {GroupIdentityMismatchError} `GET /groups/{id}` answered about a
 *   group other than the one it was asked for.
 * @throws {Error} No group, or more than one, answers to that reference.
 * @throws {z.ZodError} The group's row does not satisfy `GroupReadSchema`. New
 *   with the record: the id this used to answer with needed no row. It is the
 *   same throw {@link GroupsResource.get} has always made off the same body and
 *   the same schema — `parse` is a bare `schema.parse` throughout this package
 *   — so it is NOT a `RineError` and a consumer narrowing on that base does not
 *   catch it.
 */
export async function resolveGroupRef(
  core: CoreHttpClient,
  ref: string,
  extraHeaders?: Record<string, string>,
): Promise<ResolvedGroup> {
  const target = await resolveGroup(core, ref, { extraHeaders });
  return {
    // `target.id` IS `target.row.id` — `seatedGroupTarget` reads it off the row
    // — so branding it here brands the row's own id and cannot introduce a
    // second answer to "which group is this".
    id: asGroupUuid(target.id),
    // Asserted, not guarded — see {@link ResolvedGroup}'s 🔴 paragraph.
    handle: target.handle as GroupHandle,
    spelling: target.spelling,
    row: parse(GroupReadSchema, target.row),
  };
}

/**
 * Resolve a group reference for `join`, the one verb aimed OUTSIDE the org.
 *
 * 🔴 A separate ladder on purpose, not a widening of {@link resolveGroupRef}.
 * Every rung that one takes is scoped to a group this org already owns or is
 * seated in — for every other group verb the right scope, and for a join the
 * one set the target cannot be in. `resolveGroupUuidForJoin` (`rine-core`) adds
 * the two rungs that can see a group you are not in, this agent's invitations
 * and the public directory, and reads a bare name against those invitations
 * alone: the rungs, the bounds and every refusal live there, with the reasons.
 *
 * @throws {TypeError} The reference resolved to something that is not a UUID.
 * @throws {Error} No rung answered the reference, or two invitations did.
 */
export async function resolveGroupRefForJoin(
  core: CoreHttpClient,
  ref: string,
  extraHeaders?: Record<string, string>,
): Promise<GroupUuid> {
  return asGroupUuid(await resolveGroupUuidForJoin(core, ref, extraHeaders));
}
