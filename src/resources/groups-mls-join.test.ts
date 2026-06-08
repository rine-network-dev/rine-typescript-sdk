/**
 * Behavioural tests for the MLS join wiring on `GroupsResource.join()`
 * (Phase 6 — open-enrollment external-commit self-join).
 *
 * Verifies the fallback ladder inside `installMlsWelcomesIfMls`:
 *   1. `processMlsWelcomes` always runs for an MLS-active group.
 *   2. If a Welcome installed local state (`loadMlsState` non-null) the
 *      external-join orchestrator is NOT called.
 *   3. If NO local state exists after the Welcome path (open enrollment), the
 *      `externalJoinMlsGroup` orchestrator IS called — keyed by the rine group
 *      UUID — as a best-effort fallback.
 *   4. Sender-key groups (`mls_group_id === null`) trigger neither.
 *
 * Core is mocked at the module boundary so no real MLS crypto runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processMlsWelcomesMock = vi.fn();
const externalJoinMlsGroupMock = vi.fn();
const loadMlsStateMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		processMlsWelcomes: (...a: unknown[]) => processMlsWelcomesMock(...a),
		externalJoinMlsGroup: (...a: unknown[]) => externalJoinMlsGroupMock(...a),
		loadMlsState: (...a: unknown[]) => loadMlsStateMock(...a),
	};
});

const { GroupsResource } = await import("./groups.js");

type SDKHttpClient = import("../api/http.js").SDKHttpClient;
type MessagesResource = import("./messages.js").MessagesResource;
type GroupUuid = import("../types.js").GroupUuid;

const GROUP_ID = "33333333-3333-4333-8333-333333333333" as GroupUuid;
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CONFIG_DIR = "/tmp/rine-mls-join";
const MLS_GROUP_ID = "mls-latch-abc";

interface Call {
	method: string;
	path: string;
}

// HTTP stub: records calls and answers GET /groups/{id} with the supplied
// `mls_group_id` latch so the resource can branch on MLS activation.
function makeHttp(mlsGroupId: string | null): {
	http: SDKHttpClient;
	calls: Call[];
} {
	const calls: Call[] = [];
	const group = {
		id: GROUP_ID,
		name: "dev",
		handle: "#dev@acme.rine.network",
		created_at: "2026-04-11T12:00:00Z",
		mls_group_id: mlsGroupId,
	};
	const stub = {
		configDir: CONFIG_DIR,
		getCoreHttpClient: () => ({ __core: true }),
		async get<T>(p: string): Promise<T> {
			calls.push({ method: "GET", path: p });
			return group as T;
		},
		async postWithStatus<T>(
			p: string,
		): Promise<{ status: number; body: T }> {
			calls.push({ method: "POST", path: p });
			return {
				status: 200,
				body: {
					id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					group_id: GROUP_ID,
					agent_id: AGENT_ID,
					role: "member",
					joined_at: "2026-04-12T00:00:00.000Z",
					agent_handle: "bot@acme.rine.network",
				} as T,
			};
		},
	} as unknown as SDKHttpClient;
	return { http: stub, calls };
}

// Minimal MessagesResource stand-in: only `resolveSenderId` is used by the
// MLS lifecycle hooks. Resolving it is what binds the acting agent.
function makeMessages(): MessagesResource {
	return {
		resolveSenderId: vi.fn(async () => AGENT_ID),
	} as unknown as MessagesResource;
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("GroupsResource.join — MLS join wiring (Phase 6)", () => {
	beforeEach(() => {
		processMlsWelcomesMock.mockResolvedValue(undefined);
		externalJoinMlsGroupMock.mockResolvedValue({ epoch: 2 });
	});

	it("self-joins via external commit when no Welcome installed local state", async () => {
		// Open enrollment: the Welcome path leaves no state for this group.
		loadMlsStateMock.mockReturnValue(null);
		const { http } = makeHttp(MLS_GROUP_ID);
		const groups = new GroupsResource(http, makeMessages());

		const result = await groups.join(GROUP_ID);

		expect(result.status).toBe("joined");
		expect(processMlsWelcomesMock).toHaveBeenCalledTimes(1);
		expect(externalJoinMlsGroupMock).toHaveBeenCalledTimes(1);
		// Keyed by the rine group UUID, acting as the resolved agent.
		expect(externalJoinMlsGroupMock).toHaveBeenCalledWith(
			CONFIG_DIR,
			AGENT_ID,
			GROUP_ID,
			expect.anything(),
			{ "X-Rine-Agent": AGENT_ID },
		);
	});

	it("does NOT self-join when a Welcome already installed local state", async () => {
		// Closed/invite enrollment: a member minted a Welcome → state exists.
		loadMlsStateMock.mockReturnValue({
			stateBlob: new Uint8Array([1]),
			metadata: { groupId: GROUP_ID, epoch: 1, cipherSuite: 0x0001 },
		});
		const { http } = makeHttp(MLS_GROUP_ID);
		const groups = new GroupsResource(http, makeMessages());

		await groups.join(GROUP_ID);

		expect(processMlsWelcomesMock).toHaveBeenCalledTimes(1);
		expect(externalJoinMlsGroupMock).not.toHaveBeenCalled();
	});

	it("skips all MLS hooks for a sender-key group (mls_group_id null)", async () => {
		const { http } = makeHttp(null);
		const groups = new GroupsResource(http, makeMessages());

		await groups.join(GROUP_ID);

		expect(processMlsWelcomesMock).not.toHaveBeenCalled();
		expect(externalJoinMlsGroupMock).not.toHaveBeenCalled();
	});

	it("swallows a failing external join — the join still succeeds", async () => {
		loadMlsStateMock.mockReturnValue(null);
		externalJoinMlsGroupMock.mockRejectedValue(
			new Error("no published GroupInfo"),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { http } = makeHttp(MLS_GROUP_ID);
		const groups = new GroupsResource(http, makeMessages());

		const result = await groups.join(GROUP_ID);

		expect(result.status).toBe("joined");
		expect(externalJoinMlsGroupMock).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
