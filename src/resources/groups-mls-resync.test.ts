/**
 * `GroupsResource.sync` — the SDK half of the recovery verb.
 *
 * The recoveries themselves live in `rine-core` and are tested there, against
 * the real MLS core and real sender-key material. What is verified here is the
 * wiring only, which is where this SDK has been wrong before: which agent it
 * acts as, whether the acting-agent header is sent, that the group ROW reaches
 * the recovery so the regime is decided from the server's latch rather than
 * re-read, that a sender-key group is recovered rather than refused, and whether
 * an eviction reaches the caller as rine's membership fact rather than a
 * ratchet-tree invariant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recoverGroupMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    recoverGroup: (...a: unknown[]) => recoverGroupMock(...a),
  };
});

const { GroupsResource } = await import("./groups.js");
const { isGroupEvictedError } = await import("./groups-mls-context.js");

type SDKHttpClient = import("../api/http.js").SDKHttpClient;
type MessagesResource = import("./messages.js").MessagesResource;
type GroupUuid = import("../types.js").GroupUuid;

const GROUP_ID = "33333333-3333-4333-8333-333333333333" as GroupUuid;
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CONFIG_DIR = "/tmp/rine-mls-resync";

const REPLAYED = {
  regime: "mls" as const,
  rung: "replay" as const,
  fromEpoch: 4,
  epoch: 9,
  behind: 5,
  processed: 5,
  evicted: false,
};

const INGESTED = {
  regime: "sender-key" as const,
  ingested: 2,
  retired: false,
};

function groupRow(mlsGroupId: string | null) {
  return {
    id: GROUP_ID,
    name: "dev",
    handle: "#dev@acme.rine.network",
    created_at: "2026-04-11T12:00:00Z",
    mls_group_id: mlsGroupId,
  };
}

/** The row as the recovery receives it: parsed, so it carries the schema's
 * defaults too. Matched on the fields the regime is actually decided from. */
function rowReaching(mlsGroupId: string | null) {
  return expect.objectContaining({
    id: GROUP_ID,
    handle: "#dev@acme.rine.network",
    mls_group_id: mlsGroupId,
    mls_pending: false,
  });
}

function makeHttp(mlsGroupId: string | null): SDKHttpClient {
  return {
    configDir: CONFIG_DIR,
    getCoreHttpClient: () => ({ __core: true }),
    async get<T>(): Promise<T> {
      return groupRow(mlsGroupId) as T;
    },
  } as unknown as SDKHttpClient;
}

function makeMessages(): MessagesResource {
  return {
    resolveSenderId: vi.fn(async () => AGENT_ID),
  } as unknown as MessagesResource;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GroupsResource.sync", () => {
  beforeEach(() => {
    recoverGroupMock.mockResolvedValue(REPLAYED);
  });

  it("recovers as the resolved agent, and reports the rung it took", async () => {
    const groups = new GroupsResource(makeHttp("mls-latch"), makeMessages());

    const result = await groups.sync(GROUP_ID);

    expect(result).toEqual(REPLAYED);
    // 🔴 The group ROW, not its id. The regime is decided from the `mls_group_id`
    // latch on the row this call already read; passing an id would make the
    // recovery re-read it, or — the shipped defect — decide from whether local
    // state happens to load.
    expect(recoverGroupMock).toHaveBeenCalledWith(
      CONFIG_DIR,
      AGENT_ID,
      rowReaching("mls-latch"),
      expect.anything(),
      { "X-Rine-Agent": AGENT_ID },
    );
  });

  it("recovers a sender-key group instead of refusing it", async () => {
    // The behaviour this verb shipped without. An open group has no epoch chain,
    // so the MLS ladder is the wrong recovery — but "wrong recovery" was
    // answered with advice about a ratchet tree the group has not got. What such
    // a group can be missing is other members' sender keys, and the same call
    // now installs them.
    recoverGroupMock.mockResolvedValue(INGESTED);
    const groups = new GroupsResource(makeHttp(null), makeMessages());

    const result = await groups.sync(GROUP_ID);

    expect(result).toEqual(INGESTED);
    expect(recoverGroupMock).toHaveBeenCalledWith(
      CONFIG_DIR,
      AGENT_ID,
      rowReaching(null),
      expect.anything(),
      { "X-Rine-Agent": AGENT_ID },
    );
  });

  it("refuses when this client holds no local key material", async () => {
    const http = makeHttp("mls-latch") as { configDir?: string };
    http.configDir = undefined;
    const groups = new GroupsResource(http as SDKHttpClient, makeMessages());

    await expect(groups.sync(GROUP_ID)).rejects.toThrow(
      "no local key material",
    );
    expect(recoverGroupMock).not.toHaveBeenCalled();
  });

  it("states an eviction as a membership fact, not a ratchet-tree invariant", async () => {
    const inactive = Object.assign(new Error("group is inactive"), {
      code: "RINE_MLS_GROUP_INACTIVE",
    });
    recoverGroupMock.mockRejectedValue(inactive);
    const groups = new GroupsResource(makeHttp("mls-latch"), makeMessages());

    const err = await groups.sync(GROUP_ID).catch((e: unknown) => e);

    expect(isGroupEvictedError(err)).toBe(true);
  });

  it("raises a recovery failure rather than warning past it", async () => {
    recoverGroupMock.mockRejectedValue(new Error("no published GroupInfo"));
    const groups = new GroupsResource(makeHttp("mls-latch"), makeMessages());

    await expect(groups.sync(GROUP_ID)).rejects.toThrow(
      "no published GroupInfo",
    );
  });

  it("passes an init-in-flight refusal through as it was thrown", async () => {
    // The refusal `recoverGroup` raises for a group between its MLS init and the
    // latch is a bare Error by design — the state clears itself within minutes,
    // so it gets no error class and no code. `asGroupFailure` must leave it
    // alone rather than dress it as an eviction.
    recoverGroupMock.mockRejectedValue(
      new Error("is still founding its MLS state"),
    );
    const groups = new GroupsResource(makeHttp(null), makeMessages());

    const err = await groups.sync(GROUP_ID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("still founding its MLS state");
    expect(isGroupEvictedError(err)).toBe(false);
  });
});
