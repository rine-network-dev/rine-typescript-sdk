/**
 * What to tell the operator about a removal — the sentence itself, defined once.
 *
 * It lives in its own module because the true sentence differs between the two
 * group types and between the two verbs, and nine surfaces each composing their
 * own is how one of them came to be printed for every group and be false for
 * every open one. There is one, here.
 */

import type { MlsRemovalCommit } from "@rine-network/core";
import { groupIsMls } from "../format/groups.js";
import type { AgentUuid, GroupRead, GroupUuid } from "../types.js";

/**
 * The one true sentence for this removal.
 *
 * The old sentence — "local group encryption state removed; rejoining the group
 * is the only way back in" — is false on an open group twice over: nothing
 * cryptographic ever kept a departed member out of one, and what actually
 * bounds their reach is each remaining member rotating their sender key on the
 * next send. So the sentence is chosen by the group's
 * crypto, and when this client could not read the group it says only what it
 * knows rather than picking one of the two and hoping.
 *
 * 🔴 `removal` is the whole commit, not just its epoch, because a commit that
 * landed does not imply a leaf that went: the rescue path posts
 * a path-only commit for a target that holds none. Reporting an eviction there
 * would be exactly the kind of false claim this module exists to prevent.
 */
export function removalMessage(
  group: GroupRead | null,
  groupId: GroupUuid,
  agentId: AgentUuid,
  left: boolean,
  removal: MlsRemovalCommit | undefined,
): string {
  const name = group === null ? groupId : group.handle;
  const mls = group !== null && groupIsMls(group);
  if (left && group === null) {
    return (
      `You left group ${name}. Local key material for it has been removed — ` +
      `MLS state and sender-key material alike, since this client could not ` +
      `read the group to tell which it ran on.`
    );
  }
  if (left && mls) {
    return (
      `You left group ${name}. Its local MLS state is gone — the current ` +
      `epoch secrets, every retained epoch secret and the plaintext the ` +
      `self-read cache held — so this group's messages no longer open on ` +
      `this machine, including the ones that arrived before you left. ` +
      `Rejoining the group is the only way back in.`
    );
  }
  if (left) {
    return (
      `You left group ${name}. Local sender-key material for it is gone — the ` +
      `key you were sending under, every key you had from other members, and ` +
      `the cached message keys — so this group's messages no longer open on ` +
      `this machine, including the ones that arrived before you left and were ` +
      `never read. An open group has no cryptographic eviction: what bounds ` +
      `your reach into its later traffic is each remaining member rotating ` +
      `their sender key on their next send, not this wipe.`
    );
  }
  if (removal !== undefined && removal.removedLeaf) {
    return (
      `Removed ${agentId} from group ${name}. A Remove commit at epoch ` +
      `${removal.epoch} took their ratchet-tree leaf with it, so nothing ` +
      `committed to the group from that epoch on will open for them.`
    );
  }
  if (removal !== undefined) {
    return (
      `Removed ${agentId} from group ${name}. The commit at epoch ` +
      `${removal.epoch} declared the removal, but no leaf in the ratchet tree ` +
      `carries the signing key they publish now — nothing was removed from ` +
      `the tree, so what keeps them out is this server declining to hand them ` +
      `the group's traffic. If they rotated their signing key, their old leaf ` +
      `is still there: have them rejoin, or re-invite them, so a Remove ` +
      `commit can name it.`
    );
  }
  if (mls) {
    return (
      `Removed ${agentId} from group ${name}, without a Remove commit — this ` +
      `group asked for none, so nothing was taken out of its ratchet tree and ` +
      `the eviction rests on this server declining to hand them the group's ` +
      `traffic.`
    );
  }
  return (
    `Removed ${agentId} from group ${name}. An open group has no ` +
    `cryptographic eviction: they stop receiving this group's traffic from ` +
    `the server, and what bounds their reach into its later traffic is each ` +
    `remaining member rotating their sender key on their next send.`
  );
}
