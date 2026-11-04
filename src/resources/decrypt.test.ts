/**
 * The MLS recovery arm of `decryptEnvelope`: who it says it is, how it reports
 * a refusal, and what it says about the sync it ran.
 *
 * Three facts are pinned here. The first two were wrong before; the third was
 * silent before, which on an eviction is the same thing.
 *
 * 1. **The recovery names the reader.** `GET /groups/{id}/mls/handshakes`
 *    resolves its actor through `get_acting_agent`, which answers
 *    422 "Multiple active agents" for an org with two or more. This SDK
 *    resolves the agent per call (`resolveSenderId`) instead of pinning it on
 *    the client, so `core`'s default headers carry nothing unless the caller
 *    constructed the client with `agent` — which made the whole MLS retry arm
 *    unreachable for a multi-agent org, and reported the row as a decrypt
 *    error. The header is the fix and this is what holds it there.
 *
 * 2. **A refused Welcome is reported as itself**, and it is THIS row's group's
 *    refusal. `processMlsWelcomes` works the whole pending batch, so unscoped
 *    it raised whichever refusal the server's own welcomes response listed
 *    first — a group this row had nothing to do with could close it, and the
 *    recovery never reached `syncMlsGroup`. The pass now names the row's group
 *    (`forGroup`), and what comes back is classified with rine-core's exported
 *    code check — this is that export's first consumer — so the row says what
 *    actually happened rather than reading as its own decrypt failure.
 * * 3. **A read that synced says so.** Opening a closed group's message syncs
 *    that group first, and the result of that sync reached no reader: applying
 *    nothing and applying fourteen commits looked identical, and an agent
 *    evicted by a commit THIS read applied went on reading with no sign that
 *    its next send would be refused. The row now carries `catch_up`, and its
 *    absence means this read synced nothing rather than "you are current".
 *
 * Core is mocked at the module boundary: what is under test is this file's
 * wiring, not the crypto.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedDecryptedMessage } from "./decrypt.js";

const decryptGroupMessageMock = vi.fn();
const decryptMessageMock = vi.fn();
const processMlsWelcomesMock = vi.fn();
const syncMlsGroupMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		decryptGroupMessage: (...a: unknown[]) => decryptGroupMessageMock(...a),
		decryptMessage: (...a: unknown[]) => decryptMessageMock(...a),
		processMlsWelcomes: (...a: unknown[]) => processMlsWelcomesMock(...a),
		syncMlsGroup: (...a: unknown[]) => syncMlsGroupMock(...a),
	};
});

const { MlsWelcomeRefusedError } = await import("@rine-network/core");
const { decryptEnvelope } = await import("./decrypt.js");
const { GroupDecryptMemo } = await import("../utils/decrypt-memo.js");

type CoreHttpClient = import("@rine-network/core").HttpClient;

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SENDER_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_GROUP_ID = "66666666-6666-4666-8666-666666666666";
const MSG_ID = "44444444-4444-4444-8444-444444444444";
const CONFIG_DIR = "/tmp/rine-decrypt-recovery";

const core = {} as CoreHttpClient;

function mlsRow(): ParsedDecryptedMessage {
	return {
		id: MSG_ID,
		conversation_id: "55555555-5555-4555-8555-555555555555",
		from_agent_id: SENDER_ID,
		to_agent_id: AGENT_ID,
		type: "rine.v1.task_request",
		encrypted_payload: "not-read-the-decrypt-is-mocked",
		encryption_version: "mls-v1",
		group_id: GROUP_ID,
		sender_signing_kid: `rine:${SENDER_ID}`,
		created_at: "2026-08-03T00:00:00.000Z",
	} as ParsedDecryptedMessage;
}

/** The refusal the guard mints, as `processMlsWelcomes` raises it. */
function refusal(groupId: string) {
	return new MlsWelcomeRefusedError(
		groupId,
		"roster_uncorroborated",
		`Refusing the MLS welcome for group ${groupId}: the group's roster names nobody.`,
	);
}

const opened = {
	plaintext: JSON.stringify({ ok: true }),
	senderKid: `rine:${SENDER_ID}#0`,
	verified: true,
	verificationStatus: "verified",
};

afterEach(() => {
	vi.resetAllMocks();
});

