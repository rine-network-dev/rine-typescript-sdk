/**
 * The group predicates, as the SDK's public surface.
 *
 * The first two answer different questions and must never be swapped:
 *
 * - `groupIsMls` — the **render/state** question: does this group have MLS
 *   state a client can hold? Only a latched `mls_group_id` answers yes.
 * - `groupAcceptsMlsSendOnly` — the **send** question: will the server accept
 *   anything but an MLS message here?
 *
 * `groupMlsInitInFlight` is the third renderable state: the window where those
 * two disagree, which a surface must not render as either of them.
 *
 * `groupMlsNeverFounded` is the fourth, and the one none of the MLS columns can
 * answer: a group created to run MLS whose ratchet tree was never founded is
 * field for field an open group there, so the predicate reads what the group was
 * created FOR instead. A renderer that stops at the first three drops it into
 * the `else` with every ordinary sender-key group and says nothing — which is
 * how a group carrying `sender-key-v1` traffic under an MLS intent went
 * unreported on every surface that reads its predicates through this SDK.
 * `unfoundedGroupNote` is the sentence for that state, in the words both stacks
 * share, and it takes this surface's own spelling of the verb that founds a
 * group — `"none"`, the default, for a surface whose nearest verb refuses.
 *
 * The implementations live in `@rine-network/core`
 * (`src/crypto/group-predicates.ts`) because the CLI and the MCP server need
 * the same two answers and depend on that package, not on this one. They are
 * re-exported here — never restated — so SDK consumers keep importing them from
 * `@rine-network/sdk` and every surface shares one definition. Their own docs
 * and truth-table tests live beside the implementation.
 */

export {
  groupAcceptsMlsSendOnly,
  groupIsMls,
  groupMlsInitInFlight,
  groupMlsNeverFounded,
  unfoundedGroupNote,
} from "@rine-network/core";
export type { UnfoundedGroupRepair } from "@rine-network/core";
