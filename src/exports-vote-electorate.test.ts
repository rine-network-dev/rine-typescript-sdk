/**
 * The electorate a join request is decided by, on the SDK's public surface.
 *
 * Two things are covered here, and both have already failed once in this
 * package. A field absent from `JoinRequestReadSchema` is STRIPPED by zod with
 * no error — that is how `enrollment_policy` vanished from `discoverGroups()`
 * — so every new field is round-tripped through the schema rather than merely
 * declared. And a type absent from the package entry point cannot be named by
 * a consumer, which is how `groups.sync()` shipped with its own result and
 * error types unexported; so everything here imports from `./index.js`, never
 * from the module that declares it.
 *
 * The refusal half is measured end to end through `SDKHttpClient`: the server's
 * error CODE is what a caller branches on, and reading it out of a consumed
 * `Response` is impossible, so the extraction has to happen in the same parse
 * that produces the detail.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDKHttpClient } from "./api/http.js";
import {
	AuthorizationError,
	type JoinRequestRead,
	JoinRequestReadSchema,
	VOTE_ELECTORATE_RULE,
	VoteEligibility,
	type VoteEligibilityReason,
	inviteNominates,
	rineErrorCode,
} from "./index.js";

/** A pending row as the server sends one once it records electorates. */
const recorded = {
	id: "11111111-1111-4111-8111-111111111111",
	group_id: "22222222-2222-4222-8222-222222222222",
	agent_id: "33333333-3333-4333-8333-333333333333",
	status: "pending",
	created_at: "2026-08-03T00:00:00Z",
	expires_at: "2026-08-10T00:00:00Z",
	quorum_total_members: 9,
	electorate_size: 3,
	approvals: 1,
	denials: 0,
	approvals_needed: 1,
	denials_needed: 2,
	your_vote: null,
	you_may_vote: true,
	you_may_vote_reason: VoteEligibility.InElectorate,
};

describe("JoinRequestReadSchema carries the electorate", () => {
	it("the_eight_reported_fields_when_the_server_sends_them_survive_the_parse", () => {
		const row = JoinRequestReadSchema.parse(recorded);
		expect(row.quorum_total_members).toBe(9);
		expect(row.electorate_size).toBe(3);
		expect(row.approvals).toBe(1);
		expect(row.denials).toBe(0);
		expect(row.approvals_needed).toBe(1);
		expect(row.denials_needed).toBe(2);
		expect(row.you_may_vote).toBe(true);
		expect(row.you_may_vote_reason).toBe("in_electorate");
	});

	it("a_denial_shortfall_when_the_server_sends_zero_is_not_read_as_absent", () => {
		// 🔴 `0` and "this server does not report it" are different facts, and
		// `denials_needed: 0` is the sharpest moment on the row — one more
		// denial does not refuse it, the denials already cast do. A schema that
		// let a falsy value fall through to a default would report the request
		// as ordinary at the instant it stopped being so.
		const row = JoinRequestReadSchema.parse({ ...recorded, denials_needed: 0 });
		expect(row.denials_needed).toBe(0);
	});

	it("a_refused_voter_when_listed_reads_the_reason_that_predicts_the_403", () => {
		const row = JoinRequestReadSchema.parse({
			...recorded,
			you_may_vote: false,
			you_may_vote_reason: VoteEligibility.NotInElectorate,
		});
		expect(row.you_may_vote).toBe(false);
		expect(row.you_may_vote_reason).toBe("not_in_electorate");
	});

	it("an_empty_electorate_when_listed_reports_zero_and_no_reachable_bar", () => {
		const row = JoinRequestReadSchema.parse({
			...recorded,
			electorate_size: 0,
			approvals_needed: null,
			you_may_vote: false,
			you_may_vote_reason: VoteEligibility.ElectorateEmpty,
		});
		expect(row.electorate_size).toBe(0);
		expect(row.approvals_needed).toBeNull();
	});

	it("an_invitation_when_listed_leaves_every_counted_field_null", () => {
		const row = JoinRequestReadSchema.parse({
			...recorded,
			status: "invited",
			quorum_total_members: null,
			electorate_size: null,
			approvals: null,
			denials: null,
			approvals_needed: null,
			you_may_vote: false,
			you_may_vote_reason: VoteEligibility.NotPending,
		});
		expect(row.electorate_size).toBeNull();
		expect(row.approvals).toBeNull();
		expect(row.you_may_vote_reason).toBe("not_pending");
	});

	it("a_server_that_predates_the_electorate_defaults_to_any_member_may_vote", () => {
		// Production is one of these: it sends neither field, and its own rule is
		// that any current member may vote. A required field here would throw the
		// whole page away instead.
		const { you_may_vote, you_may_vote_reason, ...older } = recorded;
		const row = JoinRequestReadSchema.parse(older);
		expect(row.you_may_vote).toBe(true);
		expect(row.you_may_vote_reason).toBe("electorate_not_recorded");
	});

	it("an_invitation_from_an_older_server_is_not_open_for_voting", () => {
		// The default used to be a flat `electorate_not_recorded`, which reads
		// "you can vote" — on the one population nobody votes on. `POST …/vote`
		// answers 422 there, so the reason mis-predicted the refusal, which is
		// the single invariant this whole read model is built on.
		const { you_may_vote, you_may_vote_reason, ...older } = recorded;
		const row = JoinRequestReadSchema.parse({ ...older, status: "invited" });
		expect(row.you_may_vote).toBe(false);
		expect(row.you_may_vote_reason).toBe("not_pending");
	});

	it("a_reason_this_sdk_predates_degrades_instead_of_throwing", () => {
		const row = JoinRequestReadSchema.parse({
			...recorded,
			you_may_vote_reason: "some_future_reason",
		});
		expect(row.you_may_vote_reason).toBe("some_future_reason");
	});
});

