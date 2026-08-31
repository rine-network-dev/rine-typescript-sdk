/**
 * Leaving a group takes this agent's local key material with it — and says
 * something true about what that means, which is not the same sentence for the
 * two group types.
 *
 * A departing member of a closed group that keeps its epoch secrets can still
 * decrypt group traffic, so the MLS store goes. An open group has no
 * cryptographic eviction at all: the sender-key material goes too, but what
 * bounds a departed member's reach is each remaining member rotating on their
 * next send. Saying "rejoining the group is the only way back in" there was
 * false, and it is what this file pins.
 *
 * Removing somebody else (a kick) must not touch local state.
 *
 * Core is mocked at the module boundary so no real MLS or sender-key store is
 * opened.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const deleteMlsStateMock = vi.fn();
const deleteSenderKeyMock = vi.fn();
const agentKeysExistMock = vi.fn();
const holdsMlsStateMock = vi.fn();
const senderKeyStateExistsMock = vi.fn();
const removeMlsGroupMemberMock = vi.fn();
const openMlsGroupMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    deleteMlsState: (...a: unknown[]) => deleteMlsStateMock(...a),
    deleteSenderKey: (...a: unknown[]) => deleteSenderKeyMock(...a),
    agentKeysExist: (...a: unknown[]) => agentKeysExistMock(...a),
    holdsMlsState: (...a: unknown[]) => holdsMlsStateMock(...a),
    senderKeyStateExists: (...a: unknown[]) => senderKeyStateExistsMock(...a),
    removeMlsGroupMember: (...a: unknown[]) => removeMlsGroupMemberMock(...a),
    openMlsGroup: (...a: unknown[]) => openMlsGroupMock(...a),
  };
});

const { GroupsResource } = await import("./groups.js");

type SDKHttpClient = import("../api/http.js").SDKHttpClient;
type MessagesResource = import("./messages.js").MessagesResource;
type GroupUuid = import("../types.js").GroupUuid;
type AgentUuid = import("../types.js").AgentUuid;

const GROUP_ID = "33333333-3333-4333-8333-333333333333" as GroupUuid;
const AGENT_ID = "11111111-1111-4111-8111-111111111111" as AgentUuid;
const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222" as AgentUuid;
const CONFIG_DIR = "/tmp/rine-group-leave";

interface DeleteCall {
  path: string;
  params?: Record<string, unknown>;
}

/** `mlsLatch: null` is an open (sender-key) group; a string is an MLS group. */
function makeHttp(mlsLatch: string | null): {
  http: SDKHttpClient;
  deletes: DeleteCall[];
} {
  const deletes: DeleteCall[] = [];
  const stub = {
    configDir: CONFIG_DIR,
    getCoreHttpClient: () => ({ get: async () => ({ keys: {} }) }),
    async get<T>(): Promise<T> {
      return {
        id: GROUP_ID,
        name: "dev",
        handle: "#dev@acme.rine.network",
        created_at: "2026-04-11T12:00:00Z",
        mls_group_id: mlsLatch,
      } as T;
    },
    async delete(
      path: string,
      opts?: { params?: Record<string, unknown> },
    ): Promise<void> {
      deletes.push({ path, ...(opts?.params ? { params: opts.params } : {}) });
    },
  } as unknown as SDKHttpClient;
  return { http: stub, deletes };
}

