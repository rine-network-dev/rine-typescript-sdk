/**
 * Crypto interop suite.
 *
 * Exercises the SDK's `decryptEnvelope` orchestration layer against real
 * rine-core crypto primitives — no mocked `encryptMessage` / `decryptMessage`.
 * The only mocked boundary is the HTTP client that rine-core uses to fetch
 * the sender's signing public key during signature verification, because
 * hitting a real dev server would be out of scope for unit tests.
 *
 * Four round-trip cases plus three verification paths are covered in-memory:
 *
 *   1. DM SDK→core   — SDK `decryptEnvelope` decrypts an envelope produced
 *                      by rine-core's `encryptMessage` (the same function
 *                      the SDK's `messages.send()` calls), round-tripping
 *                      plaintext and preserving signature verification.
 *   2. DM core→SDK   — rine-core's `decryptMessage` decrypts an envelope the
 *                      SDK path produced. (The SDK delegates to
 *                      `encryptMessage` in rine-core, so "SDK encrypts" is
 *                      literally a call to rine-core — the test pins that
 *                      delegation is intact and the version tag is correct.)
 *   3. Group SDK→core — same as (1) with `encryptGroupMessage` +
 *                        `sender-key-v1`. Exercises the `decryptGroupMessage`
 *                        dispatch in `decryptEnvelope`.
 *   4. Group core→SDK — same as (2) for groups.
 *
 * Verification status matrix:
 *   - `verified: true,  status: 'verified'`     — happy-path (cases 1-4).
 *   - `verified: false, status: 'invalid'`      — sig-invalid path. For DMs
 *     the SDK passes through rine-core's return (plaintext present, verified
 *     false, status 'invalid'). For groups rine-core throws so
 *     `decryptEnvelope` populates `decrypt_error` and suppresses plaintext —
 *     documented divergence between the two paths.
 *   - `verified: false, status: 'unverifiable'` — signing key lookup fails
 *     (no sender keys on record). Plaintext is returned, verified=false.
 *
 * Additional negative paths:
 *   - HPKE ciphertext tampering → `decrypt_error` populated, plaintext undef.
 *   - Missing `encrypted_payload` field → `decrypt_error`.
 *   - `sender-key-v1` envelope without `group_id` → `decrypt_error`.
 *   - Sender-key retry path: first dispatch fails, pending distribution is
 *     ingested, second dispatch succeeds.
 *   - Unknown `encryption_version` → `decrypt_error`.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	type AgentKeys,
	type HttpClient as CoreHttpClient,
	encryptGroupMessage,
	encryptMessage,
	fromBase64Url,
	generateAgentKeys,
	generateSenderKey,
	saveAgentKeys,
	saveSenderKeyState,
	type SenderKeyState,
	signingPublicKeyToJWK,
	toBase64Url,
} from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	decryptEnvelope,
	type ParsedDecryptedMessage,
} from "./resources/decrypt.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SENDER_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const RECIPIENT_ID = "b2c3d4e5-f6a7-4901-bcde-f12345678901";
const GROUP_ID = "c3d4e5f6-a7b8-4012-cdef-123456789012";
const MSG_ID = "d4e5f6a7-b8c9-4123-defa-234567890123";
const CONV_ID = "e5f6a7b8-c9d0-4234-efab-345678901234";

type KeyStore = Map<string, AgentKeys>;

/**
 * Minimal structural stand-in for rine-core's `HttpClient`. `decryptEnvelope`
 * only ever hits `client.get(path)` (via `verifyEnvelopeSender` during
 * signature verification and via `fetchAndIngestPendingSKDistributions` during
 * the retry path), so a one-method contract is all the tests need.
 *
 * Using `Pick<CoreHttpClient, "get">` — not a hand-rolled shape or
 * `Partial<CoreHttpClient>` — means the compiler will complain if rine-core
 * ever renames `get` or changes its signature. If rine-core's crypto layer
 * starts calling `put`, `post`, etc., this type fails to satisfy
 * `CoreHttpClient` and the tests break loudly rather than silently drifting.
 */
type MockCore = Pick<CoreHttpClient, "get"> & {
	get: ReturnType<typeof vi.fn>;
};

