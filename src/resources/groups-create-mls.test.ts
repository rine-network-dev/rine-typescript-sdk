/**
 * `groups.create` and the MLS latch it only learns about after the fact.
 *
 * The server mints the create response BEFORE the client-side MLS init runs,
 * so the created object always says `mls_group_id: null`. Every surface's
 * render/state predicate keys on that field, so without a re-read a brand-new
 * MLS group is presented to the operator as a sender-key group.
 *
 * Core is mocked at the module boundary so no real MLS crypto runs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const initMlsGroupMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    initMlsGroup: (...a: unknown[]) => initMlsGroupMock(...a),
  };
});

const { GroupsResource } = await import("./groups.js");
const { groupIsMls } = await import("../format/groups.js");

type SDKHttpClient = import("../api/http.js").SDKHttpClient;
type MessagesResource = import("./messages.js").MessagesResource;

const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CONFIG_DIR = "/tmp/rine-group-create";
const MLS_GROUP_ID = "mls-latch-abc";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * HTTP stub in the server's own order: `POST /groups` answers with no latch
 * (the init has not run yet), a later `GET /groups/{id}` answers with the
 * latch the init wrote — or fails, which is the transient case the re-read has
 * to survive.
 */
function makeHttp(
  latchAfterInit: string | null,
  getFailure?: Error,
  enrollmentPolicy = "closed",
): {
  http: SDKHttpClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const base = {
    id: GROUP_ID,
    name: "dev",
    handle: "#dev@acme.rine.network",
    enrollment_policy: enrollmentPolicy,
    created_at: "2026-04-11T12:00:00Z",
  };
  const stub = {
    configDir: CONFIG_DIR,
    getCoreHttpClient: () => ({ __core: true }),
    async post<T>(p: string, body?: unknown): Promise<T> {
      calls.push({ method: "POST", path: p, body });
      return { ...base, mls_group_id: null, mls_pending: false } as T;
    },
    async get<T>(p: string): Promise<T> {
      calls.push({ method: "GET", path: p });
      if (getFailure) throw getFailure;
      return { ...base, mls_group_id: latchAfterInit } as T;
    },
  } as unknown as SDKHttpClient;
  return { http: stub, calls };
}

function makeMessages(): MessagesResource {
  return {
    resolveSenderId: vi.fn(async () => AGENT_ID),
  } as unknown as MessagesResource;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GroupsResource.create — the MLS latch is re-read", () => {
  it("a freshly created closed group renders as MLS", async () => {
    initMlsGroupMock.mockResolvedValue({
      epoch: 1,
      commits: 1,
      added: 0,
      outcomes: [],
    });
    const { http, calls } = makeHttp(MLS_GROUP_ID);
    const groups = new GroupsResource(http, makeMessages());

    const group = await groups.create("dev", { visibility: "private" });

    expect(initMlsGroupMock).toHaveBeenCalledTimes(1);
    // The re-read is the point: it must happen AFTER the init.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /groups",
      `GET /groups/${GROUP_ID}`,
    ]);
    expect(group.mls_group_id).toBe(MLS_GROUP_ID);
    expect(groupIsMls(group)).toBe(true);
    expect(group.mlsInit).toBeUndefined();
  });

  it("a failed init returns the group with a structured failure and no re-read", async () => {
    initMlsGroupMock.mockRejectedValue(new Error("Only the designated admin"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { http, calls } = makeHttp(MLS_GROUP_ID);
    const groups = new GroupsResource(http, makeMessages());

    const group = await groups.create("dev", { visibility: "private" });

    expect(group.id).toBe(GROUP_ID);
    expect(group.mlsInit).toEqual({
      ok: false,
      reason: "Only the designated admin",
    });
    expect(groupIsMls(group)).toBe(false);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(0);
    warn.mockRestore();
  });

  it("a client with no local key material creates without an init or a re-read", async () => {
    const { http, calls } = makeHttp(MLS_GROUP_ID);
    const groups = new GroupsResource(http);

    const group = await groups.create("dev", { visibility: "private" });

    expect(initMlsGroupMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(group.mls_group_id).toBeNull();
  });

  it("a failed re-read still returns the created group", async () => {
    // The group exists server-side by the time the refresh runs, so throwing
    // here would hand the caller nothing at all — no group, no id — over a
    // cosmetic field. The MLS init this follows is best-effort for the same
    // reason; the refresh has to be too.
    initMlsGroupMock.mockResolvedValue({
      epoch: 1,
      commits: 1,
      added: 0,
      outcomes: [],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { http, calls } = makeHttp(
      MLS_GROUP_ID,
      new Error("503: Service unavailable"),
    );
    const groups = new GroupsResource(http, makeMessages());

    const group = await groups.create("dev", { visibility: "private" });

    expect(group.id).toBe(GROUP_ID);
    expect(group.mls_group_id).toBeNull();
    expect(group.mlsInit).toBeUndefined();
    // 🔴 The row is a lie and `mlsAdmission` is the only thing that says so.
    // A refused re-read hands back the PRE-init row, so every MLS predicate
    // reads this founded, latched, `mls-v1`-carrying group as one whose
    // ratchet tree was never founded. `mlsAdmission` is present exactly when
    // the founding landed, which is what a renderer has to branch on before
    // it tells an operator their group has no tree.
    expect(group.mlsAdmission).toBeDefined();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /groups",
      `GET /groups/${GROUP_ID}`,
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("an open-enrollment group is not attempted, not failed", async () => {
    // The server refuses MLS on open enrollment, so an attempt could only ever
    // fail. Attempting it anyway would hand the caller an `mlsInit` failure for
    // a group that is working exactly as intended — the same user action the
    // Python SDK and the CLI report as "not attempted".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { http, calls } = makeHttp(MLS_GROUP_ID, undefined, "open");
    const groups = new GroupsResource(http, makeMessages());

    const group = await groups.create("dev", {
      enrollment: "open",
      visibility: "public",
    });

    expect(initMlsGroupMock).not.toHaveBeenCalled();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /groups"]);
    expect(group.mlsInit).toBeUndefined();
    expect(groupIsMls(group)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("enableMls:false skips the init AND tells the server", async () => {
    // 🔴 The skip alone is not the product. The server's own default is
    // `mls_enabled: true`, so a create that only skipped the client-side init
    // left a closed row saying "created to run MLS" with no latch — which is
    // what `groupMlsNeverFounded` answers true to, for the life of the group,
    // with no shipped client able to PATCH the flag back. The caller asked for
    // a sender-key broadcast group; the wire has to say so.
    const { http, calls } = makeHttp(MLS_GROUP_ID);
    const groups = new GroupsResource(http, makeMessages());

    await groups.create("dev", {
      enableMls: false,
      visibility: "private",
    });

    expect(initMlsGroupMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ mls_enabled: false });
  });

  it("an unset enableMls sends no mls_enabled at all", async () => {
    // The SDK states no default of its own: the server's `true` is the only
    // default, and this SDK does not restate it. A body that carried
    // `mls_enabled: true` would be a second copy of that decision, drifting
    // the moment the server's changed.
    initMlsGroupMock.mockResolvedValue({
      epoch: 1,
      commits: 1,
      added: 0,
      outcomes: [],
    });
    const { http, calls } = makeHttp(MLS_GROUP_ID);
    const groups = new GroupsResource(http, makeMessages());

    await groups.create("dev", { visibility: "private" });

    expect(calls[0]?.body).not.toHaveProperty("mls_enabled");
  });
});
