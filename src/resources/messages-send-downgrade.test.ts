/**
 * The TS SDK send path refuses a downgraded group.
 *
 * Two properties, one call site. The guard sits between the group resolve and
 * the encryption branch, and the placement is the whole requirement:
 * `getOrCreateSenderKey` fans this agent's sender key out to whatever
 * membership the server returns, so by the time the sender-key branch has run
 * the key is already gone. Every refusal test therefore asserts the typed error
 * AND that `getOrCreateSenderKey` was never reached — the second assertion is
 * the one that means something.
 *
 * And the branch is taken from the SEND predicate, not from `mls_group_id`
 * alone: a group mid-init is frozen server-side, so a sender-key send there
 * earns a 409 the client could have predicted.
 *
 * `assertNoMlsDowngrade` is substituted at the `@rine-network/core` boundary
 * with the same decision over an in-memory set of "groups this agent holds
 * state for", because the real one opens the native MLS store. It throws the
 * real `MlsDowngradeError`, and the arguments it was handed are asserted, so
 * the call site's contract is pinned rather than assumed. The guard's own truth
 * table is proven in `rine-core/test/crypto/mls-downgrade.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SENDER_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const GROUP_HANDLE = "#dev@acme.rine.network";
const CONFIG_DIR = "/tmp/rine-send-downgrade";

/** Groups this agent is pretending to hold local MLS state for. */
const localMlsState = new Set<string>();

interface GuardCall {
	configDir: string;
	agentId: string;
	groupId: string;
	serverSaysMls: boolean;
}
const guardCalls: GuardCall[] = [];

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	const { MlsDowngradeError } = actual as {
		MlsDowngradeError: new (groupId: string) => Error;
	};
	return {
		...actual,
		assertNoMlsDowngrade: (
			configDir: string,
			agentId: string,
			groupId: string,
			serverSaysMls: boolean,
		) => {
			guardCalls.push({ configDir, agentId, groupId, serverSaysMls });
			if (serverSaysMls) return;
			if (!localMlsState.has(groupId)) return;
			throw new MlsDowngradeError(groupId);
		},
		getOrCreateSenderKey: vi.fn(async () => ({
			state: { __state: true },
			groupId: GROUP_ID,
		})),
		encryptGroupMessage: vi.fn(async () => ({
			result: {
				encrypted_payload: "ENC(GROUP)",
				encryption_version: "sender-key-v1",
				sender_signing_kid: "sig-kid-grp",
			},
		})),
		encryptMlsGroupMessage: vi.fn(async () => ({
			encrypted_payload: "ENC(MLS)",
			encryption_version: "mls-v1",
			sender_signing_kid: "sig-kid-mls",
		})),
		processMlsWelcomes: vi.fn(async () => undefined),
		syncMlsGroup: vi.fn(async () => undefined),
		fetchAgents: vi.fn(async () => [
			{ id: SENDER_ID, handle: "me@acme.rine.network" },
		]),
		resolveAgent: vi.fn(async () => ({ agentId: SENDER_ID })),
	};
});

const core = await import("@rine-network/core");
const { MessagesResource } = await import("./messages.js");
const {
	DOWNGRADE_REFUSED_CODE,
	MLS_INIT_IN_FLIGHT_CODE,
	MLS_PENDING_SELF_CLEAR_SECONDS,
	isMlsDowngradeError,
	isMlsInitInFlightError,
} = core;

type SDKHttpClient = import("../api/http.js").SDKHttpClient;

interface GroupOverrides {
	mls_group_id?: string | null;
	mls_pending?: boolean;
}

interface Harness {
	messages: InstanceType<typeof MessagesResource>;
	posts: string[];
}

/**
 * A send harness whose `/groups` lookup answers with one group in whatever MLS
 * shape the test needs, and which records every POST so a refusal can be shown
 * to have reached the wire zero times.
 */
