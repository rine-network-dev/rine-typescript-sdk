/**
 * Three of this SDK's refusals are declared in `rine-core` so that the CLI, the
 * MCP server and this SDK share one definition: the two group-send guards, and
 * `GroupIdentityMismatchError`. This asserts that the sharing
 * costs an SDK-only consumer nothing:
 *
 *   1. the stable codes and predicates are reachable from the SDK's own public
 *      entry point, so branching on them needs no `@rine-network/core` import;
 *   2. all three are `instanceof RineError`, the documented base of every SDK
 *      error, so a catch-all still catches them;
 *   3. neither send code lands in the `RINE_MLS_` namespace, which would
 *      classify it as a recoverable MLS read and get it NACKed and swallowed;
 *   4. the substitution refusal is `instanceof GroupIdentityMismatchError` —
 *      the class the SDK exports IS the class thrown, on both throw sites.
 *
 * Everything here imports from `./index.js` on purpose — an assertion made
 * against the source module would pass while the public surface stayed silent,
 * which is the exact defect this covers.
 */

import { isRecoverableMlsRead, mlsErrorCode } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import {
	DOWNGRADE_REFUSED_CODE,
	GROUP_IDENTITY_MISMATCH_CODE,
	GroupIdentityMismatchError,
	MLS_INIT_IN_FLIGHT_CODE,
	MLS_PENDING_SELF_CLEAR_SECONDS,
	MlsDowngradeError,
	MlsInitInFlightError,
	NotFoundError,
	RineApiError,
	RineError,
	isGroupIdentityMismatchError,
	isMlsDowngradeError,
	isMlsInitInFlightError,
} from "./index.js";
// The resource, not the entry point: `GroupsResource` is reached through a
// built `RineClient` in real use and is not exported, so a test that wants the
// refusal a consumer's `catch` sees has to construct it.
import { GroupsResource } from "./resources/groups.js";

type SDKHttpClient = import("./api/http.js").SDKHttpClient;
type GroupUuid = import("./types.js").GroupUuid;

const inFlight = () => new MlsInitInFlightError("board@acme.rine.network");
const downgrade = () => new MlsDowngradeError("f1a2b3c4");

const ASKED = "aaaaaaaa-0000-4000-8000-000000000001" as GroupUuid;
const ANSWERED = "aaaaaaaa-0000-4000-8000-000000000002";

/**
 * A client whose `GET /groups/{id}` answers about a different group, resolved
 * through `groups.resolveRef` — i.e. through `rine-core`'s UUID rung.
 *
 * Driven through the verb rather than by constructing the error, because WHICH
 * object a consumer catches is the whole finding: the refusal is minted inside
 * `rine-core`, so an assertion made against a hand-built instance would pass
 * whatever the resolve actually threw.
 */
function substituting(): GroupsResource {
	const core = {
		get: async () => ({ id: ANSWERED, handle: "#ops@acme.rine.network" }),
	};
	return new GroupsResource({
		configDir: "/tmp/rine-core-refusals",
		getCoreHttpClient: () => core,
	} as unknown as SDKHttpClient);
}

/**
 * The same substitution reached through the OTHER throw site, `groups.get`.
 *
 * Two sites raise this refusal, and two classes of one name once did the
 * raising — the core one here and an SDK-local declaration there — so a
 * consumer narrowing with `instanceof` caught whichever it had imported and
 * missed the other half of the throws. Both sites are driven for that reason.
 */
function substitutingGet(): GroupsResource {
	return new GroupsResource({
		configDir: "/tmp/rine-core-refusals",
		get: async () => ({
			id: ANSWERED,
			name: "ops",
			handle: "#ops@acme.rine.network",
			created_at: "2026-01-01T00:00:00Z",
		}),
		getCoreHttpClient: () => ({ get: async () => ({}) }),
	} as unknown as SDKHttpClient);
}