describe("the vote-eligibility surface at the SDK entry point", () => {
	it("the_reason_enum_when_imported_from_the_entry_point_names_all_eight", () => {
		// The order is frozen, because the same
		// order is what `PROTOCOL.md` and the published reference table list.
		expect(Object.values(VoteEligibility)).toEqual([
			"in_electorate",
			"electorate_not_recorded",
			"not_in_electorate",
			"already_voted",
			"electorate_empty",
			"bar_unreachable",
			"is_applicant",
			"not_pending",
		]);
	});

	it("an_applicant_reading_its_own_request_is_told_so_and_not_that_it_arrived_late", () => {
		// 🔴 The invariant: the reason predicts the refusal one-to-one. The
		// applicant used to be told `not_in_electorate` — "you were not in the
		// group when this was filed" — directly above "join request submitted",
		// and the vote route answers a plain membership 403 there, not the
		// electorate one.
		const row = JoinRequestReadSchema.parse({
			...recorded,
			you_may_vote: false,
			you_may_vote_reason: VoteEligibility.IsApplicant,
		});
		expect(row.you_may_vote_reason).toBe("is_applicant");
		expect(row.you_may_vote).toBe(false);
	});

	it("a_request_no_recorded_electorate_can_decide_is_not_called_empty", () => {
		// `electorate_empty` asserts something about a recorded set; a row filed
		// before electorates existed has none, so the honest token is the one
		// that says nobody can decide it.
		const row = JoinRequestReadSchema.parse({
			...recorded,
			quorum_total_members: null,
			electorate_size: null,
			approvals_needed: null,
			denials_needed: null,
			you_may_vote: false,
			you_may_vote_reason: VoteEligibility.BarUnreachable,
		});
		expect(row.you_may_vote_reason).toBe("bar_unreachable");
		expect(row.denials_needed).toBeNull();
	});

	it("either_new_reason_from_a_server_that_sends_no_flag_still_derives_no_vote", () => {
		// The transform fills `you_may_vote` in for a server that sends only the
		// reason. Both new tokens are refusals, so neither may derive `true`.
		for (const reason of [
			VoteEligibility.IsApplicant,
			VoteEligibility.BarUnreachable,
		]) {
			const { you_may_vote, ...withoutFlag } = recorded;
			const row = JoinRequestReadSchema.parse({
				...withoutFlag,
				you_may_vote_reason: reason,
			});
			expect(row.you_may_vote).toBe(false);
		}
	});

	it("the_row_and_reason_types_when_imported_from_the_entry_point_name_a_value", () => {
		const reason: VoteEligibilityReason = VoteEligibility.NotInElectorate;
		const row: JoinRequestRead = JoinRequestReadSchema.parse(recorded);
		expect(reason).toBe("not_in_electorate");
		expect(row.id).toBe(recorded.id);
	});
});

