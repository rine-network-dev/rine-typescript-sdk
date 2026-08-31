/**
 * The SDK's group predicates are the `rine-core` ones, unwrapped.
 *
 * The truth table lives with the implementation
 * (`rine-core/test/crypto/group-predicates.test.ts`) and is not restated here.
 * What this file pins is the SDK's own contract: the two names it exports are
 * the same functions the CLI and the MCP server call — so a drift between
 * surfaces is impossible rather than merely unlikely — and they answer the two
 * questions correctly over a zod-parsed `GroupRead`, whose `mls_group_id` and
 * `mls_pending` are always present where `rine-core`'s interface makes them
 * optional.
 */

import {
  groupAcceptsMlsSendOnly as coreAcceptsMlsSendOnly,
  groupIsMls as coreIsMls,
  groupMlsInitInFlight as coreMlsInitInFlight,
} from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { GroupReadSchema } from "../types.js";
import {
  groupAcceptsMlsSendOnly,
  groupIsMls,
  groupMlsInitInFlight,
} from "./groups.js";

function group(over: Record<string, unknown> = {}) {
  return GroupReadSchema.parse({
    id: "33333333-3333-4333-8333-333333333333",
    name: "dev",
    handle: "#dev@acme.rine.network",
    created_at: "2026-04-11T12:00:00Z",
    ...over,
  });
}

describe("the SDK group predicates", () => {
  it("group_predicates_when_imported_from_the_sdk_are_the_rine_core_ones", () => {
    expect(groupIsMls).toBe(coreIsMls);
    expect(groupAcceptsMlsSendOnly).toBe(coreAcceptsMlsSendOnly);
    expect(groupMlsInitInFlight).toBe(coreMlsInitInFlight);
  });

  it("group_is_mls_when_group_has_an_mls_latch_returns_true", () => {
    expect(groupIsMls(group({ mls_group_id: "mls-latch-abc" }))).toBe(true);
    expect(groupIsMls(group())).toBe(false);
  });

  it("group_accepts_mls_send_only_when_init_is_pending_returns_true", () => {
    // The two questions part company exactly here: an init in flight is not
    // state to render, but the server already refuses a sender-key send.
    const pending = group({ mls_enabled: true, mls_pending: true });
    expect(groupIsMls(pending)).toBe(false);
    expect(groupAcceptsMlsSendOnly(pending)).toBe(true);
  });

  it("group_mls_init_in_flight_when_asked_over_a_parsed_group_names_the_window", () => {
    // The third state, over a zod-parsed group: present-but-false MLS fields
    // must not read as an init in flight.
    expect(
      groupMlsInitInFlight(group({ mls_enabled: true, mls_pending: true })),
    ).toBe(true);
    expect(groupMlsInitInFlight(group({ mls_group_id: "mls-abc" }))).toBe(
      false,
    );
    expect(
      groupMlsInitInFlight(
        group({ enrollment_policy: "open", mls_enabled: true }),
      ),
    ).toBe(false);
    expect(groupMlsInitInFlight(group())).toBe(false);
  });
});
