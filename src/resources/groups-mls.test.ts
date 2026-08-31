/**
 * `groups.join()` and the one MLS failure it does NOT swallow.
 *
 * The two stacks must agree, and a refusal must be loud.
 * The Python twin `rine._mls.join.join_mls_state` raises
 * `MlsWelcomeRefusedError` out of `groups.join()`; before this these three
 * TypeScript verbs answered the same input with `console.warn` and a
 * `{status:"joined"}` result, so the security decision the guard exists to
 * surface reached nobody on the stack most people use.
 *
 * What is pinned here, and what is deliberately NOT:
 *
 *   - a refusal naming THIS group leaves `groups.join()` as a rejection;
 *   - a refusal naming ANOTHER group does not — the batch installs every
 *     Welcome it can before raising, and one group's verdict is not this
 *     join's, so the setup carries on into the external-join fallback exactly
 *     as `install_mls_state` does on Python;
 *   - every other MLS setup failure still warns and still returns joined.
 *
 * Core is mocked at the module boundary, so no MLS crypto runs; the refusal is
 * the real `MlsWelcomeRefusedError` from `@rine-network/core`, because the
 * classification under test is its exported code check and a hand-rolled
 * look-alike would not exercise it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processMlsWelcomesMock = vi.fn();
const externalJoinMlsGroupMock = vi.fn();
const loadMlsStateMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    processMlsWelcomes: (...a: unknown[]) => processMlsWelcomesMock(...a),
    externalJoinMlsGroup: (...a: unknown[]) => externalJoinMlsGroupMock(...a),
    loadMlsState: (...a: unknown[]) => loadMlsStateMock(...a),
  };
});

const { MlsWelcomeRefusedError } = await import("@rine-network/core");
const { GroupsResource } = await import("./groups.js");

type SDKHttpClient = import("../api/http.js").SDKHttpClient;
type MessagesResource = import("./messages.js").MessagesResource;
type GroupUuid = import("../types.js").GroupUuid;

const GROUP_ID = "33333333-3333-4333-8333-333333333333" as GroupUuid;
const OTHER_GROUP_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CONFIG_DIR = "/tmp/rine-mls-refusal";
const MLS_GROUP_ID = "mls-latch-abc";

/** The refusal the guard mints, as `processMlsWelcomes` raises it. */
function refusal(groupId: string) {
  return new MlsWelcomeRefusedError(
    groupId,
    "roster_uncorroborated",
    `Refusing the MLS welcome for group ${groupId}: the group's roster names ` +
      "no member holding a leaf in the ratchet tree this welcome seats the " +
      "agent in.",
  );
}

function makeHttp(): SDKHttpClient {
  const group = {
    id: GROUP_ID,
    name: "dev",
    handle: "#dev@acme.rine.network",
    created_at: "2026-04-11T12:00:00Z",
    mls_group_id: MLS_GROUP_ID,
  };
  return {
    configDir: CONFIG_DIR,
    getCoreHttpClient: () => ({ __core: true }),
    async get<T>(): Promise<T> {
      return group as T;
    },
    async postWithStatus<T>(): Promise<{ status: number; body: T }> {
      return {
        status: 200,
        body: {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          group_id: GROUP_ID,
          agent_id: AGENT_ID,
          role: "member",
          joined_at: "2026-04-12T00:00:00.000Z",
          agent_handle: "bot@acme.rine.network",
        } as T,
      };
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

describe("GroupsResource.join — a refused Welcome is not best-effort", () => {
  beforeEach(() => {
    loadMlsStateMock.mockReturnValue(null);
    externalJoinMlsGroupMock.mockResolvedValue({ epoch: 2 });
  });

  it("test_join_when_the_welcome_for_this_group_is_refused_then_join_rejects", async () => {
    processMlsWelcomesMock.mockRejectedValue(refusal(GROUP_ID));
    const groups = new GroupsResource(makeHttp(), makeMessages());

    await expect(groups.join(GROUP_ID)).rejects.toThrow(
      /Refusing the MLS welcome for group/,
    );
    // And the substitution is not papered over by a self-join into whatever
    // the server would hand out next.
    expect(externalJoinMlsGroupMock).not.toHaveBeenCalled();
  });

  it("test_join_when_the_welcome_for_this_group_is_refused_then_the_error_is_the_guards_own", async () => {
    processMlsWelcomesMock.mockRejectedValue(refusal(GROUP_ID));
    const groups = new GroupsResource(makeHttp(), makeMessages());

    // A caller must be able to branch on the refusal without matching text.
    await expect(groups.join(GROUP_ID)).rejects.toMatchObject({
      code: "RINE_WELCOME_REFUSED",
      groupId: GROUP_ID,
      reason: "roster_uncorroborated",
    });
  });

  /**
   * The two-Welcome case, which is what the guard is actually up against: a
   * batch carrying a refusal for the group being joined AND a decoy for
   * another, with the decoy listed FIRST by the server. The mock is rine-core's
   * `pickRefusal` rule (`mls-ops-join.ts`) — unscoped, the pass answers with the
   * first refusal whose bytes arrived this pass, and the server chose that order
   * by choosing the order of its own welcomes response.
   *
   * MEASURED against the real native core with two substituted Welcomes: the
   * verb's outcome is `warned` unscoped and `raised` scoped, on that argument
   * alone. Unscoped, `join()` resolved `{status:"joined"}` for a group whose
   * Welcome this client had just refused, and went on to self-join it by
   * external commit.
   */
  it("test_join_when_the_server_orders_a_decoy_refusal_first_then_this_groups_refusal_still_rejects", async () => {
    // Server response order: the decoy first, this group's refusal second.
    const batch = [refusal(OTHER_GROUP_ID), refusal(GROUP_ID)];
    processMlsWelcomesMock.mockImplementation(
      (_dir: string, _agent: string, _core: unknown, opts?: unknown) => {
        const forGroup = (opts as { forGroup?: string } | undefined)?.forGroup;
        const chosen = forGroup
          ? batch.find((r) => r.groupId === forGroup)
          : batch[0];
        return chosen
          ? Promise.reject(chosen)
          : Promise.resolve({ processed: 0, groupIds: [] });
      },
    );
    const groups = new GroupsResource(makeHttp(), makeMessages());

    await expect(groups.join(GROUP_ID)).rejects.toMatchObject({
      code: "RINE_WELCOME_REFUSED",
      groupId: GROUP_ID,
    });
    expect(externalJoinMlsGroupMock).not.toHaveBeenCalled();
  });

  it("test_join_when_another_groups_welcome_is_refused_then_this_join_still_completes", async () => {
    processMlsWelcomesMock.mockRejectedValue(refusal(OTHER_GROUP_ID));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const groups = new GroupsResource(makeHttp(), makeMessages());

    const result = await groups.join(GROUP_ID);

    expect(result.status).toBe("joined");
    // The setup carried on: the open-enrollment fallback still ran for the
    // group actually being joined.
    expect(externalJoinMlsGroupMock).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).toContain(OTHER_GROUP_ID);
    warn.mockRestore();
  });

  it("test_join_when_an_ordinary_mls_setup_failure_happens_then_join_still_completes", async () => {
    // Not a refusal — a transient failure must NOT start throwing out of a
    // verb whose server-side work has already succeeded.
    processMlsWelcomesMock.mockRejectedValue(new Error("socket hang up"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const groups = new GroupsResource(makeHttp(), makeMessages());

    const result = await groups.join(GROUP_ID);

    expect(result.status).toBe("joined");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
