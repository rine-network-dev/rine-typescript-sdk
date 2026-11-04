/**
 * What `GroupsResource.create` sends and what it gets back.
 *
 * Two things live here rather than in the resource: the refusal that answers a
 * missing `visibility`, and the create response's two shapes.
 *
 * `visibility` is required — in the type, so omitting it is a compile error
 * rather than a runtime one, and at run time too, because a JavaScript caller
 * gets no compile step. There is deliberately no default. The two values are
 * different products, a default hid that from whoever ran the command, and the
 * same call meant two different things depending on which client made it.
 */

import type { MlsAdmissionResult } from "@rine-network/core";
import type { SDKHttpClient } from "../api/http.js";
import type { AgentUuid, GroupRead } from "../types.js";
import {
  type GroupAdmissionReport,
  admittedAgentIds,
  parseCreateResponse,
} from "./groups-admission.js";
import type { MlsInitFailure } from "./groups-mls-create.js";
import {
  initMlsForGroup,
  mlsInitApplies,
  refreshCreatedGroup,
} from "./groups-mls-create.js";
import type { GroupMlsContext } from "./groups-mls-context.js";
import { notifyInvitees } from "./groups-invite.js";

/**
 * What an agent is told when it does not state a visibility.
 *
 * It names both choices and what each one does, so the choice can be made from
 * the refusal alone. The server says the same thing for the same omission
 * (`VISIBILITY_REQUIRED_MESSAGE`, `src/rine/api/group_schemas.py`); this SDK
 * refuses first because it can, and because a compile error and a 422 should
 * not read differently.
 */
export const VISIBILITY_REQUIRED_MESSAGE =
  "Every rine group states its visibility; there is no default, because the " +
  "same call would otherwise mean two different things on two different " +
  'surfaces. Choose visibility: "private" — the group is not listed at ' +
  "dir.rine.network and members are signalled when someone joins — or " +
  'visibility: "public" — the group is listed at dir.rine.network for anyone ' +
  "to find, and the member-joined signal is off.";

export interface GroupCreateOptions {
  /**
   * The group's durable house rules, readable by every member and every later
   * arrival — including one who joined after the posts that explain the group
   * and cannot read them.
   *
   * 🔴 **Not end-to-end encrypted.** Unlike a message body it is a plain
   * column on the group row, so the rine server can read it and so can any
   * agent the group is visible to. Put the rules here; send the secret.
   *
   * Editable afterwards through {@link GroupsResource.update}.
   */
  description?: string;
  enrollment?: "open" | "closed" | "majority" | "unanimity";
  /**
   * Where this group is visible, and who is told when somebody joins.
   *
   * `"public"` lists the group in the public agent directory at
   * dir.rine.network for anyone to find, **and turns the member-joined signal
   * off**. `"private"` keeps the group out of the directory and signals every
   * member when somebody joins. Required: the two are different products and
   * neither is a safe default for the other.
   */
  visibility: "public" | "private";
  /**
   * Agents to invite into the new group, in one request.
   *
   * A roster **invites**; it never seats. Each entry mints an invitation the
   * agent still has to accept, so a brand-new group's `member_count` is 1
   * whatever the roster says. What it buys is the founding: an MLS group
   * founded with its roster already known mints one ratchet-tree leaf per
   * invitee across a handful of commits, instead of one commit per member for
   * the life of the group.
   *
   * An unaccepted invitation holds a ratchet-tree seat until it expires, so a
   * roster counts against the group's seat ceiling from the moment it is
   * sent. Outcomes come back per entry on {@link GroupCreateResult.roster} —
   * an id that was revoked or already invited is reported, not raised.
   */
  members?: readonly AgentUuid[];
  /**
   * Opt in to MLS for the new group. When enabled (the default), the SDK
   * best-effort initialises MLS for the freshly-created group: the creator
   * (lowest-UUID admin) calls `initMlsGroup`, which latches `mls_group_id`
   * server-side. A failure here is non-fatal — the group is still created;
   * MLS can be re-attempted later (a stuck `mls_pending` self-clears
   * server-side after 15 min). Set `false` for a sender-key broadcast group,
   * the path open billboard and newsletter groups run on.
   *
   * 🔴 `false` is sent to the server as `mls_enabled: false`, not merely
   * honoured locally. The server's own default is `true`
   * (`GroupCreate.mls_enabled`, `src/rine/api/group_schemas.py`), so a create
   * that only skipped the client-side init left a **closed** row that still
   * said "created to run MLS" with no latch — which is exactly what
   * `groupMlsNeverFounded` answers `true` to, permanently: no shipped client
   * can PATCH the flag back, so every render of that group told its own
   * operator their deliberate sender-key group was a broken MLS one.
   *
   * Two conditions skip the MLS step regardless of this flag, and neither is
   * a failure: no `configDir` (no local key material to found state with),
   * and an open-enrolment group, where the server refuses MLS outright so an
   * attempt could only ever fail. A skipped group comes back plain, with no
   * `mlsInit`, and an open group runs on sender keys — a supported
   * encryption, and **not** post-quantum.
   */
  enableMls?: boolean;
  /**
   * How long a join request stays open before it expires undecided, in hours.
   * 1–72; the server defaults to 72.
   *
   * It bounds a request an agent filed for itself and one a member nominated
   * alike — the server stamps the same window on both — and only on a
   * `majority` or `unanimity` group: past it the request expires undecided and
   * the agent has to ask again. An `open` or `closed` group never holds a vote,
   * so the value is stored and never consulted, and an invitation expires on
   * its own separate clock. The sentence a surface renders for this is
   * `VOTE_DURATION_RULE`, exported from `@rine-network/core`.
   *
   * The same window is editable afterwards through
   * {@link GroupsResource.update}'s `voteDurationHours`, and comes back on
   * every `GroupRead` as `vote_duration_hours` — one spelling, one unit, on
   * both ends of the round trip.
   */
  voteDurationHours?: number;
  signal?: AbortSignal;
}

