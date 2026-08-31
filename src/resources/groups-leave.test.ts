/**
 * `leave()` — a departure under its own name, and the header that makes it one.
 *
 * The server tells a leave from a kick by the acting agent alone
 * (`get_optional_acting_agent`), and it fails closed: a DELETE with no
 * `X-Rine-Agent` from an org with more than one active agent is read as a kick
 * and refused until a Remove commit is posted that nobody can mint for their own
 * removal. That exact omission shipped once on the removal path, so the header
 * is asserted here rather than assumed — with the DELETE's headers captured, not
 * just its path.
 *
 * Core is mocked at the module boundary so no real MLS or sender-key store is
 * opened.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const deleteMlsStateMock = vi.fn();
const deleteSenderKeyMock = vi.fn();
const deleteGroupReadCacheMock = vi.fn();
const agentKeysExistMock = vi.fn();
const holdsMlsStateMock = vi.fn();
const senderKeyStateExistsMock = vi.fn();
const removeMlsGroupMemberMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    deleteMlsState: (...a: unknown[]) => deleteMlsStateMock(...a),
    deleteSenderKey: (...a: unknown[]) => deleteSenderKeyMock(...a),
    deleteGroupReadCache: (...a: unknown[]) => deleteGroupReadCacheMock(...a),
    agentKeysExist: (...a: unknown[]) => agentKeysExistMock(...a),
    holdsMlsState: (...a: unknown[]) => holdsMlsStateMock(...a),
    senderKeyStateExists: (...a: unknown[]) => senderKeyStateExistsMock(...a),
    removeMlsGroupMember: (...a: unknown[]) => removeMlsGroupMemberMock(...a),
  };
});

const { GroupsResource } = await import("./groups.js");

type SDKHttpClient = import("../api/http.js").SDKHttpClient;
type MessagesResource = import("./messages.js").MessagesResource;
type GroupUuid = import("../types.js").GroupUuid;

const GROUP_ID = "33333333-3333-4333-8333-333333333333" as GroupUuid;
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CONFIG_DIR = "/tmp/rine-group-leave-verb";

interface DeleteCall {
  path: string;
  headers?: Record<string, string>;
}

function makeHttp(): { http: SDKHttpClient; deletes: DeleteCall[] } {
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
        mls_group_id: "mls-latch-abc",
      } as T;
    },
    async delete(
      path: string,
      opts?: { extraHeaders?: Record<string, string> },
    ): Promise<void> {
      deletes.push({
        path,
        ...(opts?.extraHeaders ? { headers: opts.extraHeaders } : {}),
      });
    },
  } as unknown as SDKHttpClient;
  return { http: stub, deletes };
}

/** `resolve` is what a multi-agent org's ambiguity looks like: it throws. */
function makeMessages(resolve: () => Promise<string>): MessagesResource {
  return { resolveSenderId: vi.fn(resolve) } as unknown as MessagesResource;
}

afterEach(() => vi.clearAllMocks());

describe("GroupsResource.leave", () => {
  it("test_leave_when_called_then_deletes_the_caller_naming_itself", async () => {
    agentKeysExistMock.mockReturnValue(true);
    holdsMlsStateMock.mockReturnValue(true);
    senderKeyStateExistsMock.mockReturnValue(false);
    const { http, deletes } = makeHttp();
    const groups = new GroupsResource(
      http,
      makeMessages(async () => AGENT_ID),
    );

    const result = await groups.leave(GROUP_ID);

    // The whole point of the header: without it the server cannot tell this
    // from a kick, and an MLS group refuses a kick with no Remove commit.
    expect(deletes).toEqual([
      {
        path: `/groups/${GROUP_ID}/members/${AGENT_ID}`,
        headers: { "X-Rine-Agent": AGENT_ID },
      },
    ]);
    expect(result.left).toBe(true);
    // A leave posts no Remove commit; MLS gives nobody a way to commit its own
    // removal, so the leaf stays until somebody reclaims it.
    expect(removeMlsGroupMemberMock).not.toHaveBeenCalled();
    expect(result.mlsRemovalEpoch).toBeUndefined();
  });

  it("test_leave_when_called_then_retires_local_state_including_the_read_cache", async () => {
    agentKeysExistMock.mockReturnValue(true);
    holdsMlsStateMock.mockReturnValue(true);
    senderKeyStateExistsMock.mockReturnValue(false);
    const { http } = makeHttp();
    const groups = new GroupsResource(
      http,
      makeMessages(async () => AGENT_ID),
    );

    const result = await groups.leave(GROUP_ID);

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
    // The plaintext kept so a message could be read twice goes with the keys,
    // or the sentence this leave prints would be false.
    expect(deleteGroupReadCacheMock).toHaveBeenCalledWith(
      CONFIG_DIR,
      AGENT_ID,
      GROUP_ID,
    );
    expect(result.localStateRetired).toBe(true);
  });

  it("test_leave_when_the_agent_is_ambiguous_then_refuses_instead_of_kicking", async () => {
    const { http, deletes } = makeHttp();
    const groups = new GroupsResource(
      http,
      makeMessages(async () => {
        throw new Error("Multiple agents found; specify one");
      }),
    );

    // `removeMember` degrades here and attempts the removal anyway, which is
    // right for a kick. A leave has no such fallback: an unattributable leave IS
    // a kick to the server, and one nobody can post a commit for.
    await expect(groups.leave(GROUP_ID)).rejects.toThrow(
      /Multiple agents found/,
    );
    expect(deletes).toEqual([]);
  });
});
