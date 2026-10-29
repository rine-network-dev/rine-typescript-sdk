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
 *   - a refusal naming ANOTHER group does not — the establishment's Welcome
 *     pass is scoped to the group named, so one group's verdict is not this
 *     join's and the join completes;
 *   - every other MLS setup failure still warns and still returns joined.
 *
 * Core is mocked at the module boundary, so no MLS crypto runs; the refusal is
 * the real `MlsWelcomeRefusedError` from `@rine-network/core`, because the
 * classification under test is its exported code check and a hand-rolled
 * look-alike would not exercise it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const establishMlsMembershipMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    establishMlsMembership: (...a: unknown[]) => establishMlsMembershipMock(...a),
  };
});

const { MlsEstablishStep, MlsMembershipOutcome, MlsWelcomeRefusedError } = await import("@rine-network/core");
const { GroupsResource } = await import("./groups.js");

type SDKHttpClient = import("../api/http.js").SDKHttpClient;
type MessagesResource = import("./messages.js").MessagesResource;
type GroupUuid = import("../types.js").GroupUuid;

const GROUP_ID = "33333333-3333-4333-8333-333333333333" as GroupUuid;
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CONFIG_DIR = "/tmp/rine-mls-refusal";
const MLS_GROUP_ID = "mls-latch-abc";

/** The refusal the guard mints, as `establishMlsMembership` raises it. */
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
    establishMlsMembershipMock.mockResolvedValue({ outcome: MlsMembershipOutcome.Installed });
  });

  it("test_join_when_the_welcome_for_this_group_is_refused_then_join_rejects", async () => {
    establishMlsMembershipMock.mockRejectedValue(refusal(GROUP_ID));
    const groups = new GroupsResource(makeHttp(), makeMessages());

    await expect(groups.join(GROUP_ID)).rejects.toThrow(
      /Refusing the MLS welcome for group/,
    );
    expect(establishMlsMembershipMock).toHaveBeenCalledTimes(1);
  });

  it("test_join_when_the_welcome_for_this_group_is_refused_then_the_error_is_the_guards_own", async () => {
    establishMlsMembershipMock.mockRejectedValue(refusal(GROUP_ID));
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
   * decoy refusal for another group listed FIRST by the server. The
   * establishment scopes its Welcome pass to the group the caller named, so a
   * decoy cannot take the place of this group's refusal (measured against the
   * real native core in rine-core); what `join()` owes is to raise whatever
   * refusal for this group the establishment throws.
   */
  it("test_join_when_the_establishment_raises_this_groups_refusal_then_join_rejects_with_it", async () => {
    establishMlsMembershipMock.mockRejectedValue(refusal(GROUP_ID));
    const groups = new GroupsResource(makeHttp(), makeMessages());

    await expect(groups.join(GROUP_ID)).rejects.toMatchObject({
      code: "RINE_WELCOME_REFUSED",
      groupId: GROUP_ID,
    });
    expect(establishMlsMembershipMock).toHaveBeenCalledWith(
      CONFIG_DIR,
      AGENT_ID,
      GROUP_ID,
      expect.anything(),
      { "X-Rine-Agent": AGENT_ID },
    );
  });

  it("test_join_when_the_establishment_installs_state_then_join_completes_without_a_warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const groups = new GroupsResource(makeHttp(), makeMessages());

    const result = await groups.join(GROUP_ID);

    expect(result.status).toBe("joined");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("test_join_when_an_ordinary_mls_setup_failure_happens_then_join_still_completes", async () => {
    // Not a refusal — a transient failure must NOT start throwing out of a
    // verb whose server-side work has already succeeded. The core reports it as
    // a `failed` result, never as a throw.
    establishMlsMembershipMock.mockResolvedValue({
      outcome: MlsMembershipOutcome.Failed,
      reason: "socket hang up",
      failure: { step: MlsEstablishStep.WelcomeInstall, error: new Error("socket hang up") },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const groups = new GroupsResource(makeHttp(), makeMessages());

    const result = await groups.join(GROUP_ID);

    expect(result.status).toBe("joined");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
