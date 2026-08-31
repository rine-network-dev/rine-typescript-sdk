/**
 * Per-member outcomes for a plural admission — the one vocabulary the create
 * roster and the plural invite both answer in.
 *
 * A batch never fails whole: naming 32 agents and having one of them revoked
 * costs that one agent their seat, not the other 31 theirs. So the server
 * reports what became of every id it was given, in the order it was given
 * them, and both routes report it in the same shape.
 *
 * The create response's two shapes live here too, because the roster report is
 * the only thing that distinguishes them.
 *
 * The reasons are the server's `GroupAdmissionSkipReason` and mean what the
 * server means by them; they are a different question from
 * `MlsAdmissionSkipReason`, which says whether an admitted agent's ratchet-tree
 * leaf was minted. An entry can be `invited` here and `no_key_package` there:
 * the voucher exists, the leaf does not yet.
 */

import { GROUP_ADMISSION_SKIP_REASONS } from "@rine-network/core";
import { z } from "zod";
import { parse } from "../api/adapters.js";
import { GroupReadSchema } from "../types.js";
import type { GroupRead } from "../types.js";

/**
 * The types and the reason vocabulary come from `@rine-network/core`, which is
 * where every rine TypeScript surface can reach them — the CLI and the MCP
 * server depend on core and not on this SDK. This module owns the **parser**;
 * it does not own a second copy of the shape, and the enum below is built from
 * core's tuple so the two can never disagree about what a reason is.
 */
export type {
  GroupAdmissionEntry,
  GroupAdmissionReport,
  GroupAdmissionSkipReason,
} from "@rine-network/core";
export { admittedAgentIds } from "@rine-network/core";

import type {
  GroupAdmissionEntry,
  GroupAdmissionReport,
} from "@rine-network/core";

/**
 * Why one requested agent id was not invited.
 *
 * `not_applicable` is the open-enrollment answer — an open group needs no
 * voucher, so there was nothing to mint and nothing went wrong. Render it with
 * `groupAdmissionSkipSentence`, not as the raw token.
 */
export const GroupAdmissionSkipReasonSchema = z.enum(
  GROUP_ADMISSION_SKIP_REASONS,
);

/**
 * What happened to one requested agent id.
 *
 * 🔴 `nominated` is a member of this enum, not just of the TypeScript union.
 * `z.enum` REJECTS what it is not told about, and it rejects the whole parse —
 * so an entry status this schema predates does not degrade to an unknown value
 * the way a loose `string` would, it throws the entire report away. An invite
 * into a `majority` or `unanimity` group answers `nominated` for every id, so
 * omitting it here would turn every such invite into a `SchemaValidationError`
 * on a call the server had already carried out.
 */
export const GroupAdmissionEntrySchema: z.ZodType<GroupAdmissionEntry> =
  z.object({
    agent_id: z.string().uuid(),
    status: z.enum(["invited", "nominated", "skipped"]),
    /** Present exactly when `status` is `"skipped"`. */
    reason: GroupAdmissionSkipReasonSchema.nullable().optional(),
  });

/** One outcome per requested id, in request order, plus the two counts. */
export const GroupAdmissionReportSchema: z.ZodType<GroupAdmissionReport> =
  z.object({
    invited: z.number().int(),
    skipped: z.number().int(),
    entries: z.array(GroupAdmissionEntrySchema),
  });

/**
 * The create response, whichever of its two shapes arrived.
 *
 * A create with no roster answers a bare `GroupRead`, byte-identical to what it
 * has always answered — which is why every shipped 0.x client keeps working. A
 * create with a roster answers `{group, roster}`, because there are per-entry
 * outcomes to carry. The envelope is detected by its own key rather than by
 * what was asked for, so a caller cannot be handed the wrong parse.
 */
export function parseCreateResponse(raw: unknown): {
  group: GroupRead;
  roster?: GroupAdmissionReport;
} {
  const envelope = raw as { group?: unknown; roster?: unknown } | null;
  if (envelope && typeof envelope === "object" && "group" in envelope) {
    return {
      group: parse(GroupReadSchema, envelope.group),
      roster: parse(GroupAdmissionReportSchema, envelope.roster),
    };
  }
  return { group: parse(GroupReadSchema, raw) };
}
