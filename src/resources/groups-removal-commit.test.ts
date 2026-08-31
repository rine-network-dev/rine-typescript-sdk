/**
 * Kicking a member out of an MLS group costs a real Remove commit, and the
 * epoch it landed at travels as a QUERY parameter.
 *
 * Before this, removal was `DELETE` and nothing else: the evicted leaf stayed
 * in the ratchet tree, every epoch secret the evicted agent held stayed valid,
 * and the eviction was enforced by the server's delivery filter alone. The
 * server now refuses that, and it refuses it in a way a client can get subtly
 * wrong — `mls_removal_epoch` in a JSON body binds nothing and the removal is
 * then refused for want of the commit that was just posted. So the placement is
 * asserted, not the value alone.
 *
 * The eviction refusal is here too: an admin whose own leaf is gone is
 * told it was removed from the group, not handed the native core's ratchet-tree
 * invariant.
 *
 * The commit also **declares** the target, and a target holding no leaf gets a
 * path-only one. Both live in `rine-core`, which this file mocks; what belongs
 * here is that this SDK hands the core an AGENT ID rather than an identity it
 * resolved itself, that the rescue's epoch still reaches the DELETE, and that
 * no sentence claims a leaf went when the core says none did.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const removeMlsGroupMemberMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    agentKeysExist: () => true,
    holdsMlsState: () => true,
    senderKeyStateExists: () => true,
    deleteMlsState: vi.fn(),
    deleteSenderKey: vi.fn(),
    removeMlsGroupMember: (...a: unknown[]) => removeMlsGroupMemberMock(...a),
  };
});

const { GroupsResource, isGroupEvictedError } = await import("./groups.js");
const { MLS_ERR_GROUP_INACTIVE } = await import("@rine-network/core");

type SDKHttpClient = import("../api/http.js").SDKHttpClient;
type MessagesResource = import("./messages.js").MessagesResource;
type GroupUuid = import("../types.js").GroupUuid;
type AgentUuid = import("../types.js").AgentUuid;

const GROUP_ID = "33333333-3333-4333-8333-333333333333" as GroupUuid;
const ADMIN_ID = "11111111-1111-4111-8111-111111111111" as AgentUuid;
const TARGET_ID = "22222222-2222-4222-8222-222222222222" as AgentUuid;
const CONFIG_DIR = "/tmp/rine-group-kick";

interface DeleteCall {
  path: string;
  opts?: {
    params?: Record<string, string | number | boolean | undefined>;
    extraHeaders?: Record<string, string>;
  };
}

/** The server's 409 when a live MLS group's member row may not be dropped yet. */
function removalCommitRequired(): Error {
  return Object.assign(new Error("409: needs a Remove commit"), {
    code: "mls_removal_commit_required",
  });
}

/**
 * 🔴 The stub **models the server's gate**, because the order of the two calls
 * is the security control and a stub that accepts every DELETE cannot tell a
 * correct client from a dangerous one.
 *
 * `require_removal_commit` (`src/rine/api/group_membership.py`) refuses a kick
 * on a group holding MLS state until a Remove commit is named, exempts a
 * self-leave — MLS gives nobody a way to commit their own removal — and leaves
 * the member row exactly where it was when it refuses. All three are reproduced
 * here. `deleteRejection` stands in for the refusals that come *after* that
 * gate: the 403 a non-admin draws, and the 422 for the last admin.
 */
function makeHttp(
  mlsLatch: string | null,
  deleteRejection?: () => Error,
): {
  http: SDKHttpClient;
  deletes: DeleteCall[];
} {
  const deletes: DeleteCall[] = [];
  const stub = {
    configDir: CONFIG_DIR,
    // Whose key is whose is the core's question now, not this SDK's — it
    // resolves the identity from the agent id it is handed, so the leaf it
    // takes and the id it declares cannot be two different members.
    getCoreHttpClient: () => ({}),
    async get<T>(): Promise<T> {
      return {
        id: GROUP_ID,
        name: "dev",
        handle: "#dev@acme.rine.network",
        created_at: "2026-04-11T12:00:00Z",
        mls_group_id: mlsLatch,
      } as T;
    },
    async delete(path: string, opts?: DeleteCall["opts"]): Promise<void> {
      deletes.push({ path, opts });
      // The route's own order: the 403 ladder and the last-admin 422 are
      // decided BEFORE `require_removal_commit` is consulted
      // (`src/rine/api/groups.py`), which is exactly why a client that commits
      // first never gets to hear either of them in time.
      if (deleteRejection) throw deleteRejection();
      const acting = opts?.extraHeaders?.["X-Rine-Agent"];
      const target = path.split("/").pop();
      const isLeave =
        acting !== undefined && acting.toLowerCase() === target?.toLowerCase();
      if (
        mlsLatch !== null &&
        !isLeave &&
        opts?.params?.mls_removal_epoch === undefined
      ) {
        throw removalCommitRequired();
      }
    },
  } as unknown as SDKHttpClient;
  return { http: stub, deletes };
}

