/**
 * What every MLS lifecycle hook needs from `GroupsResource`, and the two ways
 * they answer a failure: as operator-facing text, or as rine's own named
 * refusal for the one native failure that is really a membership fact.
 *
 * It sits in its own module because both halves of the lifecycle — the
 * create-time hooks in `./groups-mls-create.js` and the membership hooks in
 * `./groups-mls.js` — depend on it, and a shared type that lives inside one of
 * two peers makes the other peer's import an accident of history.
 */

import {
  MLS_ERR_GROUP_INACTIVE,
  mlsAdmissionSkipSentence,
  mlsErrorCode,
} from "@rine-network/core";
import type { MlsAdmissionResult } from "@rine-network/core";
import type { SDKHttpClient } from "../api/http.js";
import type { GroupRead, GroupUuid } from "../types.js";
import type { MessagesResource } from "./messages.js";

/**
 * The HTTP client (which carries the `configDir`), the messages resource
 * (which resolves the acting agent the same way send/inbox do, so the hooks
 * act as the agent the rest of the SDK signs as), and a group re-read.
 */
export interface GroupMlsContext {
  http: SDKHttpClient;
  messages: MessagesResource;
  getGroup(
    groupId: GroupUuid,
    signal: AbortSignal | undefined,
  ): Promise<GroupRead>;
}

/**
 * The operator-facing text of a failure a hook swallowed. Hooks report what
 * they could not do; nothing branches on this string.
 */
export function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Say which of the admitted agents got no ratchet-tree leaf, and why.
 *
 * An agent whose KeyPackage pool was empty, or whom the server refused as a
 * Welcome recipient, is in the group and cannot read a word of it until
 * somebody seats them. A plural caller also gets this in the returned report;
 * `create` and a singular invite have nowhere else to hear it, and hearing
 * nothing was the shipped behaviour this replaces. `already_in_group` is not
 * reported — it is what a resume is for.
 *
 * Each reason is rendered through rine-core's sentence map rather than printed
 * as its wire token: `no_key_package` is a fact about that agent's inventory,
 * and an operator reading a warning should not need the vocabulary to act on
 * it.
 */
export function warnUnseated(
  groupId: string,
  result: MlsAdmissionResult,
): void {
  const unseated = result.outcomes.filter(
    (outcome) =>
      outcome.status === "skipped" && outcome.reason !== "already_in_group",
  );
  if (unseated.length === 0) return;
  const named = unseated
    .map(
      (outcome) =>
        `\n  ${outcome.agentId}: ${mlsAdmissionSkipSentence(outcome.reason)}`,
    )
    .join("");
  console.warn(
    `Group ${groupId}: no MLS leaf was minted for ${unseated.length} of the ` +
      `agents it admitted. They are in the group and cannot read it until ` +
      `they are seated — publish their key packages, then run ` +
      `groups.resumeMlsAdmission("${groupId}").${named}`,
  );
}

/** Branch on this, never on the message. */
export const GROUP_EVICTED_CODE = "group_membership_removed";

/**
 * This agent was removed from the group by a Remove commit.
 *
 * The native MLS core answers every later operation on an evicted handle with
 * `RINE_MLS_GROUP_INACTIVE` — a correct statement about a ratchet tree, and an
 * unusable one for an agent trying to work out what happened to it. Eviction is
 * a membership fact, so rine states it as one: you were removed, and the way
 * back is an admin re-inviting you, which mints a new leaf and a fresh Welcome.
 */
export class GroupEvictedError extends Error {
  readonly code = GROUP_EVICTED_CODE;
  readonly groupId: string;

  constructor(groupId: string, options?: { cause?: unknown }) {
    super(
      `You were removed from group ${groupId}. Your ratchet-tree leaf is gone, ` +
        `so nothing committed to this group after the Remove will open, and ` +
        `messages that already arrived still do. Ask an admin to invite you ` +
        `again — re-admission mints a new leaf and a fresh Welcome.`,
      options,
    );
    this.name = "GroupEvictedError";
    this.groupId = groupId;
  }
}

/** True for {@link GroupEvictedError}, without needing the class in scope. */
export function isGroupEvictedError(err: unknown): err is GroupEvictedError {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === GROUP_EVICTED_CODE
  );
}

/**
 * The named refusal for a failed group operation, or the failure unchanged.
 *
 * Only one native code is translated. Everything else is left alone: a store
 * failure and an epoch conflict are this process's problems and must not be
 * reported to an agent as an eviction it can do nothing about.
 */
export function asGroupFailure(err: unknown, groupId: string): unknown {
  if (mlsErrorCode(err) !== MLS_ERR_GROUP_INACTIVE) return err;
  return new GroupEvictedError(groupId, { cause: err });
}