/**
 * Duck-typed rine-core HttpClient stand-in. `verifyEnvelopeSender` only calls
 * `client.get('/agents/{id}/keys')` during decrypt, so a single `get` stub
 * driven by an in-memory keystore is sufficient.
 *
 * @param knownAgents  map of agentId → AgentKeys used to answer /keys lookups.
 *                     Agents NOT in this map trigger a rejected fetch, which
 *                     rine-core turns into `verification_status: 'unverifiable'`.
 */
function makeMockCore(knownAgents: KeyStore): MockCore {
	return {
		get: vi.fn(async (p: string) => {
			const match = p.match(/^\/agents\/([^/]+)\/keys$/);
			if (!match) throw new Error(`unexpected path: ${p}`);
			const agentId = match[1] as string;
			const keys = knownAgents.get(agentId);
			if (!keys) throw new Error(`unknown agent: ${agentId}`);
			return {
				agent_id: agentId,
				signing_public_key: signingPublicKeyToJWK(keys.signing.publicKey),
				encryption_public_key: {
					kty: "OKP",
					crv: "X25519",
					x: toBase64Url(keys.encryption.publicKey),
				},
			};
		}),
	};
}

/**
 * Narrow a `MockCore` to the `CoreHttpClient` shape `decryptEnvelope` expects.
 * The runtime value is the duck-typed `MockCore`; the cast promises that
 * `decryptEnvelope` only uses the subset we actually supply. Centralised here
 * so individual tests don't pepper call sites with `as unknown as ...` casts.
 */
function asCore(mock: MockCore): CoreHttpClient {
	return mock as unknown as CoreHttpClient;
}

/**
 * Seed the recipient's local sender-key store with the sender's state so the
 * group decrypt path can derive the message key. In the live-server path this
 * lands via `fetchAndIngestPendingSKDistributions`; in tests we prime it
 * directly because distribution-ingest has its own coverage in
 * `rine-core/test/crypto/ingest.test.ts` — these tests cover the SDK
 * orchestration layer, not the ingest wire format.
 */
function primeRecipientWithSenderState(
	dir: string,
	recipientId: string,
	groupId: string,
	state: SenderKeyState,
): void {
	saveSenderKeyState(dir, recipientId, groupId, [state]);
}

/**
 * Shape the minimum fields `decryptEnvelope` reads off the incoming message.
 * Everything else is filled in with stable placeholders so the test focuses
 * on the cryptographic result, not the envelope metadata.
 */
