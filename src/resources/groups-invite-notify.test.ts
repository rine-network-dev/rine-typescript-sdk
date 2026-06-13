/**
 * Behavioural tests for the best-effort group-invite notification wiring on
 * `GroupsResource.invite()` (group-invite-delivery, REQ-TS2).
 *
 * After a successful `POST /groups/{id}/invite` (and the existing best-effort
 * MLS add), the inviter seals a `rine.v1.group_invite` DM to the invitee so
 * their normal inbox/poll/SSE path alerts them. The authoritative discovery
 * path is the `GET /groups/invites` pull — this notification is a convenience
 * nudge, so it MUST never fail the invite.
 *
 * Verifies:
 *   1. The notification is emitted via the core `sendGroupInviteNotification`
 *      helper, carrying the resolved inviter + invitee ids and the group
 *      handle/message (SPEC §5/D6 payload).
 *   2. It is gated on `configDir && messages`, exactly like the MLS hook — a
 *      resource constructed without a `MessagesResource` sends nothing.
 *   3. A failing notification (e.g. groups_only 403, missing keys) is swallowed
 *      with a warning — the invite still resolves.
 *
 * The crypto/send boundary is mocked at the rine-core module edge so no real
 * HPKE seal or network call runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addMlsGroupMemberMock = vi.fn();
const sendGroupInviteNotificationMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		addMlsGroupMember: (...a: unknown[]) => addMlsGroupMemberMock(...a),
		sendGroupInviteNotification: (...a: unknown[]) =>
			sendGroupInviteNotificationMock(...a),
	};
});

const { GroupsResource } = await import("./groups.js");

type SDKHttpClient = import("../api/http.js").SDKHttpClient;
type MessagesResource = import("./messages.js").MessagesResource;
type GroupUuid = import("../types.js").GroupUuid;
type AgentUuid = import("../types.js").AgentUuid;

const GROUP_ID = "33333333-3333-4333-8333-333333333333" as GroupUuid;
const GROUP_HANDLE = "#dev@acme.rine.network";
const INVITEE_ID = "22222222-2222-4222-8222-222222222222" as AgentUuid;
const INVITER_ID = "11111111-1111-4111-8111-111111111111";
const CONFIG_DIR = "/tmp/rine-invite-notify";
const CORE = { __core: true };

interface Call {
	method: string;
	path: string;
	body?: unknown;
}

// HTTP stub: records calls, answers GET /groups/{id} with a sender-key group
// (mls_group_id null ⇒ the MLS add no-ops, isolating the notification path),
// and returns a pending invite result from the POST.
function makeHttp(): { http: SDKHttpClient; calls: Call[] } {
	const calls: Call[] = [];
	const group = {
		id: GROUP_ID,
		name: "dev",
		handle: GROUP_HANDLE,
		created_at: "2026-06-13T12:00:00Z",
		mls_group_id: null,
	};
	const stub = {
		configDir: CONFIG_DIR,
		getCoreHttpClient: () => CORE,
		async get<T>(p: string): Promise<T> {
			calls.push({ method: "GET", path: p });
			return group as T;
		},
		async post<T>(p: string, body?: unknown): Promise<T> {
			calls.push({ method: "POST", path: p, body });
			return { status: "pending" } as T;
		},
	} as unknown as SDKHttpClient;
	return { http: stub, calls };
}

function makeMessages(): MessagesResource {
	return {
		resolveSenderId: vi.fn(async () => INVITER_ID),
	} as unknown as MessagesResource;
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("GroupsResource.invite — group-invite notification wiring", () => {
	beforeEach(() => {
		addMlsGroupMemberMock.mockResolvedValue(undefined);
		sendGroupInviteNotificationMock.mockResolvedValue(undefined);
	});

	it("seals a rine.v1.group_invite notification to the invitee after the POST", async () => {
		const { http } = makeHttp();
		const groups = new GroupsResource(http, makeMessages());

		await groups.invite(GROUP_ID, INVITEE_ID, { message: "join us" });

		expect(sendGroupInviteNotificationMock).toHaveBeenCalledTimes(1);
		expect(sendGroupInviteNotificationMock).toHaveBeenCalledWith(
			CORE,
			CONFIG_DIR,
			INVITER_ID,
			INVITEE_ID,
			{ group_id: GROUP_ID, group_handle: GROUP_HANDLE, message: "join us" },
		);
	});

	it("passes message:null when no invite message is supplied", async () => {
		const { http } = makeHttp();
		const groups = new GroupsResource(http, makeMessages());

		await groups.invite(GROUP_ID, INVITEE_ID);

		expect(sendGroupInviteNotificationMock).toHaveBeenCalledTimes(1);
		const payload = sendGroupInviteNotificationMock.mock.calls[0]?.[4] as {
			message: string | null;
		};
		expect(payload.message).toBeNull();
	});

	it("skips the notification when no MessagesResource is wired (no configDir/messages gate)", async () => {
		const { http } = makeHttp();
		const groups = new GroupsResource(http); // no messages ⇒ gate closed

		await groups.invite(GROUP_ID, INVITEE_ID, { message: "hi" });

		expect(sendGroupInviteNotificationMock).not.toHaveBeenCalled();
	});

	it("swallows a failing notification — the invite still succeeds", async () => {
		sendGroupInviteNotificationMock.mockRejectedValue(
			new Error("groups_only: recipient rejects non-group DMs"),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { http } = makeHttp();
		const groups = new GroupsResource(http, makeMessages());

		const result = await groups.invite(GROUP_ID, INVITEE_ID, {
			message: "join us",
		});

		expect(result.status).toBe("pending");
		expect(sendGroupInviteNotificationMock).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