describe("decryptEnvelope — the MLS recovery arm", () => {
	it("test_mls_retry_when_the_org_holds_several_agents_then_the_sync_names_the_reader", async () => {
		decryptGroupMessageMock
			.mockRejectedValueOnce(new Error("no MLS state for group"))
			.mockResolvedValueOnce(opened);
		processMlsWelcomesMock.mockResolvedValue(undefined);
		syncMlsGroupMock.mockResolvedValue({ processed: 1, epoch: 2 });

		const result = await decryptEnvelope({
			core,
			configDir: CONFIG_DIR,
			agentId: AGENT_ID,
			msg: mlsRow(),
			retrySenderKey: true,
		});

		expect(result.decrypt_error).toBeNull();
		// Without the fifth argument the route cannot tell which agent is
		// asking, and answers 422 for any org with more than one.
		expect(syncMlsGroupMock).toHaveBeenCalledWith(
			CONFIG_DIR,
			AGENT_ID,
			GROUP_ID,
			core,
			{ "X-Rine-Agent": AGENT_ID },
		);
	});

	it("test_mls_retry_when_a_pending_welcome_is_refused_then_the_row_says_it_was_a_refusal", async () => {
		decryptGroupMessageMock.mockRejectedValueOnce(
			new Error("no MLS state for group"),
		);
		processMlsWelcomesMock.mockRejectedValue(refusal(GROUP_ID));

		const result = await decryptEnvelope({
			core,
			configDir: CONFIG_DIR,
			agentId: AGENT_ID,
			msg: mlsRow(),
			retrySenderKey: true,
		});

		expect(result.plaintext).toBeUndefined();
		expect(result.verification_status).toBe("unverifiable");
		// Named as a welcome refusal, not as this row's own decrypt failure…
		expect(result.decrypt_error).toContain("welcome was refused");
		// …and the guard's own words, naming the group it is about, survive.
		expect(result.decrypt_error).toContain(GROUP_ID);
	});

	/**
	 * The recovery is scoped to THIS row's group, so a refusal for some other
	 * group cannot abort it. Before this the pass was unscoped: it worked the
	 * whole pending queue and raised whichever refusal the server's own welcomes
	 * response listed first, so one unrelated substituted Welcome closed every
	 * MLS row this client tried to recover — `syncMlsGroup` never ran and the
	 * decrypt never got its second attempt.
	 */
	it("test_mls_retry_when_only_another_groups_welcome_is_refused_then_the_recovery_still_runs", async () => {
		decryptGroupMessageMock
			.mockRejectedValueOnce(new Error("no MLS state for group"))
			.mockResolvedValueOnce(opened);
		processMlsWelcomesMock.mockImplementation(
			(_dir: string, _agent: string, _core: unknown, opts?: unknown) => {
				const forGroup = (opts as { forGroup?: string } | undefined)?.forGroup;
				// Only the OTHER group's Welcome was refused. A pass asked about
				// this row's group has nothing to report.
				return forGroup === OTHER_GROUP_ID || forGroup === undefined
					? Promise.reject(refusal(OTHER_GROUP_ID))
					: Promise.resolve({ processed: 0, groupIds: [] });
			},
		);
		syncMlsGroupMock.mockResolvedValue({ processed: 1, epoch: 2 });

		const result = await decryptEnvelope({
			core,
			configDir: CONFIG_DIR,
			agentId: AGENT_ID,
			msg: mlsRow(),
			retrySenderKey: true,
		});

		expect(result.decrypt_error).toBeNull();
		expect(syncMlsGroupMock).toHaveBeenCalledTimes(1);
	});

	/**
	 * And when both are refused, the row reports ITS OWN group's refusal — not
	 * whichever one the server chose to list first.
	 */
	it("test_mls_retry_when_the_server_orders_a_decoy_refusal_first_then_the_row_names_this_groups_refusal", async () => {
		decryptGroupMessageMock.mockRejectedValueOnce(
			new Error("no MLS state for group"),
		);
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

		const result = await decryptEnvelope({
			core,
			configDir: CONFIG_DIR,
			agentId: AGENT_ID,
			msg: mlsRow(),
			retrySenderKey: true,
		});

		expect(result.decrypt_error).toContain("welcome was refused");
		expect(result.decrypt_error).toContain(GROUP_ID);
		expect(result.decrypt_error).not.toContain(OTHER_GROUP_ID);
	});

	it("test_mls_retry_when_recovery_fails_for_any_other_reason_then_the_error_is_passed_through", async () => {
		// The control arm: only a refusal is re-worded. An ordinary recovery
		// failure must still reach the caller as itself.
		decryptGroupMessageMock.mockRejectedValueOnce(
			new Error("no MLS state for group"),
		);
		processMlsWelcomesMock.mockRejectedValue(new Error("socket hang up"));

		const result = await decryptEnvelope({
			core,
			configDir: CONFIG_DIR,
			agentId: AGENT_ID,
			msg: mlsRow(),
			retrySenderKey: true,
		});

		expect(result.decrypt_error).toBe("socket hang up");
		expect(result.verification_status).toBe("unverifiable");
	});
});

