/**
 * `GroupsResource.join()` for an agent that is already a member: the 409
 * `already_a_member` path that brings a seated agent with no local state back.
 *
 * That path is rine-core's `seatedMemberAfterConflict`, tested in rine-core
 * (which outcomes seat, which 409s stand, a members read that does not name the
 * agent); this file fakes that one call and pins what the SDK owns around it:
 * the join it describes, the SDK's own members read, the warning a failed setup
 * earns, the joined answer, and the error that stands whenever it answers null.
 */

import type { MlsMembershipResult } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_ID,
	CONFIG_DIR,
	GROUP_ID,
	MEMBER_ROW,
	alreadyAMember,
	makeHttp,
	makeMessages,
	outcome,
} from "../_groups-join-stub.js";

interface Join {
	configDir: string;
	groupId: string;
	client: unknown;
	actingAgent: () => Promise<string>;
}
type Seat = (
	conflict: unknown,
	join: Join,
	onFailed: (failed: MlsMembershipResult) => void,
	readMembers: (headers: Record<string, string>) => Promise<readonly { agent_id: string }[]>,
) => Promise<unknown>;

const seatedMemberAfterConflictMock = vi.fn<Seat>();

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		seatedMemberAfterConflict: (...a: Parameters<Seat>) => seatedMemberAfterConflictMock(...a),
	};
});

const { GroupsResource } = await import("./groups.js");
const { ConflictError } = await import("../errors-classes.js");
const { MlsWelcomeRefusedError } = await import("@rine-network/core");

/** The helper as it answers for a seat it finished: the acting agent's row. */
const seatFromRoster: Seat = async (_conflict, join, _onFailed, readMembers) => {
	const agentId = await join.actingAgent();
	return (await readMembers({})).find((m) => m.agent_id === agentId) ?? null;
};

beforeEach(() => {
	seatedMemberAfterConflictMock.mockImplementation(seatFromRoster);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe("GroupsResource.join — an agent that is already a member", () => {
	const conflict = alreadyAMember();
	const join409 = async (): Promise<never> => {
		throw conflict;
	};

	it("reports joined with the member row read through the SDK", async () => {
		const { http, paths } = makeHttp(join409, [
			{ ...MEMBER_ROW, agent_id: "22222222-2222-4222-8222-222222222222" },
			MEMBER_ROW,
		]);
		const groups = new GroupsResource(http, makeMessages());

		const result = await groups.join(GROUP_ID);

		expect(result).toMatchObject({ status: "joined", member: { agent_id: AGENT_ID } });
		expect(paths.filter((p) => p.endsWith("/members"))).toHaveLength(1);
		const [seenConflict, join] = seatedMemberAfterConflictMock.mock.calls[0] ?? [];
		expect(seenConflict).toBe(conflict);
		expect(join).toMatchObject({
			configDir: CONFIG_DIR,
			groupId: GROUP_ID,
			client: { __core: true },
		});
	});

	it("raises the join's own error when the helper answers null", async () => {
		seatedMemberAfterConflictMock.mockResolvedValue(null);
		const other = new ConflictError("Conflict");
		other.code = "something_else";
		const failing = async (): Promise<never> => {
			throw other;
		};
		const groups = new GroupsResource(makeHttp(failing).http, makeMessages());

		await expect(groups.join(GROUP_ID)).rejects.toBe(other);
	});

	it("warns once with the setup's reason when the helper reports a failed setup", async () => {
		seatedMemberAfterConflictMock.mockImplementation(async (_c, _j, onFailed) => {
			onFailed(outcome("failed", { reason: "socket hang up" }) as MlsMembershipResult);
			return null;
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const groups = new GroupsResource(makeHttp(join409).http, makeMessages());

		await expect(groups.join(GROUP_ID)).rejects.toMatchObject({
			status: 409,
			code: "already_a_member",
		});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("socket hang up");
	});

	it("raises the refusal when the setup meets one", async () => {
		seatedMemberAfterConflictMock.mockRejectedValue(
			new MlsWelcomeRefusedError(GROUP_ID, "peer_not_admitted", "tree holds a member"),
		);
		const groups = new GroupsResource(makeHttp(join409).http, makeMessages());

		await expect(groups.join(GROUP_ID)).rejects.toMatchObject({
			reason: "peer_not_admitted",
		});
	});

	it("raises the 409 when the members read does not name the agent", async () => {
		const groups = new GroupsResource(makeHttp(join409, []).http, makeMessages());

		await expect(groups.join(GROUP_ID)).rejects.toMatchObject({ status: 409 });
	});
});
