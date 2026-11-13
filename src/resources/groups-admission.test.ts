/**
 * Admission is plural: a roster on create, a batch on invite, and a resume that
 * finishes what either of them started.
 *
 * The point is not ergonomics. An MLS commit is O(N) in the group's size, so
 * seating 32 invitees one at a time is 32 commits every member downloads,
 * against one. What makes that reachable is that a roster is known at founding
 * time and a batch is one `addMlsGroupMembers` call — both asserted here by
 * counting calls, not by reading the code.
 *
 * The singular forms keep their exact wire shape and response, because every
 * shipped 0.x client and both contract goldens depend on it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  A,
  ADMIN_ID,
  B,
  C,
  type Call,
  CONFIG_DIR,
  GROUP_ID,
  group,
  MLS_LATCH,
  makeHttp,
  makeMessages,
} from "../_groups-admission-stub.js";

const initMlsGroupMock = vi.fn();
const addMlsGroupMembersMock = vi.fn();
const resumeMlsGroupAdmissionMock = vi.fn();
const sendGroupInviteNotificationMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    initMlsGroup: (...a: unknown[]) => initMlsGroupMock(...a),
    addMlsGroupMembers: (...a: unknown[]) => addMlsGroupMembersMock(...a),
    resumeMlsGroupAdmission: (...a: unknown[]) =>
      resumeMlsGroupAdmissionMock(...a),
    sendGroupInviteNotification: (...a: unknown[]) =>
      sendGroupInviteNotificationMock(...a),
  };
});

const { GroupsResource, mlsAdmissionSkipSentence } =
  await import("./groups.js");
const { groupAdmissionSkipSentence, notAnMlsGroupResume } = await import(
  "@rine-network/core"
);

afterEach(() => {
  vi.clearAllMocks();
});

describe("GroupsResource.create — the roster", () => {
  it("sends the roster and reports what became of each entry", async () => {
    initMlsGroupMock.mockResolvedValue({
      epoch: 1,
      commits: 1,
      added: 2,
      outcomes: [
        { agentId: A, status: "added" },
        { agentId: C, status: "added" },
      ],
    });
    const { http, calls } = makeHttp((call) =>
      call.method === "POST"
        ? {
            group: group({ mls_group_id: null }),
            roster: {
              invited: 2,
              skipped: 1,
              entries: [
                { agent_id: A, status: "invited" },
                { agent_id: B, status: "skipped", reason: "agent_revoked" },
                { agent_id: C, status: "invited" },
              ],
            },
          }
        : group(),
    );
    const groups = new GroupsResource(http, makeMessages());

    const created = await groups.create("dev", {
      visibility: "private",
      members: [A, B, C],
    });

    expect(calls[0]?.body).toEqual({
      name: "dev",
      visibility: "private",
      members: [A, B, C],
    });
    // A roster invites; it never seats. The report is per entry, in request
    // order, and one revoked id does not cost the other two their seats.
    expect(created.roster?.invited).toBe(2);
    expect(created.roster?.entries.map((e) => e.agent_id)).toEqual([A, B, C]);
    expect(created.roster?.entries[1]?.reason).toBe("agent_revoked");
    // The latch is re-read after the founding, roster or not.
    expect(created.mls_group_id).toBe(MLS_LATCH);
  });

  it("tells only the agents that actually got an invitation", async () => {
    initMlsGroupMock.mockResolvedValue({
      epoch: 1,
      commits: 1,
      added: 1,
      outcomes: [{ agentId: A, status: "added" }],
    });
    const { http } = makeHttp((call) =>
      call.method === "POST"
        ? {
            group: group({ mls_group_id: null }),
            roster: {
              invited: 1,
              skipped: 1,
              entries: [
                { agent_id: A, status: "invited" },
                { agent_id: B, status: "skipped", reason: "agent_not_found" },
              ],
            },
          }
        : group(),
    );
    const groups = new GroupsResource(http, makeMessages());

    await groups.create("dev", { visibility: "private", members: [A, B] });

    expect(sendGroupInviteNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendGroupInviteNotificationMock.mock.calls[0]?.[3]).toBe(A);
  });

  it("says which rostered agents the founding could not seat", async () => {
    // A roster reports invitations; the founding reports leaves. An agent with
    // an empty key-package pool is `invited` in the first and unseated in the
    // second, and before this the create response carried only the first — so
    // "3 invited, 0 skipped" was the whole of what a caller was told about
    // agents that cannot read a word of the group.
    initMlsGroupMock.mockResolvedValue({
      epoch: 1,
      commits: 1,
      added: 1,
      outcomes: [
        { agentId: A, status: "added" },
        { agentId: B, status: "skipped", reason: "no_key_package" },
      ],
    });
    const { http } = makeHttp((call) =>
      call.method === "POST"
        ? {
            group: group({ mls_group_id: null }),
            roster: {
              invited: 2,
              skipped: 0,
              entries: [
                { agent_id: A, status: "invited" },
                { agent_id: B, status: "invited" },
              ],
            },
          }
        : group(),
    );
    const groups = new GroupsResource(http, makeMessages());

    const created = await groups.create("dev", {
      visibility: "private",
      members: [A, B],
    });

    expect(created.roster?.skipped).toBe(0);
    expect(created.mlsAdmission?.added).toBe(1);
    expect(
      created.mlsAdmission?.outcomes.find((o) => o.agentId === B)?.reason,
    ).toBe("no_key_package");
  });

  it("a create with no roster answers a bare group, as it always has", async () => {
    initMlsGroupMock.mockResolvedValue({
      epoch: 1,
      commits: 1,
      added: 0,
      outcomes: [],
    });
    const { http, calls } = makeHttp((call) =>
      call.method === "POST" ? group({ mls_group_id: null }) : group(),
    );
    const groups = new GroupsResource(http, makeMessages());

    const created = await groups.create("dev", { visibility: "private" });

    expect(calls[0]?.body).toEqual({ name: "dev", visibility: "private" });
    expect(created.roster).toBeUndefined();
    expect(sendGroupInviteNotificationMock).not.toHaveBeenCalled();
  });
});

describe("GroupsResource.invite — one agent, or many", () => {
  it("a batch is one request and one MLS commit run", async () => {
    addMlsGroupMembersMock.mockResolvedValue({
      epoch: 3,
      commits: 1,
      added: 2,
      outcomes: [
        { agentId: A, status: "added" },
        { agentId: C, status: "added" },
      ],
    });
    const { http, calls } = makeHttp((call) =>
      call.method === "POST"
        ? {
            invited: 2,
            skipped: 1,
            entries: [
              { agent_id: A, status: "invited" },
              { agent_id: B, status: "skipped", reason: "already_a_member" },
              { agent_id: C, status: "invited" },
            ],
          }
        : group(),
    );
    const groups = new GroupsResource(http, makeMessages());

    const report = await groups.invite(GROUP_ID, [A, B, C]);

    expect(calls[0]?.path).toBe(`/groups/${GROUP_ID}/invite`);
    expect(calls[0]?.body).toEqual({ agent_ids: [A, B, C] });
    expect(report.entries.map((e) => e.status)).toEqual([
      "invited",
      "skipped",
      "invited",
    ]);
    // One call, carrying only the agents that were actually invited — the
    // whole point of the batch. An already-a-member id is not re-added.
    expect(addMlsGroupMembersMock).toHaveBeenCalledTimes(1);
    expect(addMlsGroupMembersMock.mock.calls[0]?.[3]).toEqual([A, C]);
    expect(report.mls?.added).toBe(2);
    // And each of them is told, once.
    expect(sendGroupInviteNotificationMock).toHaveBeenCalledTimes(2);
  });

  it("a single agent keeps the exact body and response it always had", async () => {
    addMlsGroupMembersMock.mockResolvedValue({
      epoch: 3,
      commits: 1,
      added: 1,
      outcomes: [{ agentId: A, status: "added" }],
    });
    const { http, calls } = makeHttp((call) =>
      call.method === "POST"
        ? {
            status: "pending",
            request_id: "44444444-4444-4444-8444-444444444444",
          }
        : group(),
    );
    const groups = new GroupsResource(http, makeMessages());

    const result = await groups.invite(GROUP_ID, A, { message: "join us" });

    expect(calls[0]?.body).toEqual({ agent_id: A, message: "join us" });
    expect(result).toEqual({
      status: "pending",
      request_id: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("an open group mints no voucher and still tells the invitees", async () => {
    // An open group needs no voucher, so every entry comes back
    // `not_applicable`. Reading only `invited` here would notify nobody —
    // while the singular form on the same group notifies its one agent.
    const { http } = makeHttp((call) =>
      call.method === "POST"
        ? {
            invited: 0,
            skipped: 2,
            entries: [
              { agent_id: A, status: "skipped", reason: "not_applicable" },
              { agent_id: B, status: "skipped", reason: "not_applicable" },
            ],
          }
        : group({ mls_group_id: null, enrollment_policy: "open" }),
    );
    const groups = new GroupsResource(http, makeMessages());

    const report = await groups.invite(GROUP_ID, [A, B]);

    expect(addMlsGroupMembersMock).not.toHaveBeenCalled();
    expect(report.mls).toBeUndefined();
    expect(sendGroupInviteNotificationMock).toHaveBeenCalledTimes(2);
  });

  it("an agent that got no leaf is named, not silently left unseated", async () => {
    // The singular path discards the admission report, so this warning is the
    // only place an invitee with no published key package is reported.
    addMlsGroupMembersMock.mockResolvedValue({
      epoch: 3,
      commits: 0,
      added: 0,
      outcomes: [{ agentId: A, status: "skipped", reason: "no_key_package" }],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { http } = makeHttp((call) =>
      call.method === "POST" ? { status: "pending" } : group(),
    );
    const groups = new GroupsResource(http, makeMessages());

    await groups.invite(GROUP_ID, A);

    expect(warn).toHaveBeenCalledTimes(1);
    const said = warn.mock.calls[0]?.[0] as string;
    // The agent is named, and the reason is rine's sentence rather than the
    // wire token — an operator should not have to know the vocabulary.
    expect(said).toContain(A);
    expect(said).toContain(mlsAdmissionSkipSentence("no_key_package"));
    expect(said).not.toContain("(no_key_package)");
    expect(said).toContain("resumeMlsAdmission");
    warn.mockRestore();
  });
});

describe("GroupsResource.resumeMlsAdmission", () => {
  it("runs the add path over the group's still-unseated invitees", async () => {
    resumeMlsGroupAdmissionMock.mockResolvedValue({
      epoch: 4,
      commits: 1,
      added: 3,
      outcomes: [],
    });
    const { http } = makeHttp(() => group());
    const groups = new GroupsResource(http, makeMessages());

    const result = await groups.resumeMlsAdmission(GROUP_ID);

    expect(resumeMlsGroupAdmissionMock).toHaveBeenCalledWith(
      CONFIG_DIR,
      ADMIN_ID,
      GROUP_ID,
      expect.anything(),
      { "X-Rine-Agent": ADMIN_ID },
      // Reclamation removes leaves and costs one O(N) commit per leaf,
      // so a resume never picks it up by default.
      { reclaim: false },
    );
    expect(result.added).toBe(3);
  });

  it("refuses an open group in the sender-key words, naming its handle", async () => {
    // The refusal a connector's model actually reads. Without the guard the
    // call reaches the native core and comes back "no MLS state for <uuid>" —
    // byte-identical to what a member of a real MLS group gets when its local
    // state is gone, whose remedy is `sync` rather than "there is nothing
    // here". The Python twin `group_resume._refuse_sender_key_group` has always
    // done this; the two sentences are one string in rine-core.
    const { http } = makeHttp(() =>
      group({ enrollment_policy: "open", mls_group_id: null }),
    );
    const groups = new GroupsResource(http, makeMessages());

    await expect(
      groups.resumeMlsAdmission(GROUP_ID, { reclaim: true }),
    ).rejects.toThrow(notAnMlsGroupResume("#dev@acme.rine.network"));
    expect(resumeMlsGroupAdmissionMock).not.toHaveBeenCalled();
  });

  it("retires orphaned leaves only when the caller asks", async () => {
    resumeMlsGroupAdmissionMock.mockResolvedValue({
      epoch: 6,
      commits: 0,
      added: 0,
      outcomes: [],
      reclamation: { found: 1, reclaimed: 1, commits: 1, epoch: 6 },
    });
    const { http } = makeHttp(() => group());
    const groups = new GroupsResource(http, makeMessages());

    const result = await groups.resumeMlsAdmission(GROUP_ID, { reclaim: true });

    expect(resumeMlsGroupAdmissionMock).toHaveBeenCalledWith(
      CONFIG_DIR,
      ADMIN_ID,
      GROUP_ID,
      expect.anything(),
      { "X-Rine-Agent": ADMIN_ID },
      { reclaim: true },
    );
    expect(result.reclamation).toEqual({
      found: 1,
      reclaimed: 1,
      commits: 1,
      epoch: 6,
    });
  });

  it("refuses when this client holds no local key material", async () => {
    const { http } = makeHttp(() => group());
    const groups = new GroupsResource(http);

    await expect(groups.resumeMlsAdmission(GROUP_ID)).rejects.toThrow(
      /holds no local key material/,
    );
    expect(resumeMlsGroupAdmissionMock).not.toHaveBeenCalled();
  });
});

describe("GroupsResource.listRequests — the outstanding filter", () => {
  it("asks for nothing by default, so the shipped wire is unchanged", async () => {
    const { http, calls } = makeHttp(() => ({ items: [], total: 0 }));
    const groups = new GroupsResource(http);

    await groups.listRequests(GROUP_ID);

    expect(calls[0]?.path).toBe(`/groups/${GROUP_ID}/requests`);
    expect(calls[0]?.params).toBeUndefined();
  });

  it("can ask for the whole tree the ceiling counts", async () => {
    const { http, calls } = makeHttp(() => ({ items: [], total: 0 }));
    const groups = new GroupsResource(http);

    await groups.listRequests(GROUP_ID, { outstanding: "live" });

    expect(calls[0]?.params).toEqual({ outstanding: "live" });
  });
});

describe("GroupsResource.invite — a reason this client may not know", () => {
  const invite = async (reason: string) => {
    const { http } = makeHttp((call) =>
      call.method === "POST"
        ? {
            invited: 0,
            skipped: 1,
            entries: [{ agent_id: A, status: "skipped", reason }],
          }
        : group(),
    );
    return new GroupsResource(http, makeMessages()).invite(GROUP_ID, [A, B]);
  };

  it("keeps org_rule and says the group-rule clause, not the token", async () => {
    const report = await invite("org_rule");

    expect(report.entries[0]?.reason).toBe("org_rule");
    expect(groupAdmissionSkipSentence("org_rule")).toMatch(
      /^refused by an organisation's group rule/,
    );
  });

  it("parses an unknown token and quotes it back instead of throwing the report away", async () => {
    const report = await invite("some_future_reason");

    expect(report.skipped).toBe(1);
    expect(report.entries[0]?.reason).toBe("some_future_reason");
    expect(groupAdmissionSkipSentence(report.entries[0]?.reason)).toBe(
      "reason not recognised by this client: some_future_reason",
    );
  });
});