function makeMessages(): MessagesResource {
  return {
    resolveSenderId: vi.fn(async () => ADMIN_ID),
  } as unknown as MessagesResource;
}

/**
 * A messages resource for a multi-agent org that pinned no agent — the shape
 * `resolveAgent` refuses to guess for, and the configuration mastra and eve
 * scaffold by default.
 */
function makeAmbiguousMessages(): MessagesResource {
  return {
    resolveSenderId: vi.fn(async (_core: unknown, agent?: string) => {
      if (!agent) throw new Error("Multiple agents found.");
      return agent;
    }),
  } as unknown as MessagesResource;
}

/** A native error as the MLS core raises it: a code to branch on. */
function nativeError(code: string): Error {
  return Object.assign(new Error("group is inactive"), { code });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GroupsResource.removeMember — the Remove commit", () => {
  it("kicking from an MLS group asks the server BEFORE it evicts the leaf", async () => {
    const order: string[] = [];
    removeMlsGroupMemberMock.mockImplementation(async () => {
      order.push("commit");
      return { epoch: 7, removedLeaf: true };
    });
    const { http } = makeHttp("mls-latch-abc");
    const realDelete = http.delete.bind(http);
    vi.spyOn(http, "delete").mockImplementation(
      async (path: string, opts?: DeleteCall["opts"]) => {
        order.push("delete");
        return realDelete(path, opts) as never;
      },
    );
    const groups = new GroupsResource(http, makeMessages());

    const result = await groups.removeMember(GROUP_ID, TARGET_ID);

    // 🔴 DELETE first. `POST /groups/{id}/mls/commit` is gated on membership
    // alone — the blob is opaque, so the server cannot see that a commit
    // evicts anybody — while the authorization to evict is decided on the
    // DELETE. Committing first hands a plain member a working eviction the
    // server is about to refuse. The commit still lands while the target is a
    // member, because a refused removal leaves the member row where it was.
    expect(order).toEqual(["delete", "commit", "delete"]);
    // The AGENT ID, never an identity or a leaf index. The core resolves the
    // identity and re-resolves the index once per attempt, so a retry past a
    // lost epoch CAS cannot rebuild the Remove from an index another commit
    // has since invalidated — and the id it declares is the same id.
    expect(removeMlsGroupMemberMock).toHaveBeenCalledWith(
      CONFIG_DIR,
      ADMIN_ID,
      GROUP_ID,
      TARGET_ID,
      expect.anything(),
      { "X-Rine-Agent": ADMIN_ID },
    );
    expect(result.mlsRemovalEpoch).toBe(7);
    expect(result.mlsRemovedLeaf).toBe(true);
    expect(result.message).toContain("Remove commit at epoch 7");
  });

  it("the epoch travels as a query parameter, never as a body field", async () => {
    removeMlsGroupMemberMock.mockResolvedValue({
      epoch: 9,
      removedLeaf: true,
    });
    const { http, deletes } = makeHttp("mls-latch-abc");
    const groups = new GroupsResource(http, makeMessages());

    await groups.removeMember(GROUP_ID, TARGET_ID);

    // A query parameter. Body-encoded, this binds `None` server-side and every
    // cross-org removal 409s claiming the commit was never posted.
    // Two DELETEs: the one that asked, and the one that named the epoch.
    expect(deletes).toHaveLength(2);
    expect(deletes[0]?.opts?.params).toBeUndefined();
    expect(deletes[1]?.path).toBe(`/groups/${GROUP_ID}/members/${TARGET_ID}`);
    expect(deletes[1]?.opts?.params).toEqual({ mls_removal_epoch: 9 });
  });

  it("a kick the server refuses posts no Remove commit", async () => {
    // 🔴 The regression gate for the ordering above, from the other side.
    //
    // A plain member of an MLS group can post any commit — `POST /mls/commit`
    // is membership-gated and the blob is opaque — but only an admin may kick.
    // A client that commits first therefore evicts the victim's leaf
    // PERMANENTLY and then hears 403: the group still lists the victim, the
    // victim's client reads `isActive() === false`, and only a fresh Add and
    // Welcome from a real admin can restore them. The same shape wedges a group
    // for good when the refusal is the 422 for the last admin — that admin
    // loses its leaf and nobody can ever commit again.
    removeMlsGroupMemberMock.mockResolvedValue({
      epoch: 7,
      removedLeaf: true,
    });
    const forbidden = () =>
      Object.assign(new Error("403: Admin access required to kick members"), {
        code: "forbidden",
      });
    const { http, deletes } = makeHttp("mls-latch-abc", forbidden);
    const groups = new GroupsResource(http, makeMessages());

    await expect(groups.removeMember(GROUP_ID, TARGET_ID)).rejects.toThrow(
      "Admin access required",
    );

    // The whole point: no leaf was taken on the way to being refused.
    expect(removeMlsGroupMemberMock).not.toHaveBeenCalled();
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.opts?.params).toBeUndefined();
  });

  it("names the acting agent on the DELETE, which is what makes a leave a leave", async () => {
    // 🔴 The server tells a leave from a kick by the ACTING agent, and it reads
    // that from `X-Rine-Agent` (`get_optional_acting_agent`). With no header and
    // more than one active agent in the org it cannot decide, so it treats the
    // call as a kick and refuses it until a Remove commit is posted — a commit
    // MLS gives nobody a way to mint for their own removal. The commit path
    // next door has always named the agent; the DELETE did not, so an unpinned
    // multi-agent org could neither leave nor kick on an MLS group.
    const { http, deletes } = makeHttp(null);
    const groups = new GroupsResource(http, makeMessages());

    await groups.removeMember(GROUP_ID, TARGET_ID);

    expect(deletes[0]?.opts?.extraHeaders).toEqual({
      "X-Rine-Agent": ADMIN_ID,
    });
  });

  it("a multi-agent org can name the agent that is leaving", async () => {
    // `resolveAgent` refuses to guess between two agents, so without a per-call
    // agent this client cannot say who is acting — and the removal degrades to
    // a headerless kick the server refuses.
    const { http, deletes } = makeHttp(null);
    const groups = new GroupsResource(http, makeAmbiguousMessages());

    const result = await groups.removeMember(GROUP_ID, ADMIN_ID, {
      agent: ADMIN_ID,
    });

    expect(deletes[0]?.opts?.extraHeaders).toEqual({
      "X-Rine-Agent": ADMIN_ID,
    });
    // Naming the agent is also what lets this client tell it is a leave.
    expect(result.left).toBe(true);
  });

  it("an open group is removed with no commit and no epoch", async () => {
    const { http, deletes } = makeHttp(null);
    const groups = new GroupsResource(http, makeMessages());

    const result = await groups.removeMember(GROUP_ID, TARGET_ID);

    expect(removeMlsGroupMemberMock).not.toHaveBeenCalled();
    expect(deletes[0]?.opts?.params).toBeUndefined();
    expect(result.encryption).toBe("sender-key");
    expect(result.message).toContain("no cryptographic eviction");
  });

  it("completes a removal whose leaf is already gone, and claims no eviction", async () => {
    // 🔴 The commit of an earlier attempt landed and its DELETE
    // did not, so the target holds no leaf and no second Remove can be built
    // for it. This client used to re-raise the server's refusal here — a
    // remedy the operator had already tried — and the member row was stuck for
    // good. The core answers with a path-only commit instead, and the epoch it
    // names is what finally lets the DELETE through.
    removeMlsGroupMemberMock.mockResolvedValue({
      epoch: 11,
      removedLeaf: false,
    });
    const { http, deletes } = makeHttp("mls-latch-abc");
    const groups = new GroupsResource(http, makeMessages());

    const result = await groups.removeMember(GROUP_ID, TARGET_ID);

    expect(deletes).toHaveLength(2);
    expect(deletes[1]?.opts?.params).toEqual({ mls_removal_epoch: 11 });
    expect(result.mlsRemovalEpoch).toBe(11);
    expect(result.mlsRemovedLeaf).toBe(false);
    // The sentence reports what happened, and says the narrow, true thing.
    // `removedLeaf: false` is "no leaf carries the key they publish now", not
    // "they hold no leaf": a target that rotated its signing key is
    // indistinguishable from here and still holds its old leaf.
    expect(result.message).toContain(
      "no leaf in the ratchet tree carries the signing key they publish now",
    );
    expect(result.message).toContain("rotated their signing key");
    expect(result.message).not.toContain("took their ratchet-tree leaf");
  });

  it("a failed commit never drops the member row", async () => {
    removeMlsGroupMemberMock.mockRejectedValue(
      new Error("epoch_conflict after one retry"),
    );
    const { http, deletes } = makeHttp("mls-latch-abc");
    const groups = new GroupsResource(http, makeMessages());

    await expect(groups.removeMember(GROUP_ID, TARGET_ID)).rejects.toThrow(
      "epoch_conflict",
    );
    // One DELETE, refused for want of the commit — and the server leaves the
    // member row exactly where it was when it refuses. No DELETE ever named an
    // epoch, so nothing was dropped.
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.opts?.params).toBeUndefined();
  });

  it("an admin that was itself evicted is told so, in rine's words", async () => {
    // The refusal now covers the whole removal, not just the leaf lookup: an
    // admin evicted between reading the group and committing gets the same
    // sentence rather than the native ratchet-tree invariant.
    removeMlsGroupMemberMock.mockRejectedValue(
      nativeError(MLS_ERR_GROUP_INACTIVE),
    );
    const { http, deletes } = makeHttp("mls-latch-abc");
    const groups = new GroupsResource(http, makeMessages());

    const failure = await groups
      .removeMember(GROUP_ID, TARGET_ID)
      .catch((err: unknown) => err);

    expect(isGroupEvictedError(failure)).toBe(true);
    expect((failure as Error).message).toContain(
      `You were removed from group ${GROUP_ID}`,
    );
    // Not the native invariant, and not a bare decrypt failure.
    expect((failure as Error).message).not.toContain("inactive");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.opts?.params).toBeUndefined();
  });
});
