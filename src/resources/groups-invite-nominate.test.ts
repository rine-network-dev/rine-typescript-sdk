/**
 * A nomination posts no MLS commit; an invitation still does.
 *
 * On `majority` and `unanimity` an invite files a pending join request the
 * group's electorate decides, so claiming the named agent's KeyPackage and
 * Welcoming them into the ratchet tree would hand an epoch secret to somebody
 * the vote may deny — and the only thing that ever retires that leaf is the
 * manual reclamation pass, which cannot reach it until the row resolves. The
 * vote seats the member, and seating is what grants the key.
 *
 * Measured at the module edge rather than through the native core: what is
 * being asserted is whether the commit is POSTED at all, and the spy on
 * `addMlsGroupMembers` is the last point where that is still one observable
 * fact. The `closed` arm is the control — same group, same call, same stub —
 * so a pass is attributable to the policy and not to a broken harness.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const addMlsGroupMembersMock = vi.fn(async (..._args: unknown[]) => ({
  epoch: 2,
  added: 1,
  outcomes: [],
}));
const sendGroupInviteNotificationMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    addMlsGroupMembers: (...a: unknown[]) => addMlsGroupMembersMock(...a),
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
const INVITEE_ID = "22222222-2222-4222-8222-222222222222" as AgentUuid;

/**
 * An MLS-ACTIVE group under one enrollment policy. `mls_group_id` is latched
 * throughout, so nothing but the policy can decide whether a commit is posted.
 */
function resourceFor(policy: string): InstanceType<typeof GroupsResource> {
  const http = {
    configDir: "/tmp/rine-invite-nominate",
    getCoreHttpClient: () => ({ __core: true }),
    async get<T>(): Promise<T> {
      return {
        id: GROUP_ID,
        name: "dev",
        handle: "#dev@acme.rine.network",
        created_at: "2026-08-04T12:00:00Z",
        enrollment_policy: policy,
        mls_group_id: "opaque-mls-id",
      } as T;
    },
    // One route answers both forms, so the stub answers the shape the body
    // asked for: a bare result for `agent_id`, a per-entry report for
    // `agent_ids`. On these policies the server files nominations, so that is
    // the status every entry carries.
    async post<T>(_path: string, body?: unknown): Promise<T> {
      const ids = (body as { agent_ids?: string[] } | undefined)?.agent_ids;
      if (!ids) return { status: "pending" } as T;
      const status = policy === "closed" ? "invited" : "nominated";
      return {
        invited: ids.length,
        skipped: 0,
        entries: ids.map((agent_id) => ({ agent_id, status, reason: null })),
      } as T;
    },
  } as unknown as SDKHttpClient;
  const messages = {
    resolveSenderId: vi.fn(async () => "11111111-1111-4111-8111-111111111111"),
  } as unknown as MessagesResource;
  return new GroupsResource(http, messages);
}

afterEach(() => {
  addMlsGroupMembersMock.mockClear();
  sendGroupInviteNotificationMock.mockClear();
  vi.restoreAllMocks();
});

describe("an invite to a group whose electorate decides admissions", () => {
  it("a_nomination_to_a_majority_group_posts_no_add_commit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await resourceFor("majority").invite(GROUP_ID, INVITEE_ID);
    expect(addMlsGroupMembersMock).not.toHaveBeenCalled();
  });

  it("a_nomination_to_a_unanimity_group_posts_no_add_commit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await resourceFor("unanimity").invite(GROUP_ID, [INVITEE_ID]);
    expect(addMlsGroupMembersMock).not.toHaveBeenCalled();
  });

  it("an_invitation_to_a_closed_group_still_posts_the_add_commit", async () => {
    // The control arm. Without it, a harness that never reached the MLS hook
    // at all would pass the two above for the wrong reason.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await resourceFor("closed").invite(GROUP_ID, INVITEE_ID);
    expect(addMlsGroupMembersMock).toHaveBeenCalledTimes(1);
  });

  it("a_nominee_is_still_told_it_was_nominated", async () => {
    // Consent runs through the nominee's own `join()` call, so an agent that
    // never learns of the nomination can never consent to it. Withholding the
    // leaf must not withhold the notice.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await resourceFor("majority").invite(GROUP_ID, INVITEE_ID);
    expect(sendGroupInviteNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("a_nomination_reports_no_mls_half_at_all", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = await resourceFor("majority").invite(GROUP_ID, [INVITEE_ID]);
    expect(report.mls).toBeUndefined();
  });
});