function wireMessage(
	encryptionVersion: "hpke-v1" | "sender-key-v1" | string,
	encryptedPayload: string | undefined,
	overrides: Partial<ParsedDecryptedMessage> = {},
): ParsedDecryptedMessage {
	return {
		id: MSG_ID,
		conversation_id: CONV_ID,
		from_agent_id: SENDER_ID,
		to_agent_id: RECIPIENT_ID,
		type: "rine.v1.task_request",
		encrypted_payload: encryptedPayload ?? "",
		encryption_version: encryptionVersion,
		sender_signing_kid: `rine:${SENDER_ID}`,
		created_at: "2026-04-11T00:00:00.000Z",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Test harness — each test gets a fresh tmpdir and fresh keys.
// ---------------------------------------------------------------------------

let configDir: string;
let senderKeys: AgentKeys;
let recipientKeys: AgentKeys;
let store: KeyStore;

beforeEach(() => {
	configDir = fs.mkdtempSync(path.join(tmpdir(), "rine-interop-"));
	senderKeys = generateAgentKeys();
	recipientKeys = generateAgentKeys();
	saveAgentKeys(configDir, SENDER_ID, senderKeys);
	saveAgentKeys(configDir, RECIPIENT_ID, recipientKeys);
	store = new Map<string, AgentKeys>([
		[SENDER_ID, senderKeys],
		[RECIPIENT_ID, recipientKeys],
	]);
});

afterEach(() => {
	fs.rmSync(configDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// DM round-trip.
// ---------------------------------------------------------------------------

describe("crypto interop — DM round-trip", () => {
	it("SDK decrypts an envelope produced by rine-core encryptMessage", async () => {
		const payload = { task: "translate", text: "hello world", n: 42 };
		const encrypted = await encryptMessage(
			configDir,
			SENDER_ID,
			recipientKeys.encryption.publicKey,
			payload,
		);

		expect(encrypted.encryption_version).toBe("hpke-v1");
		expect(encrypted.sender_signing_kid).toBe(`rine:${SENDER_ID}`);

		const mockCore = makeMockCore(store);
		const msg = wireMessage("hpke-v1", encrypted.encrypted_payload);
		const result = await decryptEnvelope({
			core: asCore(mockCore),
			configDir,
			agentId: RECIPIENT_ID,
			msg,
		});

		expect(result.decrypt_error).toBeNull();
		expect(result.verified).toBe(true);
		expect(result.verification_status).toBe("verified");
		// REQ-05: auto-parse folds the JSON plaintext into a structured
		// value when `content_type` defaults to application/json.
		expect(result.plaintext).toEqual(payload);
		// The envelope metadata must pass through unchanged.
		expect(result.id).toBe(MSG_ID);
		expect(result.conversation_id).toBe(CONV_ID);
		expect(result.encryption_version).toBe("hpke-v1");
	});

	it("round-trips Unicode + nested structures without corruption", async () => {
		// `rine-core/test/crypto/message.test.ts` covers ASCII payloads; here
		// we pin that the SDK's orchestration layer doesn't introduce any
		// UTF-8 coercion bugs around JSON → envelope → HPKE → reverse.
		const payload = {
			title: "こんにちは 🌍",
			body: ["a", "b", "c", { deeply: { nested: true, n: 0 } }],
			unicode: "Σ Δ 𓂀 – ‰ €",
		};
		const encrypted = await encryptMessage(
			configDir,
			SENDER_ID,
			recipientKeys.encryption.publicKey,
			payload,
		);

		const result = await decryptEnvelope({
			core: asCore(makeMockCore(store)),
			configDir,
			agentId: RECIPIENT_ID,
			msg: wireMessage("hpke-v1", encrypted.encrypted_payload),
		});

		expect(result.decrypt_error).toBeNull();
		expect(result.plaintext).toEqual(payload);
	});
});

// ---------------------------------------------------------------------------
// Group round-trip.
// ---------------------------------------------------------------------------

describe("crypto interop — group round-trip", () => {
	it("SDK decrypts a sender-key envelope produced by rine-core encryptGroupMessage", async () => {
		const state = generateSenderKey(GROUP_ID, SENDER_ID);
		primeRecipientWithSenderState(configDir, RECIPIENT_ID, GROUP_ID, state);

		const payload = { announcement: "meeting at 3pm", attendees: 4 };
		const { result: encrypted } = await encryptGroupMessage(
			configDir,
			SENDER_ID,
			GROUP_ID,
			state,
			payload,
		);

		expect(encrypted.encryption_version).toBe("sender-key-v1");

		const msg = wireMessage("sender-key-v1", encrypted.encrypted_payload, {
			group_id: GROUP_ID,
		});
		const result = await decryptEnvelope({
			core: asCore(makeMockCore(store)),
			configDir,
			agentId: RECIPIENT_ID,
			msg,
		});

		expect(result.decrypt_error).toBeNull();
		expect(result.verified).toBe(true);
		expect(result.verification_status).toBe("verified");
		expect(result.plaintext).toEqual(payload);
	});

	it("the sender can decrypt its own group message (self-read key)", async () => {
		// This is one of the trickier rine-core behaviors — `encryptGroupMessage`
		// caches the pre-advance message key under `skippedKeys[messageIndex]`
		// before `sealGroup` consumes the chain key, so the sender can re-read
		// their own envelope without having kept the pre-sealed state. The SDK's
		// orchestration must not interfere with that cache.
		const initialState = generateSenderKey(GROUP_ID, SENDER_ID);
		const payload = { self: "read" };

		const { result: encrypted } = await encryptGroupMessage(
			configDir,
			SENDER_ID,
			GROUP_ID,
			initialState,
			payload,
		);

		const msg = wireMessage("sender-key-v1", encrypted.encrypted_payload, {
			group_id: GROUP_ID,
		});
		const result = await decryptEnvelope({
			core: asCore(makeMockCore(store)),
			configDir,
			agentId: SENDER_ID,
			msg,
		});

		expect(result.decrypt_error).toBeNull();
		expect(result.verified).toBe(true);
		expect(result.plaintext).toEqual(payload);
	});
});

// ---------------------------------------------------------------------------
// Verification status matrix (verified / invalid / unverifiable).
// ---------------------------------------------------------------------------

describe("crypto interop — verification status matrix", () => {
	it("verified path: DM with matching sender key returns verified=true", async () => {
		// Restated here as the pinned "known-good" baseline against which the
		// invalid and unverifiable cases below are measured. Without this a
		// future refactor could regress all three paths to the same state and
		// the matrix would still appear internally consistent.
		const payload = { ok: true };
		const encrypted = await encryptMessage(
			configDir,
			SENDER_ID,
			recipientKeys.encryption.publicKey,
			payload,
		);

		const result = await decryptEnvelope({
			core: asCore(makeMockCore(store)),
			configDir,
			agentId: RECIPIENT_ID,
			msg: wireMessage("hpke-v1", encrypted.encrypted_payload),
		});

		expect(result.verified).toBe(true);
		expect(result.verification_status).toBe("verified");
		expect(result.decrypt_error).toBeNull();
	});

	it("invalid path (DM): sender key server returns a foreign signing key", async () => {
		// The message was signed by `senderKeys.signing`, but the signing key
		// fetched during verify points to a different agent. rine-core's
		// `decryptMessage` returns plaintext with `verified: false` in this
		// case (the ciphertext was still addressed to the recipient), and
		// `decryptEnvelope` passes that through — the caller branches on
		// `result.verified`, not on the presence of plaintext.
		const payload = { msg: "spoofed" };
		const encrypted = await encryptMessage(
			configDir,
			SENDER_ID,
			recipientKeys.encryption.publicKey,
			payload,
		);

		const imposterKeys = generateAgentKeys();
		const badStore: KeyStore = new Map([[SENDER_ID, imposterKeys]]);

		const result = await decryptEnvelope({
			core: asCore(makeMockCore(badStore)),
			configDir,
			agentId: RECIPIENT_ID,
			msg: wireMessage("hpke-v1", encrypted.encrypted_payload),
		});

		expect(result.decrypt_error).toBeNull();
		expect(result.verified).toBe(false);
		expect(result.verification_status).toBe("invalid");
		// Plaintext still returned — callers must check `verified` before trust.
		expect(result.plaintext).toEqual(payload);
	});

	it("invalid path (group): rine-core throws, SDK surfaces decrypt_error", async () => {
		// Divergence vs the DM path: `decryptGroupMessage` refuses to advance
		// the ratchet on an invalid signature and throws, which
		// `decryptEnvelope` catches and turns into `decrypt_error`. Plaintext
		// is suppressed because the recipient's ratchet state was not advanced
		// and the derived key was zeroed.
		const state = generateSenderKey(GROUP_ID, SENDER_ID);
		primeRecipientWithSenderState(configDir, RECIPIENT_ID, GROUP_ID, state);

		const payload = { sensitive: "data" };
		const { result: encrypted } = await encryptGroupMessage(
			configDir,
			SENDER_ID,
			GROUP_ID,
			state,
			payload,
		);

		const imposterKeys = generateAgentKeys();
		const badStore: KeyStore = new Map([[SENDER_ID, imposterKeys]]);

		const msg = wireMessage("sender-key-v1", encrypted.encrypted_payload, {
			group_id: GROUP_ID,
		});
		const result = await decryptEnvelope({
			core: asCore(makeMockCore(badStore)),
			configDir,
			agentId: RECIPIENT_ID,
			msg,
		});

		expect(result.decrypt_error).toContain(
			"Sender signature verification failed",
		);
		expect(result.plaintext).toBeUndefined();
		expect(result.verified).toBe(false);
		// Group sig-failure maps to `invalid` (not `unverifiable`) per the
		// `classifyGroupError` branch in `decrypt.ts` — callers can
		// distinguish "bad sender" from "missing key material" on the group
		// path.
		expect(result.verification_status).toBe("invalid");
	});

	it("unverifiable path: sender not in key cache returns plaintext + verified=false", async () => {
		// `verifyEnvelopeSender` catches the key-fetch rejection and falls
		// through to `verified: false, verificationStatus: 'unverifiable'`.
		// Plaintext is still returned because the HPKE layer succeeded.
		const payload = { msg: "unknown sender" };
		const encrypted = await encryptMessage(
			configDir,
			SENDER_ID,
			recipientKeys.encryption.publicKey,
			payload,
		);

		const emptyStore: KeyStore = new Map();
		const result = await decryptEnvelope({
			core: asCore(makeMockCore(emptyStore)),
			configDir,
			agentId: RECIPIENT_ID,
			msg: wireMessage("hpke-v1", encrypted.encrypted_payload),
		});

		expect(result.decrypt_error).toBeNull();
		expect(result.verified).toBe(false);
		expect(result.verification_status).toBe("unverifiable");
		expect(result.plaintext).toEqual(payload);
	});
});

// ---------------------------------------------------------------------------
// Negative paths — tampering and envelope hygiene.
// ---------------------------------------------------------------------------

describe("crypto interop — negative paths", () => {
	it("tampered HPKE ciphertext produces decrypt_error without plaintext", async () => {
		const encrypted = await encryptMessage(
			configDir,
			SENDER_ID,
			recipientKeys.encryption.publicKey,
			{ payload: "original" },
		);

		// Flip one byte in the middle of the encoded envelope. HPKE's AEAD tag
		// covers the entire ciphertext, so any mutation surfaces as an open()
		// failure that `decryptEnvelope` turns into a decrypt_error.
		const raw = fromBase64Url(encrypted.encrypted_payload);
		const flipIdx = Math.floor(raw.length / 2);
		raw[flipIdx] = (raw[flipIdx] ?? 0) ^ 0x01;
		const tamperedB64 = toBase64Url(raw);

		const result = await decryptEnvelope({
			core: asCore(makeMockCore(store)),
			configDir,
			agentId: RECIPIENT_ID,
			msg: wireMessage("hpke-v1", tamperedB64),
		});

		expect(result.decrypt_error).not.toBeNull();
		expect(typeof result.decrypt_error).toBe("string");
		expect(result.plaintext).toBeUndefined();
		expect(result.verified).toBe(false);
		expect(result.verification_status).toBe("unverifiable");
	});

	// `missing encrypted_payload` and `unknown encryption_version` guard-clause
	// tests live in `resources-smoke.test.ts` instead — they short-circuit
	// before any real crypto fires, so they belong with the other decrypt
	// dispatch smoke tests. This file stays focused on paths that actually
	// exercise rine-core crypto primitives.

	it("sender-key envelope missing group_id is rejected without calling core", async () => {
		// Covered here (not in the smoke test) because the guard sits between
		// `encryption_version === 'sender-key-v1'` dispatch and the rine-core
		// `decryptGroupMessage` call — asserting `core.get` was never touched
		// is the only way to prove the short-circuit fires before dispatch.
		const core = makeMockCore(store);
		const result = await decryptEnvelope({
			core: asCore(core),
			configDir,
			agentId: RECIPIENT_ID,
			msg: wireMessage("sender-key-v1", "irrelevant", { group_id: null }),
		});

		expect(result.decrypt_error).toBe("sender-key message missing group_id");
		expect(result.plaintext).toBeUndefined();
		expect(core.get).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Cancellation — `decryptEnvelope` re-throws `AbortError` so a cancelled
// `inbox()` / `read()` rejects cleanly instead of resolving with a page of
// fake "failed" items. Without this contract, `rethrowIfAbort` inside
// `decrypt.ts` would be silently dead code.
// ---------------------------------------------------------------------------

describe("crypto interop — AbortError propagation", () => {
	it("group retry path: AbortError from the ingest fetch rejects the promise", async () => {
		// Setup a valid envelope but leave the recipient's store empty so
		// the first `decryptGroupMessage` call fails with "sender key state
		// not found", forcing `decryptEnvelope` into its retry branch. The
		// mock's `get` then throws `AbortError` when the retry calls
		// `fetchAndIngestPendingSKDistributions`. The contract: that abort
		// must propagate as a rejection, NOT be caught and turned into a
		// `decrypt_error` field on a resolved message.
		const state = generateSenderKey(GROUP_ID, SENDER_ID);
		const { result: encrypted } = await encryptGroupMessage(
			configDir,
			SENDER_ID,
			GROUP_ID,
			state,
			{ cancel: "mid-ingest" },
		);

		const abortErr = new Error("The operation was aborted");
		abortErr.name = "AbortError";
		const core: MockCore = {
			get: vi.fn(async (p: string) => {
				if (p === `/agents/${RECIPIENT_ID}/messages`) throw abortErr;
				throw new Error(`unexpected path: ${p}`);
			}),
		};

		const msg = wireMessage("sender-key-v1", encrypted.encrypted_payload, {
			group_id: GROUP_ID,
		});

		await expect(
			decryptEnvelope({
				core: asCore(core),
				configDir,
				agentId: RECIPIENT_ID,
				msg,
				retrySenderKey: true,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});

// ---------------------------------------------------------------------------
// Sender-key retry path — `read()` re-fetches pending distributions once
// before giving up.
// ---------------------------------------------------------------------------

describe("crypto interop — sender-key retry", () => {
	it("falls back to fetchAndIngestPendingSKDistributions on first failure", async () => {
		// Build a valid sender-key envelope, but DON'T prime the recipient
		// store yet — so the first `decryptGroupMessage` throws
		// ("sender key state not found"). Between retries, a `get` stub
		// simulates the server returning a pending distribution that, when
		// ingested, populates the recipient's store and lets the second
		// attempt succeed.
		const state = generateSenderKey(GROUP_ID, SENDER_ID);
		const payload = { retry: "ok" };
		const { result: encrypted } = await encryptGroupMessage(
			configDir,
			SENDER_ID,
			GROUP_ID,
			state,
			payload,
		);

		// `fetchAndIngestPendingSKDistributions` hits
		// `GET /agents/{id}/messages?type=rine.v1.sender_key_distribution`
		// and iterates the returned `items`. We short-circuit that by
		// side-effecting the recipient's local sender-key store inside the
		// mock and returning an empty page — the test asserts the retry
		// *plumbing*, not the on-wire distribution format (which has its own
		// coverage in `rine-core/test/crypto/ingest.test.ts`).
		//
		// After this fake ingest, the second `decryptGroupMessage` dispatch
		// sees the primed state and succeeds. The first attempt runs before
		// the mock fires, so it fails with "sender key state not found".
		let ingestFired = false;
		const core = makeMockCore(store);
		const originalGet = core.get.getMockImplementation();
		core.get.mockImplementation(async (p: string) => {
			if (p === `/agents/${RECIPIENT_ID}/messages`) {
				saveSenderKeyState(configDir, RECIPIENT_ID, GROUP_ID, [state]);
				ingestFired = true;
				return { items: [], total: 0 };
			}
			if (!originalGet) throw new Error("no fallback implementation");
			return originalGet(p);
		});

		const msg = wireMessage("sender-key-v1", encrypted.encrypted_payload, {
			group_id: GROUP_ID,
		});
		const result = await decryptEnvelope({
			core: asCore(core),
			configDir,
			agentId: RECIPIENT_ID,
			msg,
			retrySenderKey: true,
		});

		expect(ingestFired).toBe(true);
		expect(result.decrypt_error).toBeNull();
		expect(result.verified).toBe(true);
		expect(result.plaintext).toEqual(payload);
	});

	it("without retrySenderKey=true the first failure is surfaced directly", async () => {
		// Same setup as above but `retrySenderKey` is left at its default
		// (false). `inbox()` uses the default path because per-item retries
		// would fan out into a storm — only `read()` opts into retry.
		const state = generateSenderKey(GROUP_ID, SENDER_ID);
		const payload = { retry: "off" };
		const { result: encrypted } = await encryptGroupMessage(
			configDir,
			SENDER_ID,
			GROUP_ID,
			state,
			payload,
		);

		const core = makeMockCore(store);
		const msg = wireMessage("sender-key-v1", encrypted.encrypted_payload, {
			group_id: GROUP_ID,
		});
		const result = await decryptEnvelope({
			core: asCore(core),
			configDir,
			agentId: RECIPIENT_ID,
			msg,
		});

		expect(result.decrypt_error).not.toBeNull();
		expect(result.plaintext).toBeUndefined();
	});
});
