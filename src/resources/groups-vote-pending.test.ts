/**
 * A vote that leaves the request below its threshold admits nobody, so the voter
 * mints no leaf and sends no Welcome.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  A,
  GROUP_ID,
  group,
  makeHttp,
  makeMessages,
} from "../_groups-admission-stub.js";

const addMlsGroupMembersMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    addMlsGroupMembers: (...a: unknown[]) => addMlsGroupMembersMock(...a),
  };
});

const { GroupsResource } = await import("./groups.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("GroupsResource.vote — a vote that does not admit", () => {
  const REQUEST_ID = "55555555-5555-4555-8555-555555555555";

  it("seats nobody when the vote leaves the request pending", async () => {
    const { http, calls } = makeHttp((call) => {
      if (call.path.endsWith("/requests")) {
        return {
          items: [
            {
              id: REQUEST_ID,
              group_id: GROUP_ID,
              agent_id: A,
              status: "pending",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        };
      }
      if (call.path.endsWith("/vote")) {
        return {
          request_id: REQUEST_ID,
          your_vote: "approve",
          status: "pending",
        };
      }
      return group();
    });
    const groups = new GroupsResource(http, makeMessages());

    const result = await groups.vote(GROUP_ID, REQUEST_ID, "approve");

    expect(result.status).toBe("pending");
    expect(result.mls_seated).toBeUndefined();
    expect(addMlsGroupMembersMock).not.toHaveBeenCalled();
    // The vote is the only POST: no Welcome, no commit request follows it.
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(
      [`/groups/${GROUP_ID}/requests/${REQUEST_ID}/vote`],
    );
  });
});