function makeMessages(): MessagesResource {
  return {
    resolveSenderId: vi.fn(async () => AGENT_ID),
  } as unknown as MessagesResource;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GroupsResource.removeMember — the leave wipe", () => {
  it("leaving a closed group retires the MLS store and the sender keys", async () => {
    agentKeysExistMock.mockReturnValue(true);
    holdsMlsStateMock.mockReturnValue(true);
    senderKeyStateExistsMock.mockReturnValue(true);
    const { http, deletes } = makeHttp("mls-latch-abc");
    const groups = new GroupsResource(http, makeMessages());

    const result = await groups.removeMember(GROUP_ID, AGENT_ID);

    expect(deletes).toEqual([
      { path: `/groups/${GROUP_ID}/members/${AGENT_ID}` },
    ]);
    // Both primitives run whichever crypto the group ran: each is idempotent,
    // and branching on a group read that can fail is how keys get left behind.
    expect(deleteMlsStateMock).toHaveBeenCalledWith(
      CONFIG_DIR,
      AGENT_ID,
      GROUP_ID,
    );
    expect(deleteSenderKeyMock).toHaveBeenCalledWith(
      CONFIG_DIR,
      AGENT_ID,
      GROUP_ID,
    );
    // A leave posts no Remove commit — MLS gives nobody a way to commit
    // their own removal — so no epoch is named.
    expect(removeMlsGroupMemberMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      left: true,
      encryption: "mls",
      localStateRetired: true,
    });
    expect(result.mlsRemovalEpoch).toBeUndefined();
  });

  it("leaving a closed group still says rejoining is the only way back", async () => {
    agentKeysExistMock.mockReturnValue(true);
    holdsMlsStateMock.mockReturnValue(true);
    senderKeyStateExistsMock.mockReturnValue(true);
    const { http } = makeHttp("mls-latch-abc");
    const groups = new GroupsResource(http, makeMessages());

    const { message } = await groups.removeMember(GROUP_ID, AGENT_ID);

    expect(message).toContain("local MLS state is gone");
    expect(message).toContain("Rejoining the group is the only way back in");
  });

  it("leaving an open group says what actually bounds the departure", async () => {
    agentKeysExistMock.mockReturnValue(true);
    holdsMlsStateMock.mockReturnValue(true);
    senderKeyStateExistsMock.mockReturnValue(true);
    const { http } = makeHttp(null);
    const groups = new GroupsResource(http, makeMessages());

    const { message, encryption } = await groups.removeMember(
      GROUP_ID,
      AGENT_ID,
    );

    expect(encryption).toBe("sender-key");
    expect(message).toContain("Local sender-key material");
    expect(message).toContain("rotating their sender key on their next send");
    // The false half of the old sentence. An open group has no
    // cryptographic eviction, so nothing about the wipe keeps anybody out.
    expect(message).not.toContain("only way back in");
  });

  it("removing somebody else leaves local key material alone", async () => {
    agentKeysExistMock.mockReturnValue(true);
    holdsMlsStateMock.mockReturnValue(true);
    senderKeyStateExistsMock.mockReturnValue(true);
    const { http } = makeHttp(null);
    const groups = new GroupsResource(http, makeMessages());

    const result = await groups.removeMember(GROUP_ID, OTHER_AGENT_ID);

    expect(result.left).toBe(false);
    expect(deleteMlsStateMock).not.toHaveBeenCalled();
    expect(deleteSenderKeyMock).not.toHaveBeenCalled();
  });

  it("a refused server DELETE never wipes local state", async () => {
    agentKeysExistMock.mockReturnValue(true);
    holdsMlsStateMock.mockReturnValue(true);
    senderKeyStateExistsMock.mockReturnValue(true);
    const { http } = makeHttp(null);
    vi.spyOn(http, "delete").mockRejectedValue(new Error("403 not a member"));
    const groups = new GroupsResource(http, makeMessages());

    await expect(groups.removeMember(GROUP_ID, AGENT_ID)).rejects.toThrow(
      "403 not a member",
    );
    expect(deleteMlsStateMock).not.toHaveBeenCalled();
    expect(deleteSenderKeyMock).not.toHaveBeenCalled();
  });

  it("an agent with no local key material has no store to retire", async () => {
    agentKeysExistMock.mockReturnValue(false);
    holdsMlsStateMock.mockReturnValue(false);
    senderKeyStateExistsMock.mockReturnValue(false);
    const { http } = makeHttp("mls-latch-abc");
    const groups = new GroupsResource(http, makeMessages());

    const result = await groups.removeMember(GROUP_ID, AGENT_ID);

    expect(result.localStateRetired).toBe(false);
    expect(deleteMlsStateMock).not.toHaveBeenCalled();
    expect(deleteSenderKeyMock).not.toHaveBeenCalled();
  });

  it("a client with no local key material still removes the member", async () => {
    const { http, deletes } = makeHttp("mls-latch-abc");
    const groups = new GroupsResource(http);

    const result = await groups.removeMember(GROUP_ID, AGENT_ID);

    expect(deletes).toHaveLength(1);
    expect(deleteMlsStateMock).not.toHaveBeenCalled();
    // It never read the group, so it says it does not know rather than
    // guessing a crypto regime and printing the wrong sentence.
    expect(result.encryption).toBeNull();
  });

  it("a leave that found nothing to retire says so, rather than claiming a wipe", async () => {
    // 🔴 `localStateRetired` reports what was HELD, not merely that this agent
    // holds key material of some kind. An agent invited into a closed group,
    // seated by the admin's Add commit and never installed its Welcome holds
    // no epoch secrets at all — and heard "its local MLS state is gone: the
    // current epoch secrets, every retained epoch secret and the plaintext the
    // self-read cache held". The Python SDK has always sampled before the wipe
    // and reported `false` here, so the two shipped SDKs answered the same
    // leave with opposite facts.
    agentKeysExistMock.mockReturnValue(true);
    holdsMlsStateMock.mockReturnValue(false);
    senderKeyStateExistsMock.mockReturnValue(false);
    const { http } = makeHttp("mls-latch-abc");
    const groups = new GroupsResource(http, makeMessages());

    const result = await groups.removeMember(GROUP_ID, AGENT_ID);

    expect(result.left).toBe(true);
    expect(result.localStateRetired).toBe(false);
    // The wipe still RUNS — both primitives are idempotent, and branching on a
    // reading that could be wrong is the one way to leave keys behind.
    expect(deleteMlsStateMock).toHaveBeenCalled();
    expect(deleteSenderKeyMock).toHaveBeenCalled();
  });
});