function makeHarness(overrides: GroupOverrides = {}): Harness {
	const posts: string[] = [];
	const group = {
		id: GROUP_ID,
		name: "dev",
		handle: GROUP_HANDLE,
		created_at: "2026-06-20T00:00:00.000Z",
		mls_group_id: null,
		mls_pending: false,
		...overrides,
	};
	const http = {
		configDir: CONFIG_DIR,
		getCoreHttpClient: () => ({
			get: async () => ({ items: [group] }),
			post: async () => ({}),
		}),
		async post<T>(path: string): Promise<T> {
			posts.push(path);
			return {
				id: "44444444-4444-4444-8444-444444444444",
				conversation_id: "55555555-5555-4555-8555-555555555555",
				from_agent_id: SENDER_ID,
				group_handle: GROUP_HANDLE,
				type: "rine.v1.task_request",
				encrypted_payload: "ENC(GROUP)",
				encryption_version: "sender-key-v1",
				created_at: "2026-06-20T00:00:00.000Z",
				metadata: {},
			} as T;
		},
	} as unknown as SDKHttpClient;
	return { messages: new MessagesResource(http), posts };
}

const FABRICATED_SPELLING = "#dev@wrong.example";

interface FabricatedHarness extends Harness {
	/** Every `?handle=` equality probe, so a miss can be proven to be a miss. */
	handleQueries: string[];
}

/**
 * The fabricated-org shape: the caller spells an org half that does not
 * exist, and the group is found by its local part instead.
 *
 * Routed rather than blanket-stubbed, deliberately — an `?handle=` rung that
 * answered the fabricated spelling would resolve on the WRONG rung and the
 * assertion below would pass without the fallback ever running.
 */
function makeFabricatedOrgHarness(): FabricatedHarness {
	const posts: string[] = [];
	const handleQueries: string[] = [];
	const group = {
		id: GROUP_ID,
		name: "dev",
		handle: GROUP_HANDLE,
		created_at: "2026-06-20T00:00:00.000Z",
		mls_group_id: null,
		mls_pending: true,
	};
	const http = {
		configDir: CONFIG_DIR,
		getCoreHttpClient: () => ({
			get: async (_path: string, params?: Record<string, unknown>) => {
				const asked = params?.handle;
				if (typeof asked === "string") {
					handleQueries.push(asked);
					// Equality, as the route is.
					return { items: asked === GROUP_HANDLE ? [group] : [] };
				}
				return { items: [group] };
			},
			post: async () => ({}),
		}),
		async post<T>(path: string): Promise<T> {
			posts.push(path);
			return {} as T;
		},
	} as unknown as SDKHttpClient;
	return { messages: new MessagesResource(http), posts, handleQueries };
}

function send(h: Harness): Promise<unknown> {
	return h.messages.send(GROUP_HANDLE as never, { text: "hi group" });
}