describe("the group-send refusals on the SDK's public surface", () => {
	it("codes_when_imported_from_the_sdk_entry_point_are_the_thrown_ones", () => {
		expect(MLS_INIT_IN_FLIGHT_CODE).toBe("RINE_GROUP_MLS_INIT_IN_FLIGHT");
		expect(DOWNGRADE_REFUSED_CODE).toBe("RINE_DOWNGRADE_REFUSED");
		expect((inFlight() as unknown as { code: string }).code).toBe(
			MLS_INIT_IN_FLIGHT_CODE,
		);
		expect((downgrade() as unknown as { code: string }).code).toBe(
			DOWNGRADE_REFUSED_CODE,
		);
	});

	it("predicates_when_imported_from_the_sdk_entry_point_match_their_error", () => {
		expect(isMlsInitInFlightError(inFlight())).toBe(true);
		expect(isMlsDowngradeError(downgrade())).toBe(true);
		expect(isMlsInitInFlightError(downgrade())).toBe(false);
		expect(isMlsDowngradeError(inFlight())).toBe(false);
	});

	it("self_clear_window_when_read_from_the_sdk_is_named_in_the_message", () => {
		// The operator needs to know when to retry; the constant is the single
		// source of truth for the window and the minutes are derived from it.
		const minutes = Math.round(MLS_PENDING_SELF_CLEAR_SECONDS / 60);
		expect(inFlight().message).toContain(`${minutes} minutes`);
	});

	it("refusals_when_caught_by_a_catch_all_are_instanceof_rine_error", () => {
		expect(inFlight()).toBeInstanceOf(RineError);
		expect(downgrade()).toBeInstanceOf(RineError);
	});

	it("refusals_when_narrowed_further_stay_outside_the_http_hierarchy", () => {
		// Widening `RineError` must not widen its subclasses: a caller with an
		// `instanceof NotFoundError` branch has to keep missing these.
		expect(inFlight()).not.toBeInstanceOf(RineApiError);
		expect(downgrade()).not.toBeInstanceOf(NotFoundError);
	});

	it("sdk_errors_when_asked_about_their_own_hierarchy_narrow_unchanged", () => {
		const notFound = new NotFoundError("nope");
		expect(notFound).toBeInstanceOf(NotFoundError);
		expect(notFound).toBeInstanceOf(RineApiError);
		expect(notFound).toBeInstanceOf(RineError);
	});

	it("foreign_errors_when_tested_against_rine_error_do_not_match", () => {
		expect(new Error("unrelated")).not.toBeInstanceOf(RineError);
		expect({ code: "RINE_SOMETHING_ELSE" }).not.toBeInstanceOf(RineError);
		expect(null).not.toBeInstanceOf(RineError);
	});

	it("substitution_when_thrown_by_resolve_ref_is_caught_by_the_rine_error_branch", async () => {
		// 🔴 The substitution check lives in `rine-core`'s UUID rung, which
		// `groups.resolveRef` resolves through — so the object a consumer
		// catches is the CORE `GroupIdentityMismatchError`, which extends `Error`
		// because `rine-core` cannot depend on this package. Without the widening
		// this assertion is false and the substitution escapes a catch written
		// against the documented base of every SDK error, unreported, with a
		// message byte-identical to the one `groups.get` throws.
		const raised = await substituting()
			.resolveRef(ASKED)
			.catch((e: unknown) => e);

		expect(raised).toBeInstanceOf(RineError);
		expect(isGroupIdentityMismatchError(raised)).toBe(true);
		expect((raised as { code?: string }).code).toBe(
			GROUP_IDENTITY_MISMATCH_CODE,
		);
		expect((raised as Error).message).toContain(
			`the server answered with group ${ANSWERED}`,
		);
	});

	it("substitution_when_narrowed_further_stays_outside_the_http_hierarchy", async () => {
		// The same bound the two send refusals get: widening the base must not
		// widen its subclasses, or `instanceof NotFoundError` stops meaning
		// anything. A substituted body is emphatically not a missing group.
		const raised = await substituting()
			.resolveRef(ASKED)
			.catch((e: unknown) => e);

		expect(raised).not.toBeInstanceOf(NotFoundError);
		expect(raised).not.toBeInstanceOf(RineApiError);
		expect(isMlsDowngradeError(raised)).toBe(false);
		expect(isMlsInitInFlightError(raised)).toBe(false);
	});

	it("substitution_when_narrowed_by_class_matches_the_exported_one", async () => {
		// 🔴 The half the widening could not reach. `instanceof RineError`
		// was made true by a predicate; `instanceof GroupIdentityMismatchError`
		// can only be true if the class the SDK exports IS the class thrown. It
		// was not — this package declared a second one of that name — so the
		// narrowing every docblock recommends answered false.
		const raised = await substituting()
			.resolveRef(ASKED)
			.catch((e: unknown) => e);

		expect(raised).toBeInstanceOf(GroupIdentityMismatchError);
		expect((raised as Error).name).toBe("GroupIdentityMismatchError");
	});

	it("substitution_when_thrown_by_either_site_is_one_class_and_one_sentence", async () => {
		// The two throw sites a consumer meets. One `catch` clause has to hold
		// both, and the sentence an operator reads must not depend on which door
		// the substitution came through.
		const fromResolve = await substituting()
			.resolveRef(ASKED)
			.catch((e: unknown) => e);
		const fromGet = await substitutingGet()
			.get(ASKED)
			.catch((e: unknown) => e);

		expect(fromGet).toBeInstanceOf(GroupIdentityMismatchError);
		expect(fromGet).toBeInstanceOf(RineError);
		expect((fromGet as Error).constructor).toBe(
			(fromResolve as Error).constructor,
		);
		expect((fromGet as Error).message).toBe((fromResolve as Error).message);
	});

	it("substitution_when_read_for_its_two_ids_reports_both", async () => {
		// What a caller acts on: the id it named and the id it was answered
		// with. Losing either to a class swap would leave the prose as the only
		// machine-readable account of the fault.
		const raised = (await substituting()
			.resolveRef(ASKED)
			.catch((e: unknown) => e)) as {
			requestedGroupId: string;
			answeredGroupId: string | null;
		};

		expect(raised.requestedGroupId).toBe(ASKED);
		expect(raised.answeredGroupId).toBe(ANSWERED);
	});

	it("substitution_when_the_body_named_no_group_says_so_rather_than_blank", async () => {
		// The no-id arm, byte-symmetric with the Python twin. A blank
		// before a full stop reads as a rendering bug, not as a server fault.
		const nameless = new GroupsResource({
			configDir: "/tmp/rine-core-refusals",
			getCoreHttpClient: () => ({ get: async () => ({ handle: null }) }),
		} as unknown as SDKHttpClient);

		const raised = await nameless.resolveRef(ASKED).catch((e: unknown) => e);

		expect(raised).toBeInstanceOf(GroupIdentityMismatchError);
		expect((raised as Error).message).toContain(
			"the server's answer carried no group id",
		);
		expect(
			(raised as { answeredGroupId: string | null }).answeredGroupId,
		).toBeNull();
	});

	it("refusals_when_classified_by_the_mls_core_are_not_recoverable_reads", () => {
		// `mlsErrorCode` classifies by the `RINE_MLS_` prefix. A code inside that
		// namespace would make the refusal an unprocessable commit, hence a
		// recoverable MLS read, hence NACKed and silently swallowed.
		expect(mlsErrorCode(inFlight())).toBeNull();
		expect(mlsErrorCode(downgrade())).toBeNull();
		expect(isRecoverableMlsRead(inFlight())).toBe(false);
		expect(isRecoverableMlsRead(downgrade())).toBe(false);
	});
});
