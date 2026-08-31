/**
 * `groups.sync()` — the group recovery verb — on the SDK's public surface.
 *
 * The verb returns a `GroupRecoveryResult` — the union of the two regimes, not
 * one of its arms — and refuses with an `MlsResyncUnavailableError`. If neither
 * reaches the package entry point, a third-party consumer of
 * `@rine-network/ts-sdk` cannot name what the call returns and cannot branch the
 * refusal by class — only match the raw code string, which is the failure mode
 * the group-shape exports already exist to prevent.
 *
 * Everything here imports from `./index.js` on purpose: an assertion made
 * against `resources/groups.js` would pass while the public surface stayed
 * silent, which is exactly the defect this covers.
 */

import { describe, expect, it } from "vitest";
import {
	MlsResyncUnavailableError,
	RineError,
	isMlsResyncUnavailable,
} from "./index.js";
import type {
	GroupRecoveryResult,
	MlsRecoveryResult,
	SenderKeyRecoveryResult,
} from "./index.js";

const unavailable = () =>
	new MlsResyncUnavailableError("11111111-1111-4111-8111-111111111111");

// A type-only import erases, so the pin has to be a value the compiler was
// forced to check. Each of these fails `tsc` — not vitest — if the union stops
// reaching the entry point or stops admitting the arm it is written as.
const SENDER_KEY: SenderKeyRecoveryResult = {
	regime: "sender-key",
	ingested: 2,
	retired: false,
};

const MLS: MlsRecoveryResult = {
	regime: "mls",
	rung: "replay",
	fromEpoch: 4,
	epoch: 9,
	behind: 5,
	processed: 5,
	evicted: false,
};

/** How a consumer is meant to read the result: on the discriminant, and on
 * nothing else. Written as a real narrowing so the compiler proves that reading
 * `ingested` needs the sender-key arm and reading `epoch` needs the MLS one —
 * and so that every assertion below runs through a function, rather than
 * reading a literal's own field back off the literal three lines above it. */
function summarise(result: GroupRecoveryResult): string {
	if (result.regime === "mls") return `at epoch ${result.epoch}`;
	// Zero-with-a-reason must be tellable from a plain zero, or a consumer
	// reports "nothing was waiting" for an agent whose material was refused.
	if (result.retired) return "retired here";
	return `installed ${result.ingested}`;
}

describe("the group recovery surface at the SDK entry point", () => {
	it("the_result_union_when_imported_from_the_entry_point_admits_both_regimes", () => {
		const both: GroupRecoveryResult[] = [SENDER_KEY, MLS];

		expect(both.map((r) => r.regime)).toEqual(["sender-key", "mls"]);
	});

	it("the_result_when_read_by_its_discriminant_narrows_to_one_regimes_fields", () => {
		expect(summarise(SENDER_KEY)).toBe("installed 2");
		expect(summarise(MLS)).toBe("at epoch 9");
	});

	it("a_sender_key_recovery_carries_the_retirement_fact_the_operator_needs", () => {
		// The one sender-key outcome with a remedy attached: nothing was
		// installed because this agent's own material was retired here and
		// nothing lifted that. A zero that means "refused" and a zero that means
		// "nothing was waiting" must not collapse into one answer — so both go
		// through `summarise`, rather than each literal being read back off
		// itself three lines below where it was written.
		const retired: SenderKeyRecoveryResult = {
			regime: "sender-key",
			ingested: 0,
			retired: true,
		};
		const nothingWaiting: SenderKeyRecoveryResult = {
			regime: "sender-key",
			ingested: 0,
			retired: false,
		};

		expect(summarise(retired)).toBe("retired here");
		expect(summarise(nothingWaiting)).toBe("installed 0");
		expect(summarise(SENDER_KEY)).toBe("installed 2");
	});

	it("the_refusal_class_when_imported_from_the_entry_point_constructs", () => {
		expect(unavailable()).toBeInstanceOf(MlsResyncUnavailableError);
		expect(unavailable().name).toBe("MlsResyncUnavailableError");
	});

	it("the_refusal_carries_the_group_it_names", () => {
		expect(unavailable().groupId).toBe("11111111-1111-4111-8111-111111111111");
	});

	it("the_predicate_when_imported_from_the_entry_point_matches_its_error", () => {
		expect(isMlsResyncUnavailable(unavailable())).toBe(true);
	});

	it("the_predicate_when_given_anything_else_does_not_match", () => {
		expect(isMlsResyncUnavailable(new Error("unrelated"))).toBe(false);
		expect(isMlsResyncUnavailable({ code: "something_else" })).toBe(false);
		expect(isMlsResyncUnavailable(null)).toBe(false);
		expect(isMlsResyncUnavailable(undefined)).toBe(false);
	});

	it("the_refusal_names_a_remedy_the_operator_can_act_on", () => {
		// Absent local state has no recovery at this end: the leaf a resync
		// replaces is named by the stale state itself. The message has to say so,
		// or the operator retries a call that can never succeed.
		expect(unavailable().message).toContain("remove this agent");
		expect(unavailable().message).toContain("invite it again");
	});

	it("the_refusal_stays_outside_the_rine_error_hierarchy", () => {
		// Declared in rine-core over the platform `Error`, not over `RineError`.
		// Pinned so a later reparenting is a deliberate change rather than a
		// silent one for anyone with a catch-all branch.
		expect(unavailable()).toBeInstanceOf(Error);
		expect(unavailable()).not.toBeInstanceOf(RineError);
	});
});