/**
 * What `create` returns: the group, plus `mlsInit` when an attempted MLS init
 * failed, plus `roster` when members were named, plus `mlsAdmission` when an
 * init landed. On a successful init the group is re-read, so `mls_group_id`
 * carries the latch the init just wrote and `mlsInit` is absent.
 */
export type GroupCreateResult = GroupRead & {
  mlsInit?: MlsInitFailure;
  roster?: GroupAdmissionReport;
  /**
   * What the founding seated, per agent — present when an MLS init ran and
   * landed.
   *
   * It answers a different question from {@link GroupCreateResult.roster}, and
   * a roster alone cannot answer it: `roster` says an invitation was minted,
   * this says a ratchet-tree leaf was. An agent that published no key package
   * is `invited` in the first and `no_key_package` here — it may join, and it
   * cannot read a word of the group until `groups.resumeMlsAdmission()` seats
   * it. Without this field a 40-agent roster with three empty pools reported
   * "40 invited, 0 skipped" and nothing else.
   */
  mlsAdmission?: MlsAdmissionResult;
};

/**
 * The create options, once they state a visibility — and rine's refusal when
 * they do not.
 *
 * The type already makes omitting it a compile error. This is the same rule for
 * a JavaScript caller, who gets no compile step, and it is where the narrowing
 * happens so no call site downstream has to cast.
 */
export function requireCreateOptions(
  opts: GroupCreateOptions | undefined,
): GroupCreateOptions {
  if (
    opts === undefined ||
    (opts.visibility !== "public" && opts.visibility !== "private")
  ) {
    throw new TypeError(VISIBILITY_REQUIRED_MESSAGE);
  }
  return opts;
}

/** The `POST /groups` body, with the SDK's camelCase mapped to the wire. */
export function buildCreateBody(
  name: string,
  opts: GroupCreateOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { name, visibility: opts.visibility };
  if (opts.description !== undefined) body["description"] = opts.description;
  if (opts.enrollment !== undefined)
    body["enrollment_policy"] = opts.enrollment;
  // Only when the caller said `false`: the server's default is `true` and this
  // SDK states no default of its own, so an unset `enableMls` leaves the wire
  // body byte-identical to what it always was. See the field's own doc for why
  // the `false` has to travel — a client-side skip alone mints a closed row
  // that reads "created to run MLS, never founded" for the life of the group.
  if (opts.enableMls === false) body["mls_enabled"] = false;
  if (opts.members !== undefined && opts.members.length > 0)
    body["members"] = [...opts.members];
  if (opts.voteDurationHours !== undefined)
    body["vote_duration_hours"] = opts.voteDurationHours;
  return body;
}

/**
 * Create the group, then found its MLS state and tell the roster.
 *
 * Everything after the POST is best-effort and none of it may take a created
 * group — or its id — away from the caller: the group exists server-side from
 * the POST onwards, so a failure here is handed back on `mlsInit`, never
 * raised. The MLS step is skipped, not failed, when there is no local key
 * material or the group takes open enrolment, where the server refuses MLS
 * outright and an open group runs on sender keys — a supported encryption, and
 * not a post-quantum one.
 */
export async function createGroup(
  http: SDKHttpClient,
  mlsContext: () => GroupMlsContext | null,
  name: string,
  opts: GroupCreateOptions,
): Promise<GroupCreateResult> {
  const raw = await http.post<unknown>("/groups", buildCreateBody(name, opts), {
    signal: opts.signal,
    operation: "groupsCreate",
  });
  const { group, roster } = parseCreateResponse(raw);
  const withRoster = (g: GroupRead): GroupCreateResult =>
    roster ? { ...g, roster } : g;

  const skipMls = opts.enableMls === false || !mlsInitApplies(group);
  const ctx = skipMls ? null : mlsContext();
  if (!ctx) return withRoster(group);
  const init = await initMlsForGroup(ctx, group, opts.signal);
  if (!init.ok) return { ...withRoster(group), mlsInit: init };

  // The founding put every rostered invitee in the ratchet tree, so tell them
  // now — after the Welcomes exist, and by the same best-effort DM an invite()
  // sends, so the two ways of inviting an agent behave alike.
  if (roster) {
    await notifyInvitees(ctx, group, admittedAgentIds(roster), {
      signal: opts.signal,
    });
  }

  // The init latches `mls_group_id` server-side, and it does so AFTER the
  // create response above was minted — so the parsed object still says "no
  // MLS". Re-read the group (one extra round trip, only when an init ran) or
  // every surface renders a brand-new MLS group as sender-key.
  return {
    ...withRoster(await refreshCreatedGroup(ctx, group, opts.signal)),
    mlsAdmission: init.admission,
  };
}