describe("the rule and the policy predicate at the SDK entry point", () => {
	it("the_electorate_rule_when_imported_from_the_entry_point_is_the_pinned_text", () => {
		// A consumer that cannot reach the sentence writes its own, and a
		// second wording is how a model comes to believe a rule the server does
		// not implement. rine-core owns it; this asserts the SDK hands it on.
		expect(VOTE_ELECTORATE_RULE).toContain(
			"decided by the members the group had when it was filed",
		);
		expect(VOTE_ELECTORATE_RULE).toContain("Denials refuse it");
	});

	it("the_vote_docstring_still_states_the_rule_the_constant_pins", () => {
		// 🔴 A JSDoc cannot interpolate a constant, so `groups.vote()` carries
		// its own copy of the sentence — and a duplicated literal is exactly
		// what let six TypeScript surfaces state the previous rule while the
		// Python constant was re-pinned, with no gate catching it. This is that
		// gate for the one copy this package owns.
		const source = readFileSync(
			new URL("./resources/groups.ts", import.meta.url),
			"utf8",
		);
		const prose = source.replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ");
		expect(prose).toContain(VOTE_ELECTORATE_RULE.replace(/\s+/g, " "));
	});

	it("the_policy_predicate_when_imported_from_the_entry_point_answers", () => {
		// The SDK's own invite path branches on this, so a consumer rendering
		// what an invite did has to be able to ask the same question.
		expect(inviteNominates("unanimity")).toBe(true);
		expect(inviteNominates("closed")).toBe(false);
	});
});

/** An `SDKHttpClient` whose pipeline answers with one canned error body. */
function refusing(status: number, body: unknown): SDKHttpClient {
	return new SDKHttpClient({
		apiUrl: "https://api.test",
		middleware: [
			async () =>
				new Response(JSON.stringify(body), {
					status,
					headers: { "content-type": "application/json" },
				}),
		],
	});
}

describe("a refusal the server names", () => {
	it("a_403_when_the_body_carries_an_error_code_reaches_the_caller", async () => {
		const http = refusing(403, {
			error: "not_in_electorate",
			detail: "This request is decided by the members this group had.",
		});
		const err = await http
			.post(
				"/groups/g/requests/r/vote",
				{ vote: "approve" },
				{
					unauthenticated: true,
					operation: "groupsVote",
				},
			)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthorizationError);
		expect(rineErrorCode(err)).toBe("not_in_electorate");
		expect((err as AuthorizationError).detail).toContain(
			"decided by the members",
		);
	});

	it("a_403_with_no_code_when_read_reports_none_rather_than_guessing", async () => {
		const http = refusing(403, { detail: "Permission denied" });
		const err = await http
			.get("/groups/g/requests", {
				unauthenticated: true,
				operation: "groupsListRequests",
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthorizationError);
		expect(rineErrorCode(err)).toBeUndefined();
	});

	it("anything_that_is_not_an_api_error_when_asked_for_a_code_has_none", () => {
		expect(rineErrorCode(new Error("boom"))).toBeUndefined();
		expect(rineErrorCode(undefined)).toBeUndefined();
	});
});
