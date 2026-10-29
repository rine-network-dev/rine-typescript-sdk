/**
 * Behavioural tests for the MLS join wiring on `GroupsResource.join()`.
 *
 * The ladder behind the join (Welcome, seat retake, external commit) is
 * rine-core's `establishMlsMembership`, tested against the real native core in
 * rine-core. What this file pins is what the SDK does around it on a 200 or 202:
 * which calls it makes, what it warns and what it raises. The 409
 * `already_a_member` path is in `groups-mls-join-seated.test.ts`.
 *
 * Core is mocked at the module boundary so no real MLS crypto runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_ID,
	CONFIG_DIR,
	GROUP_ID,
	makeHttp,
	makeMessages,
	outcome,
} from "../_groups-join-stub.js";

const establishMlsMembershipMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		establishMlsMembership: (...a: unknown[]) => establishMlsMembershipMock(...a),
	};
});

const { GroupsResource } = await import("./groups.js");
const { MlsWelcomeRefusedError } = await import("@rine-network/core");

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	establishMlsMembershipMock.mockResolvedValue(outcome("installed"));
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.clearAllMocks();
	warn.mockRestore();
});

describe("GroupsResource.join — MLS join wiring", () => {
	it("establishes the state for the named group as the resolved agent", async () => {
		const groups = new GroupsResource(makeHttp().http, makeMessages());

		const result = await groups.join(GROUP_ID);

		expect(result.status).toBe("joined");
		expect(establishMlsMembershipMock).toHaveBeenCalledTimes(1);
		// Keyed by the rine group UUID the caller named, acting as the resolved agent.
		expect(establishMlsMembershipMock).toHaveBeenCalledWith(
			CONFIG_DIR,
			AGENT_ID,
			GROUP_ID,
			expect.anything(),
			{ "X-Rine-Agent": AGENT_ID },
		);
		expect(warn).not.toHaveBeenCalled();
	});

	it("does not set anything up for a request pending approval", async () => {
		const pending = {
			id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			group_id: GROUP_ID,
			agent_id: AGENT_ID,
			status: "pending",
			created_at: "2026-04-12T00:00:00.000Z",
		};
		const groups = new GroupsResource(
			makeHttp(async () => ({ status: 202, body: pending })).http,
			makeMessages(),
		);

		const result = await groups.join(GROUP_ID);

		expect(result.status).toBe("pending");
		expect(establishMlsMembershipMock).not.toHaveBeenCalled();
	});

	it("says nothing when the group has no ratchet tree", async () => {
		establishMlsMembershipMock.mockResolvedValue(outcome("not_mls"));
		const groups = new GroupsResource(makeHttp().http, makeMessages());

		const result = await groups.join(GROUP_ID);

		expect(result.status).toBe("joined");
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns with the reason of a failed step — the join still succeeds", async () => {
		establishMlsMembershipMock.mockResolvedValue(
			outcome("failed", { reason: "no published GroupInfo" }),
		);
		const groups = new GroupsResource(makeHttp().http, makeMessages());

		const result = await groups.join(GROUP_ID);

		expect(result.status).toBe("joined");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(
			`MLS join setup for group ${GROUP_ID} failed (group reads will retry on demand): no published GroupInfo`,
		);
	});

	it("warns when the establishment throws an ordinary error — the join still succeeds", async () => {
		establishMlsMembershipMock.mockRejectedValue(new Error("socket hang up"));
		const groups = new GroupsResource(makeHttp().http, makeMessages());

		const result = await groups.join(GROUP_ID);

		expect(result.status).toBe("joined");
		expect(String(warn.mock.calls[0]?.[0])).toContain("socket hang up");
	});

	it("raises a refusal for the group instead of warning", async () => {
		establishMlsMembershipMock.mockRejectedValue(
			new MlsWelcomeRefusedError(GROUP_ID, "peer_not_admitted", "tree holds a member"),
		);
		const groups = new GroupsResource(makeHttp().http, makeMessages());

		await expect(groups.join(GROUP_ID)).rejects.toMatchObject({
			code: "RINE_WELCOME_REFUSED",
			groupId: GROUP_ID,
			reason: "peer_not_admitted",
		});
		expect(warn).not.toHaveBeenCalled();
	});
});