describe("decryptEnvelope — what the read says about the sync it ran", () => {
	it("test_mls_row_when_the_read_synced_then_the_row_reports_what_it_applied", async () => {
		// Reading a closed group syncs it first, and that sync used to be
		// invisible: a reader could not tell fourteen applied commits from none,
		// and an eviction applied by this very read showed up nowhere — the row
		// still opens, and the NEXT send is the thing that is refused.
		decryptGroupMessageMock.mockResolvedValueOnce({
			...opened,
			catchUp: { epoch: 9, processed: 3, evicted: true },
		});

		const result = await decryptEnvelope({
			core,
			configDir: CONFIG_DIR,
			agentId: AGENT_ID,
			msg: mlsRow(),
			retrySenderKey: true,
		});

		expect(result.decrypt_error).toBeNull();
		expect(result.catch_up).toEqual({ epoch: 9, processed: 3, evicted: true });
	});

	it("test_mls_row_when_no_sync_ran_then_the_row_claims_nothing", async () => {
		// Absent means "this read synced nothing", never "you are current" — so
		// the field must be missing rather than a zeroed report of a sync that
		// never happened.
		decryptGroupMessageMock.mockResolvedValueOnce(opened);

		const result = await decryptEnvelope({
			core,
			configDir: CONFIG_DIR,
			agentId: AGENT_ID,
			msg: mlsRow(),
			retrySenderKey: true,
		});

		expect(result.decrypt_error).toBeNull();
		expect(result.catch_up).toBeUndefined();
	});

	it("test_mls_row_when_the_read_is_served_from_the_memo_then_it_reports_no_sync", async () => {
		// The second read applies no commits and advances no epoch — the ratchet
		// step is spent and the plaintext comes back from the memo. Reporting the
		// first read's sync again would count one eviction twice, which is the
		// one thing a reader acts on. The Python twin strips it in
		// `DecryptResult.as_replay()`.
		decryptGroupMessageMock.mockResolvedValueOnce({
			...opened,
			catchUp: { epoch: 9, processed: 3, evicted: true },
		});
		const memo = new GroupDecryptMemo();
		const opts = {
			core,
			configDir: CONFIG_DIR,
			agentId: AGENT_ID,
			msg: mlsRow(),
			retrySenderKey: true,
			memo,
		};

		const first = await decryptEnvelope(opts);
		const replay = await decryptEnvelope(opts);

		expect(first.catch_up).toEqual({ epoch: 9, processed: 3, evicted: true });
		// The ratchet was never asked a second time — this is the memo answering.
		expect(decryptGroupMessageMock).toHaveBeenCalledTimes(1);
		expect(replay.decrypt_error).toBeNull();
		expect(replay.plaintext).toEqual(first.plaintext);
		expect(replay.catch_up).toBeUndefined();
	});
});

describe("decryptEnvelope — every row it does not open says why", () => {
	// `read()` decides whether to mark a row delivered from `decrypt_error == null`
	// as the positive "opened", so an arm that closes a row without setting it
	// would get the row consumed. This pins each closing arm.
	const direct = { ...mlsRow(), encryption_version: "hpke-hybrid-v2" };
	const cases: [string, ParsedDecryptedMessage, () => void][] = [
		[
			"an empty payload",
			{ ...mlsRow(), encrypted_payload: "" } as ParsedDecryptedMessage,
			() => {},
		],
		[
			"no authenticated sender",
			{ ...mlsRow(), from_agent_id: null } as unknown as ParsedDecryptedMessage,
			() => {},
		],
		[
			"an unknown encryption version",
			{ ...mlsRow(), encryption_version: "v9" } as ParsedDecryptedMessage,
			() => {},
		],
		[
			"a 1:1 decrypt that throws",
			direct as ParsedDecryptedMessage,
			() => decryptMessageMock.mockRejectedValue(new Error("no keys")),
		],
		[
			"a 1:1 authenticity refusal",
			direct as ParsedDecryptedMessage,
			() =>
				decryptMessageMock.mockResolvedValue({
					plaintext: undefined,
					verified: false,
					verificationStatus: "invalid",
				}),
		],
		[
			"a group decrypt that throws",
			mlsRow(),
			() => decryptGroupMessageMock.mockRejectedValue(new Error("boom")),
		],
	];

	it.each(cases)("sets decrypt_error for %s", async (_name, row, arrange) => {
		arrange();

		const result = await decryptEnvelope({
			core,
			configDir: CONFIG_DIR,
			agentId: AGENT_ID,
			msg: row,
		});

		expect(result.plaintext).toBeUndefined();
		expect(result.decrypt_error).toEqual(expect.any(String));
	});
});
