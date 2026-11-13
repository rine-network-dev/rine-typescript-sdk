/**
 * The group retry path must not swallow an authenticity verdict.
 *
 * `decryptGroupMessage` refuses an untrusted author by throwing
 * `GroupAuthenticityError`. On the receive surfaces that opt into
 * `retrySenderKey: true` (`read()`, `sendAndWait()`, `client.messages()`, the
 * group thread) that throw lands in the retry arm, where refreshing key material
 * cannot change the verdict: without a gate the row comes back `unverifiable`
 * with the retry's own error text, and the misattribution reads like a missing
 * key. Both group versions share the one catch, so both are pinned here.
 *
 * Core is mocked at the module boundary — the verdict is what is under test, not
 * the crypto that produced it, and the MLS case needs no native group state.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedDecryptedMessage } from "./decrypt.js";

const decryptGroupMessageMock = vi.fn();
const processMlsWelcomesMock = vi.fn();
const syncMlsGroupMock = vi.fn();
const fetchAndIngestPendingSKDistributionsMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		decryptGroupMessage: (...a: unknown[]) => decryptGroupMessageMock(...a),
		processMlsWelcomes: (...a: unknown[]) => processMlsWelcomesMock(...a),
		syncMlsGroup: (...a: unknown[]) => syncMlsGroupMock(...a),
		fetchAndIngestPendingSKDistributions: (...a: unknown[]) =>
			fetchAndIngestPendingSKDistributionsMock(...a),
	};
});

const {
	GroupAuthenticityError,
	MLS_ERR_GROUP_INACTIVE,
	SENDER_KEY_UNAVAILABLE_CODE,
	SenderKeyUnavailableError,
	UNKNOWN_SENDER_KEY_CLAUSE,
	mlsReadRefusal,
	sdkSyncRemedy,
} = await import("@rine-network/core");
const { decryptEnvelope } = await import("./decrypt.js");

type CoreHttpClient = import("@rine-network/core").HttpClient;

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SENDER_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const MSG_ID = "44444444-4444-4444-8444-444444444444";

function groupRow(version: "mls-v1" | "sender-key-v1"): ParsedDecryptedMessage {
	return {
		id: MSG_ID,
		conversation_id: "55555555-5555-4555-8555-555555555555",
		from_agent_id: SENDER_ID,
		to_agent_id: AGENT_ID,
		type: "rine.v1.task_request",
		encrypted_payload: "not-read-the-decrypt-is-mocked",
		encryption_version: version,
		group_id: GROUP_ID,
		sender_signing_kid: `rine:${SENDER_ID}`,
		created_at: "2026-07-25T00:00:00.000Z",
	} as ParsedDecryptedMessage;
}

const core = {} as CoreHttpClient;

afterEach(() => {
	// Reset, not clear: a test whose refusal short-circuits leaves its unused
	// `…Once` rejection queued, and the next test would consume it first.
	vi.resetAllMocks();
});

describe("group decrypt refusal under retrySenderKey", () => {
	it("test_mls_row_when_signer_is_not_the_row_sender_then_reports_sender_mismatch", async () => {
		// A refused MLS message still spends its ratchet key, so a second attempt
		// on the same row fails as a spent key — the verdict has to survive the
		// first throw or it is replaced by that unrelated failure.
		decryptGroupMessageMock
			.mockRejectedValueOnce(new GroupAuthenticityError("sender-mismatch"))
			.mockRejectedValueOnce(
				new Error("message key expired or already consumed"),
			);

		const result = await decryptEnvelope({
			core,
			configDir: "/nonexistent",
			agentId: AGENT_ID,
			msg: groupRow("mls-v1"),
			retrySenderKey: true,
		});

		expect(result.verification_status).toBe("sender-mismatch");
		expect(result.verified).toBe(false);
		expect(result.plaintext).toBeUndefined();
		expect(result.decrypt_error).toBe(
			"Envelope sender does not match the message sender",
		);
		// The verdict is final, so the row costs no recovery round trips.
		expect(decryptGroupMessageMock).toHaveBeenCalledTimes(1);
		expect(processMlsWelcomesMock).not.toHaveBeenCalled();
		expect(syncMlsGroupMock).not.toHaveBeenCalled();
	});

	it("test_mls_read_when_the_epoch_predates_the_readers_leaf_then_the_row_carries_the_typed_refusal", async () => {
		// The core's KDF error for a message sealed at the epoch an external commit
		// was built on: no key can open it, so the row says so in rine's words and
		// not in the crypto library's.
		const kdf = Object.assign(
			new Error("the provided length of the key 0 is shorter than the minimum length 32"),
			{ code: "RINE_MLS_PROTOCOL" },
		);
		decryptGroupMessageMock.mockRejectedValue(kdf);

		const result = await decryptEnvelope({
			core,
			configDir: "/nonexistent",
			agentId: AGENT_ID,
			msg: groupRow("mls-v1"),
			retrySenderKey: true,
		});

		expect(result.decrypt_error).toBe(mlsReadRefusal(GROUP_ID, sdkSyncRemedy(GROUP_ID)));
		expect(result.decrypt_error_code).toBeNull();
	});

	it("test_mls_read_when_the_group_evicted_the_reader_then_the_row_keeps_the_evictions_own_words", async () => {
		// No sync undoes a Remove, so the sentence that offers a sync as the way
		// out would be the wrong remedy for a reader the group has removed.
		const evicted = Object.assign(new Error("the group no longer includes this agent"), {
			code: MLS_ERR_GROUP_INACTIVE,
		});
		decryptGroupMessageMock.mockRejectedValue(evicted);

		const result = await decryptEnvelope({
			core,
			configDir: "/nonexistent",
			agentId: AGENT_ID,
			msg: groupRow("mls-v1"),
			retrySenderKey: true,
		});

		expect(result.decrypt_error).toBe("the group no longer includes this agent");
		expect(result.decrypt_error).not.toBe(mlsReadRefusal(GROUP_ID, sdkSyncRemedy(GROUP_ID)));
	});

	it("test_sender_key_row_when_signature_is_invalid_then_reports_invalid", async () => {
		decryptGroupMessageMock
			.mockRejectedValueOnce(new GroupAuthenticityError("invalid"))
			.mockRejectedValueOnce(new Error("no sender key state for group"));

		const result = await decryptEnvelope({
			core,
			configDir: "/nonexistent",
			agentId: AGENT_ID,
			msg: groupRow("sender-key-v1"),
			retrySenderKey: true,
		});

		expect(result.verification_status).toBe("invalid");
		expect(result.plaintext).toBeUndefined();
		expect(result.decrypt_error).toBe("Sender signature verification failed");
		expect(fetchAndIngestPendingSKDistributionsMock).not.toHaveBeenCalled();
	});

	it("test_sender_key_row_when_the_key_never_arrives_then_the_error_explains_itself", async () => {
		// The scan has run and ingested nothing, so the second throw is
		// this row's final answer — and what core throws there is the control
		// string that drove the retry, not something an agent can act on. The
		// SDK reports the sentence instead, with the way out in it.
		const missingKeyId = "66666666-6666-4666-8666-666666666666";
		decryptGroupMessageMock
			.mockRejectedValueOnce(
				new Error(`${UNKNOWN_SENDER_KEY_CLAUSE}${missingKeyId}`),
			)
			.mockRejectedValueOnce(
				new Error(`${UNKNOWN_SENDER_KEY_CLAUSE}${missingKeyId}`),
			);
		fetchAndIngestPendingSKDistributionsMock.mockResolvedValueOnce(0);

		const result = await decryptEnvelope({
			core,
			configDir: "/nonexistent",
			agentId: AGENT_ID,
			msg: groupRow("sender-key-v1"),
			retrySenderKey: true,
		});

		expect(result.plaintext).toBeUndefined();
		expect(result.decrypt_error).toContain(missingKeyId);
		expect(result.decrypt_error).toContain(
			"Ask the sender to post to the group again",
		);
		expect(result.decrypt_error).toContain("This message stays sealed");
		expect(result.decrypt_error).not.toContain("unknown sender key id");
		// Still one recovery attempt, and still no throw out of the SDK.
		expect(fetchAndIngestPendingSKDistributionsMock).toHaveBeenCalledTimes(1);
	});

	it("test_sender_key_row_when_the_key_is_missing_then_the_scan_is_told_which_key_and_whose", async () => {
		// The scan can only answer a repeat miss from its negative cache if it
		// is told which key was missing and who sent it.
		const missingKeyId = "88888888-8888-4888-8888-888888888888";
		decryptGroupMessageMock.mockRejectedValueOnce(
			new Error(`${UNKNOWN_SENDER_KEY_CLAUSE}${missingKeyId}`),
		);
		fetchAndIngestPendingSKDistributionsMock.mockResolvedValueOnce(1);
		decryptGroupMessageMock.mockResolvedValueOnce({
			plaintext: "{}",
			verified: true,
			verificationStatus: "verified",
		});

		await decryptEnvelope({
			core,
			configDir: "/nonexistent",
			agentId: AGENT_ID,
			msg: groupRow("sender-key-v1"),
			retrySenderKey: true,
		});

		expect(fetchAndIngestPendingSKDistributionsMock).toHaveBeenCalledWith(
			core,
			"/nonexistent",
			AGENT_ID,
			missingKeyId,
			GROUP_ID,
			SENDER_ID,
		);
	});

	it("test_sender_key_row_when_the_negative_cache_answers_then_it_is_the_typed_final_answer", async () => {
		// A cache hit comes out of the scan as a throw. It must end in the same
		// typed code as a scan that came back empty, with no second decrypt.
		const missingKeyId = "99999999-9999-4999-8999-999999999999";
		decryptGroupMessageMock.mockRejectedValueOnce(
			new Error(`${UNKNOWN_SENDER_KEY_CLAUSE}${missingKeyId}`),
		);
		fetchAndIngestPendingSKDistributionsMock.mockRejectedValueOnce(
			new SenderKeyUnavailableError(missingKeyId, GROUP_ID),
		);

		const result = await decryptEnvelope({
			core,
			configDir: "/nonexistent",
			agentId: AGENT_ID,
			msg: groupRow("sender-key-v1"),
			retrySenderKey: true,
		});

		expect(result.plaintext).toBeUndefined();
		expect(result.decrypt_error_code).toBe(SENDER_KEY_UNAVAILABLE_CODE);
		expect(result.decrypt_error).toContain(missingKeyId);
		expect(decryptGroupMessageMock).toHaveBeenCalledTimes(1);
	});

	it("test_sender_key_row_when_the_retry_fails_otherwise_then_the_words_are_unchanged", async () => {
		// Only the missing-key failure is translated. Anything else keeps its
		// own words, because nothing here knows a truer thing to say about it.
		decryptGroupMessageMock
			.mockRejectedValueOnce(new Error("no sender key state for group"))
			.mockRejectedValueOnce(
				new Error("message key expired or already consumed"),
			);
		fetchAndIngestPendingSKDistributionsMock.mockResolvedValueOnce(1);

		const result = await decryptEnvelope({
			core,
			configDir: "/nonexistent",
			agentId: AGENT_ID,
			msg: groupRow("sender-key-v1"),
			retrySenderKey: true,
		});

		expect(result.decrypt_error).toBe(
			"message key expired or already consumed",
		);
	});

	it("test_sender_key_row_when_the_key_never_arrives_then_carries_the_typed_code", async () => {
		// The sentence is prose and free to be re-worded; a surface deciding
		// HOW to say it — in full, or as the bounded marker on a repeat — must not
		// have to match on those words. The code is the identity that survives a
		// re-wording, and it is set ONLY here, where the recovery has run and come
		// back with nothing.
		const missingKeyId = "77777777-7777-4777-8777-777777777777";
		decryptGroupMessageMock
			.mockRejectedValueOnce(
				new Error(`${UNKNOWN_SENDER_KEY_CLAUSE}${missingKeyId}`),
			)
			.mockRejectedValueOnce(
				new Error(`${UNKNOWN_SENDER_KEY_CLAUSE}${missingKeyId}`),
			);
		fetchAndIngestPendingSKDistributionsMock.mockResolvedValueOnce(0);

		const result = await decryptEnvelope({
			core,
			configDir: "/nonexistent",
			agentId: AGENT_ID,
			msg: groupRow("sender-key-v1"),
			retrySenderKey: true,
		});

		expect(result.decrypt_error_code).toBe(SENDER_KEY_UNAVAILABLE_CODE);
	});

	it("test_group_row_when_another_failure_closes_it_then_carries_no_code", async () => {
		// "No code" means "no claim about the cause", never a default one: a
		// consumer that read a missing code as this cause would offer the wrong
		// remedy for every other way a group row stays closed.
		decryptGroupMessageMock
			.mockRejectedValueOnce(new Error("no sender key state for group"))
			.mockRejectedValueOnce(
				new Error("message key expired or already consumed"),
			);
		fetchAndIngestPendingSKDistributionsMock.mockResolvedValueOnce(1);

		const result = await decryptEnvelope({
			core,
			configDir: "/nonexistent",
			agentId: AGENT_ID,
			msg: groupRow("sender-key-v1"),
			retrySenderKey: true,
		});

		expect(result.decrypt_error_code).toBeNull();
	});

	it("test_sender_key_row_with_recovery_off_then_says_it_did_not_look", async () => {
		// The escape this closes: with the recovery switched off, core's own
		// control string reached the reader as this row's reason. It is a library
		// internal AND a half-truth — this read never went looking for the
		// distribution that carries the key, so it cannot say none is coming. It
		// says exactly that much, and carries no code, because no verdict was
		// earned here.
		const missingKeyId = "88888888-8888-4888-8888-888888888888";
		decryptGroupMessageMock.mockRejectedValueOnce(
			new Error(`${UNKNOWN_SENDER_KEY_CLAUSE}${missingKeyId}`),
		);

		const result = await decryptEnvelope({
			core,
			configDir: "/nonexistent",
			agentId: AGENT_ID,
			msg: groupRow("sender-key-v1"),
			retrySenderKey: false,
		});

		expect(result.decrypt_error).not.toContain(UNKNOWN_SENDER_KEY_CLAUSE);
		expect(result.decrypt_error).toContain(missingKeyId);
		expect(result.decrypt_error).toContain("did not go looking");
		expect(result.decrypt_error_code).toBeNull();
		// It really did not look.
		expect(fetchAndIngestPendingSKDistributionsMock).not.toHaveBeenCalled();
	});

	it("test_mls_row_when_key_material_is_missing_then_still_retries", async () => {
		// The gate is narrow: a non-authenticity failure keeps the one-shot
		// recovery that makes a newly-joined member's first read work.
		decryptGroupMessageMock
			.mockRejectedValueOnce(new Error("no MLS state for group"))
			.mockResolvedValueOnce({
				plaintext: JSON.stringify({ ok: true }),
				senderKid: `rine:${SENDER_ID}`,
				verified: true,
				verificationStatus: "verified",
			});

		const result = await decryptEnvelope({
			core,
			configDir: "/nonexistent",
			agentId: AGENT_ID,
			msg: groupRow("mls-v1"),
			retrySenderKey: true,
		});

		expect(result.decrypt_error).toBeNull();
		expect(result.plaintext).toEqual({ ok: true });
		expect(processMlsWelcomesMock).toHaveBeenCalledTimes(1);
		expect(syncMlsGroupMock).toHaveBeenCalledTimes(1);
	});
});