beforeEach(() => {
	localMlsState.clear();
	guardCalls.length = 0;
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("send refuses a downgraded group", () => {
	it("send_when_server_contradicts_local_mls_state_refuses", async () => {
		localMlsState.add(GROUP_ID);
		const h = makeHarness({ mls_group_id: null });

		const err = await send(h).catch((e: unknown) => e);

		expect(isMlsDowngradeError(err)).toBe(true);
		expect((err as { code: string }).code).toBe(DOWNGRADE_REFUSED_CODE);
	});

	it("send_when_server_contradicts_local_mls_state_never_makes_a_sender_key", async () => {
		localMlsState.add(GROUP_ID);
		const h = makeHarness({ mls_group_id: null });

		await expect(send(h)).rejects.toThrow();

		expect(core.getOrCreateSenderKey).not.toHaveBeenCalled();
		expect(core.encryptGroupMessage).not.toHaveBeenCalled();
		expect(h.posts).toEqual([]);
	});

	it("send_when_refused_does_not_retry_as_sender_key", async () => {
		localMlsState.add(GROUP_ID);
		const h = makeHarness({ mls_group_id: null });

		await expect(send(h)).rejects.toThrow();
		await expect(send(h)).rejects.toThrow();

		expect(core.getOrCreateSenderKey).not.toHaveBeenCalled();
	});

	it("send_when_guarding_passes_the_config_dir_agent_and_group_uuid", async () => {
		const h = makeHarness({ mls_group_id: null });

		await send(h);

		expect(guardCalls).toEqual([
			{
				configDir: CONFIG_DIR,
				agentId: SENDER_ID,
				groupId: GROUP_ID,
				serverSaysMls: false,
			},
		]);
	});

	it("send_when_billboard_group_has_no_mls_state_still_uses_sender_keys", async () => {
		const h = makeHarness({ mls_group_id: null });

		await send(h);

		expect(core.getOrCreateSenderKey).toHaveBeenCalledTimes(1);
		expect(h.posts).toEqual(["/messages"]);
	});
});

describe("send branches on the send predicate", () => {
	it("send_when_group_is_mls_latched_takes_the_mls_branch", async () => {
		const h = makeHarness({ mls_group_id: "opaque-latch" });

		await send(h);

		expect(core.encryptMlsGroupMessage).toHaveBeenCalledTimes(1);
		expect(core.getOrCreateSenderKey).not.toHaveBeenCalled();
		expect(guardCalls[0]?.serverSaysMls).toBe(true);
	});

	it("send_when_init_is_pending_never_makes_a_sender_key", async () => {
		const h = makeHarness({ mls_group_id: null, mls_pending: true });

		await expect(send(h)).rejects.toThrow();

		expect(core.getOrCreateSenderKey).not.toHaveBeenCalled();
		expect(h.posts).toEqual([]);
	});

	it("send_when_init_is_pending_refuses_with_the_stable_code", async () => {
		// The code is the caller's handle on this refusal; the message is for the
		// operator reading it, and naming the self-clear window is its job.
		const h = makeHarness({ mls_group_id: null, mls_pending: true });

		const err = await send(h).catch((e: unknown) => e);

		expect(isMlsInitInFlightError(err)).toBe(true);
		expect((err as { code: string }).code).toBe(MLS_INIT_IN_FLIGHT_CODE);
		const minutes = Math.round(MLS_PENDING_SELF_CLEAR_SECONDS / 60);
		expect((err as Error).message).toContain(`${minutes} minutes`);
	});

	it("send_when_init_is_pending_names_the_group_that_answered_not_the_spelling", async () => {
		// The one behavioural cell nothing else pins: a model that learns a
		// local part from the conversation and copies the domain out of a
		// shipped example sends to `#dev@wrong.example`. The `?handle=` rung is
		// an equality test and misses; the local part then goes through the
		// four name tiers and finds `#dev@acme.rine.network`. The refusal must
		// name the group that ANSWERED — the caller's spelling names a group
		// that does not exist, and telling them it is initialising MLS sends
		// them to look for it.
		const h = makeFabricatedOrgHarness();

		const err = await h.messages
			.send(FABRICATED_SPELLING as never, { text: "hi group" })
			.catch((e: unknown) => e);

		expect(isMlsInitInFlightError(err)).toBe(true);
		expect((err as Error).message).toContain(GROUP_HANDLE);
		expect((err as Error).message).not.toContain("wrong.example");
		// Proof the fabricated org really did miss the equality rung, so this test
		// exercises the fallback and not a harness that answers everything.
		expect(h.handleQueries).toEqual([FABRICATED_SPELLING]);
	});

	it("send_when_init_is_pending_tells_the_guard_the_group_is_mls", async () => {
		// The guard's input is the SEND predicate. Reading `mls_group_id` alone
		// here would ask the guard the render question and refuse a member who
		// legitimately holds state for a group mid-init.
		const h = makeHarness({ mls_group_id: null, mls_pending: true });

		await expect(send(h)).rejects.toThrow();

		expect(guardCalls[0]?.serverSaysMls).toBe(true);
	});
});
/**
 * The send path's MLS recovery asks about the group it is sending to.
 *
 * The `processMlsWelcomes` inside `encryptMlsWithRecovery` is UNCAUGHT, unlike
 * the pre-sync above it, so whatever refusal that pass raises aborts the send.
 * Left unscoped a pass answers with the first refusal whose bytes arrived in it
 * — and the server picks that order by picking the order of its own welcomes
 * response — so a substituted Welcome for an unrelated group would abort a send
 * that has nothing to do with it.
 *
 * The mock below is rine-core's own `pickRefusal` rule (`mls-ops-join.ts`):
 * scoped, the named group's refusal; unscoped, the first in the server's order.
 * That rule is measured faithful against the real native core.
 *
 * The Python twin already scopes this path through `install_mls_state`
 * (`_mls/join.py`), so this closes a gap between the two stacks.
 */
describe("the MLS send recovery scopes its Welcome pass", () => {
	const OTHER_GROUP_ID = "66666666-6666-4666-8666-666666666666";
	// `core` is a value binding from `await import(...)`, so its classes are not
	// usable in type position without this.
	type Refusal = InstanceType<typeof core.MlsWelcomeRefusedError>;

	/** The refusal the group substitution guard mints, as a pass raises it. */
	function refusal(groupId: string): Refusal {
		return new core.MlsWelcomeRefusedError(
			groupId,
			"roster_uncorroborated",
			`Refusing the MLS welcome for group ${groupId}`,
		);
	}

	/** rine-core's `pickRefusal`, over a batch in the server's chosen order. */
	function serverOrders(...batch: Refusal[]) {
		return async (
			_configDir: string,
			_agentId: string,
			_client: unknown,
			opts?: { forGroup?: string },
		) => {
			const chosen = opts?.forGroup
				? batch.find((r) => r.groupId === opts.forGroup)
				: batch[0];
			if (chosen) throw chosen;
			return { processed: 0, groupIds: [] };
		};
	}

	beforeEach(() => {
		// The recovery arm runs only when the first encrypt reports no local state.
		vi.mocked(core.encryptMlsGroupMessage).mockRejectedValueOnce(
			core.noMlsStateError(GROUP_ID),
		);
	});

	afterEach(() => {
		// The file's `vi.clearAllMocks()` clears calls, not implementations, so a
		// mock set here would otherwise outlive its own test.
		vi.mocked(core.processMlsWelcomes).mockImplementation(
			async () => undefined as never,
		);
	});

	it("send_when_recovering_and_another_groups_welcome_is_refused_then_the_send_still_lands", async () => {
		vi.mocked(core.processMlsWelcomes).mockImplementation(
			serverOrders(refusal(OTHER_GROUP_ID)) as never,
		);
		const h = makeHarness({ mls_group_id: "opaque-latch" });

		await send(h);

		expect(h.posts).toEqual(["/messages"]);
		expect(core.encryptMlsGroupMessage).toHaveBeenCalledTimes(2);
	});

	it("send_when_recovering_and_this_groups_welcome_is_refused_then_the_send_fails", async () => {
		// The decoy is FIRST in the server's order, so an unscoped pass answers
		// with it and this group's refusal never reaches the caller.
		vi.mocked(core.processMlsWelcomes).mockImplementation(
			serverOrders(refusal(OTHER_GROUP_ID), refusal(GROUP_ID)) as never,
		);
		const h = makeHarness({ mls_group_id: "opaque-latch" });

		const err = await send(h).catch((e: unknown) => e);

		expect(core.isMlsWelcomeRefusedError(err)).toBe(true);
		expect((err as Refusal).groupId).toBe(GROUP_ID);
		expect(h.posts).toEqual([]);
	});

	it("send_when_recovering_names_the_group_being_sent_to", async () => {
		const h = makeHarness({ mls_group_id: "opaque-latch" });

		await send(h);

		expect(core.processMlsWelcomes).toHaveBeenCalledWith(
			CONFIG_DIR,
			SENDER_ID,
			expect.anything(),
			{ forGroup: GROUP_ID },
		);
	});
});
