/**
 * `groups.resolveRefForJoin` — the SDK's half of the join-scoped ladder.
 *
 * The rungs themselves are `rine-core`'s and are tested there
 * (`rine-core/test/resolve-group-join.test.ts`). What is THIS package's is the
 * seam: which core client the ladder is handed, and that the id it answers with
 * comes back branded, since `groups.join()` takes a `GroupUuid` and nothing
 * else. Both connectors that call this method stub it out in their own suites,
 * so without this file the seam ships untested on every surface at once.
 *
 * Driven through the public method against a fake core client, so a rung is a
 * request this file can see rather than a mock it declares.
 */

import { describe, expect, it } from "vitest";
import { GroupsResource } from "./groups.js";

type SDKHttpClient = import("../api/http.js").SDKHttpClient;

const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const HANDLE = "#ops@acme.rine.network";

interface Ask {
  path: string;
  params?: Record<string, string | number>;
}

/**
 * An `SDKHttpClient` whose `getCoreHttpClient()` answers from `routes`.
 *
 * Only `get` is implemented: every rung of this ladder is a read, and a stub
 * that answered anything else would let a write through unnoticed.
 */
function makeHttp(routes: Record<string, unknown>): {
  http: SDKHttpClient;
  asks: Ask[];
} {
  const asks: Ask[] = [];
  const core = {
    async get(path: string, params?: Record<string, string | number>) {
      asks.push({ path, params });
      return routes[path] ?? { items: [] };
    },
  };
  const stub = {
    configDir: null,
    getCoreHttpClient: () => core,
  } as unknown as SDKHttpClient;
  return { http: stub, asks };
}

describe("GroupsResource.resolveRefForJoin", () => {
  it("answers a UUID out of the reference itself, asking nothing", async () => {
    const { http, asks } = makeHttp({});
    const groups = new GroupsResource(http);

    expect(await groups.resolveRefForJoin(GROUP_ID)).toBe(GROUP_ID);
    // A join by id is the reference `rine_discover_groups` prints beside every
    // handle, so it is the commonest one there is. Costing it a round trip
    // would tax the recovery path this round's refusals point callers at.
    expect(asks).toEqual([]);
  });

  it("walks a handle's rungs in order and stops at the one that answers", async () => {
    const { http, asks } = makeHttp({
      "/groups": { items: [] },
      "/groups/invites": {
        items: [{ group_id: GROUP_ID, group_handle: HANDLE, group_name: "ops" }],
      },
    });
    const groups = new GroupsResource(http);

    expect(await groups.resolveRefForJoin(HANDLE)).toBe(GROUP_ID);
    // The seats rung first — a group this org already sits in must reach the
    // server, so the honest `409 Agent is already a member` is what comes back
    // rather than a client-side "not found" about a group it is standing in.
    // The directory is never reached, because an earlier rung answered.
    expect(asks.map((a) => a.path)).toEqual(["/groups", "/groups/invites"]);
  });

  it("reads a bare name against this agent's invitations and nothing else", async () => {
    const { http, asks } = makeHttp({
      "/groups/invites": {
        items: [{ group_id: GROUP_ID, group_handle: HANDLE, group_name: "ops" }],
      },
    });
    const groups = new GroupsResource(http);

    expect(await groups.resolveRefForJoin("ops")).toBe(GROUP_ID);
    expect(asks.map((a) => a.path)).toEqual(["/groups/invites"]);
  });

  it("refuses a bare name no invitation answers to, without widening the search", async () => {
    const { http, asks } = makeHttp({ "/groups/invites": { items: [] } });
    const groups = new GroupsResource(http);

    const failure = await groups
      .resolveRefForJoin("ops")
      .catch((err: unknown) => err);

    expect((failure as Error).message).toContain("Group not found: ops");
    // The directory is the one rung that could see a group this agent has no
    // relationship with, and it is a network-wide substring match. A bare name
    // carries no org, so a match there could be any org's `ops` — and a join
    // cannot be taken back.
    expect(asks.map((a) => a.path)).toEqual(["/groups/invites"]);
  });

  it("rejects a directory row whose handle is only a near miss", async () => {
    const { http } = makeHttp({
      "/groups": { items: [] },
      "/groups/invites": { items: [] },
      "/directory/groups": {
        items: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            handle: "#ops-archive@acme.rine.network",
          },
        ],
        total_estimate: 1,
      },
    });
    const groups = new GroupsResource(http);

    const failure = await groups
      .resolveRefForJoin(HANDLE)
      .catch((err: unknown) => err);

    // The directory filter is `name ILIKE OR description ILIKE`, so its rows
    // are candidates. Exact handle equality over them is what makes a fuzzy
    // search safe in front of an irreversible verb; this row survives the
    // filter and must not survive the match.
    expect((failure as Error).message).toContain(`Group not found: ${HANDLE}`);
    expect((failure as Error).message).toContain(
      "a public group in the directory",
    );
  });

  it("resolves off a directory row when the handle matches exactly", async () => {
    const { http, asks } = makeHttp({
      "/groups": { items: [] },
      "/groups/invites": { items: [] },
      "/directory/groups": {
        items: [{ id: GROUP_ID, handle: HANDLE }],
        total_estimate: 1,
      },
    });
    const groups = new GroupsResource(http);

    expect(await groups.resolveRefForJoin(HANDLE)).toBe(GROUP_ID);
    // The query is the handle's local part, which is the column the directory
    // searches — asking it anything wider spends the page budget on rows the
    // exactness filter is going to reject.
    const lookup = asks.find((a) => a.path === "/directory/groups");
    expect(lookup?.params?.q).toBe("ops");
  });
});
