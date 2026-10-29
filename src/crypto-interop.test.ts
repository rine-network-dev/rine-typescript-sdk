/**
 * Crypto interop suite.
 *
 * Exercises the SDK's `decryptEnvelope` orchestration layer against real
 * rine-core crypto primitives — no mocked `encryptMessage` / `decryptMessage`.
 * The only mocked boundary is the HTTP client that rine-core uses to fetch
 * the sender's signing public key during signature verification, because
 * hitting a real dev server would be out of scope for unit tests.
 *
 * The agents are real derived agents of a custody fixture: `seedAgent` writes
 * their generation-0 leaf keys under the runtime config dir and `publishedKeys`
 * is what the server answers for them, so the signature scope ids are canonical
 * UUIDs and the keys an envelope is sealed to are the keys the derivation tree
 * really holds.
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
 *   - `verified: false, status: 'invalid'` and `status: 'sender-mismatch'` —
 *     the two authenticity failures. Both are refused identically on the DM and
 *     the group path: `decrypt_error` is populated and no plaintext comes back.
 *   - `verified: false, status: 'unverifiable'` — signing key lookup fails
 *     (no sender keys on record). Plaintext is returned, verified=false: the
 *     verdict is missing rather than adverse, so content is not withheld.
 *
 * Additional negative paths:
 *   - HPKE ciphertext tampering → `decrypt_error` populated, plaintext undef.
 *   - Missing `encrypted_payload` field → `decrypt_error`.
 *   - `sender-key-v1` envelope without `group_id` → `decrypt_error`.
 *   - Sender-key retry path: first dispatch fails, pending distribution is
 *     ingested, second dispatch succeeds.
 *   - Repeat decrypt of one group row: rine-core's on-disk read cache replays
 *     it across processes, the `GroupDecryptMemo` replays it in-process, and
 *     the bare ratchet — with the cache taken away — still refuses it; 1:1 rows
 *     are never memoized.
 *   - Unknown `encryption_version` → `decrypt_error`.
 */

import {
  type AgentKeysResponse,
  type HttpClient as CoreHttpClient,
  type SenderKeyState,
  deleteGroupReadCache,
  encryptGroupMessage,
  encryptMessage,
  fromBase64Url,
  generateSenderKey,
  jwkToPqPublicKey,
  jwkToPublicKey,
  loadSenderKeyStates,
  saveSenderKeyState,
  toBase64Url,
} from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ParsedDecryptedMessage,
  decryptEnvelope,
} from "./resources/decrypt.js";
import {
  type CustodyFixture,
  makeCustodyFixture,
  publishedKeys,
  seedAgent,
} from "@rine-network/core/testing";
import { GroupDecryptMemo } from "./utils/decrypt-memo.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SENDER_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const RECIPIENT_ID = "b2c3d4e5-f6a7-4901-bcde-f12345678901";
const GROUP_ID = "c3d4e5f6-a7b8-4012-cdef-123456789012";
const MSG_ID = "d4e5f6a7-b8c9-4123-defa-234567890123";
const CONV_ID = "e5f6a7b8-c9d0-4234-efab-345678901234";
/** A peer that re-seals another agent's signed envelope and posts it as its own. */
const RESEALER_ID = "f6a7b8c9-d0e1-4345-fabc-456789012345";

/** The recipient key material `encryptMessage` seals to, from the published chain. */
function recipientKeysFor(agentId: string): {
  encryption: Uint8Array;
  pqEncryption: Uint8Array;
} {
  const keys = publishedKeys(agentId);
  return {
    encryption: jwkToPublicKey(keys.encryption_public_key),
    pqEncryption: jwkToPqPublicKey(keys.pq_encryption_public_key),
  };
}

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
 * driven by the fixture's published key chain is sufficient.
 *
 * @param knownAgents  agent ids the server has keys for. Agents NOT in this set
 *                     trigger a rejected fetch, which rine-core turns into
 *                     `verification_status: 'unverifiable'`.
 * @param publishedSigning  overrides the signing key an agent publishes, so a
 *                     row can be signed by one key and checked against another
 *                     — what a recipient sees when the signature does not check
 *                     out.
 */
function makeMockCore(
  knownAgents: ReadonlySet<string> = new Set([SENDER_ID, RECIPIENT_ID]),
  publishedSigning: ReadonlyMap<
    string,
    AgentKeysResponse["signing_public_key"]
  > = new Map(),
): MockCore {
  return {
    get: vi.fn(async (p: string) => {
      const match = p.match(/^\/agents\/([^/]+)\/keys$/);
      if (!match) throw new Error(`unexpected path: ${p}`);
      const agentId = match[1] as string;
      if (!knownAgents.has(agentId)) throw new Error(`unknown agent: ${agentId}`);
      const body = publishedKeys(agentId);
      const signing = publishedSigning.get(agentId);
      return signing ? { ...body, signing_public_key: signing } : body;
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
  encryptionVersion: string,
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
// Test harness — each test gets a fresh custody fixture with derived keys.
// ---------------------------------------------------------------------------

let fx: CustodyFixture;
let configDir: string;

beforeEach(() => {
  fx = makeCustodyFixture();
  seedAgent(fx, SENDER_ID);
  seedAgent(fx, RECIPIENT_ID);
  configDir = fx.dirs.configDir;
});

afterEach(() => {
  fx.cleanup();
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
      RECIPIENT_ID,
      recipientKeysFor(RECIPIENT_ID),
      payload,
    );

    expect(encrypted.encryption_version).toBe("hpke-hybrid-v2");
    expect(encrypted.sender_signing_kid).toBe(`rine:${SENDER_ID}#0`);

    const mockCore = makeMockCore();
    const msg = wireMessage("hpke-hybrid-v2", encrypted.encrypted_payload);
    const result = await decryptEnvelope({
      core: asCore(mockCore),
      configDir,
      agentId: RECIPIENT_ID,
      msg,
    });

    expect(result.decrypt_error).toBeNull();
    expect(result.verified).toBe(true);
    expect(result.verification_status).toBe("verified");
    // Auto-parse folds the JSON plaintext into a structured
    // value when `content_type` defaults to application/json.
    expect(result.plaintext).toEqual(payload);
    // The envelope metadata must pass through unchanged.
    expect(result.id).toBe(MSG_ID);
    expect(result.conversation_id).toBe(CONV_ID);
    expect(result.encryption_version).toBe("hpke-hybrid-v2");
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
      RECIPIENT_ID,
      recipientKeysFor(RECIPIENT_ID),
      payload,
    );

    const result = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg: wireMessage("hpke-hybrid-v2", encrypted.encrypted_payload),
    });

    expect(result.decrypt_error).toBeNull();
    expect(result.plaintext).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// PQ hybrid DM round-trip.
//
// Two audits found 8 bugs in the hybrid read/decrypt path that escaped because
// no test ever drove an `hpke-hybrid-v2` envelope through `decryptEnvelope`.
// The headline failure: `decrypt.ts`'s version dispatch only matched a retired
// version string, so every hybrid envelope fell through to the
// "unknown encryption_version" branch and came back with a `decrypt_error` and
// NO plaintext. These tests drive a *real* hybrid envelope (produced by
// `encryptMessage` with the recipient's ML-KEM-768 public key) through the
// real `decryptEnvelope` and assert the plaintext is recovered and verified.
//
// Dispatching only on a retired version string makes the first test fail:
// `decrypt_error` becomes the unknown-version string and `plaintext` becomes
// undefined.
// ---------------------------------------------------------------------------

describe("crypto interop — PQ hybrid DM round-trip", () => {
  it("SDK decrypts an hpke-hybrid-v2 envelope and recovers the plaintext", async () => {
    const payload = { task: "translate", text: "quantum-safe", n: 7 };

    // Hybrid seal: the recipient's PQ public key drives the ML-KEM-768 half of
    // the `hpke-hybrid-v2` envelope.
    const encrypted = await encryptMessage(
      configDir,
      SENDER_ID,
      RECIPIENT_ID,
      recipientKeysFor(RECIPIENT_ID),
      payload,
    );
    expect(encrypted.encryption_version).toBe("hpke-hybrid-v2");

    const msg = wireMessage("hpke-hybrid-v2", encrypted.encrypted_payload);
    const result = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg,
    });

    // Dispatching only on a retired version string makes `decrypt_error` the
    // unknown-version string and `plaintext` undefined — both assertions below
    // fail.
    expect(result.decrypt_error).toBeNull();
    expect(result.plaintext).toEqual(payload);
    expect(result.verified).toBe(true);
    expect(result.verification_status).toBe("verified");
    expect(result.encryption_version).toBe("hpke-hybrid-v2");
  });

  it("dispatches an hpke-hybrid-v2 tag to the crypto open path, not the unknown-version branch", async () => {
    // This test isolates the dispatch *decision* rather than asserting on a
    // constant. A guard that matched only a retired version string would send a
    // `hpke-hybrid-v2` tag to the unknown-version branch and come back with
    // `decrypt_error: "unknown encryption_version: hpke-hybrid-v2"` —
    // `decryptMessage` was never reached.
    //
    // To prove the dispatch genuinely reaches `decryptMessage` and tries to OPEN
    // the bytes (rather than short-circuiting on the version string), we feed it
    // a *real* hybrid ciphertext with one byte of the AEAD body flipped so the
    // open fails. The result must be a CRYPTO error, never the unknown-version
    // string.
    const encrypted = await encryptMessage(
      configDir,
      SENDER_ID,
      RECIPIENT_ID,
      recipientKeysFor(RECIPIENT_ID),
      { secret: "pq" },
    );
    expect(encrypted.encryption_version).toBe("hpke-hybrid-v2");

    // Flip a byte in the AEAD body (NOT byte 0 — the version prefix must
    // survive so the hybrid `open()` arm is selected inside `decryptMessage`).
    // The tag-covered ciphertext then fails to open.
    const raw = fromBase64Url(encrypted.encrypted_payload);
    const flipIdx = raw.length - 1;
    raw[flipIdx] = (raw[flipIdx] ?? 0) ^ 0x01;
    const tamperedB64 = toBase64Url(raw);

    const result = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      // Tag it `hpke-hybrid-v2` — the dispatch decision under test.
      msg: wireMessage("hpke-hybrid-v2", tamperedB64),
    });

    // A non-null crypto error means dispatch reached `decryptMessage`.
    expect(result.decrypt_error).not.toBeNull();
    // Crucially NOT the unknown-version short-circuit.
    expect(result.decrypt_error).not.toContain("unknown encryption_version");
    expect(result.plaintext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Group round-trip.
// ---------------------------------------------------------------------------

describe("crypto interop — group round-trip", () => {
  it("SDK decrypts a sender-key envelope produced by rine-core encryptGroupMessage", async () => {
    const state = generateSenderKey(GROUP_ID, SENDER_ID);
    // The sender's own copy, which `encryptGroupMessage` advances in place. A
    // stand-in sender needs it as much as a real one does: the tail refuses a
    // state that is on no disk at all rather than discarding the advance. In
    // production `getOrCreateSenderKey` has already written it.
    saveSenderKeyState(configDir, SENDER_ID, GROUP_ID, [state]);
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
      core: asCore(makeMockCore()),
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
    saveSenderKeyState(configDir, SENDER_ID, GROUP_ID, [initialState]);
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
      core: asCore(makeMockCore()),
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
// Repeat decrypt of a peer's group row — the TS half of the defect.
//
// A group ratchet step is single-use: `openGroup` derives the key for
// `messageIndex`, advances the chain, does not retain the consumed key, and
// the advanced state is persisted. So the SECOND decrypt of the same row lands
// in the `messageIndex < state.messageIndex` branch with an empty skipped-key
// cache. Every SDK receive surface can see one row twice (`inbox()` re-poll,
// `read()` after `inbox()`, `thread()` over a group conversation), which is why
// `decryptEnvelope` memoizes group results.
//
// Two things now answer a repeat read, and they are not the same thing. The
// `GroupDecryptMemo` is in-process and dies with the client. rine-core's read
// cache is on disk, so it also answers the CLI, which is a fresh process per
// invocation — the case the memo could never reach, and the one an operator
// meets when re-reading an inbox entry.
// ---------------------------------------------------------------------------

describe("crypto interop — repeat group decrypt", () => {
  /** Seed the recipient and produce one sender-key envelope from the peer. */
  async function groupEnvelope(
    payload: unknown,
  ): Promise<ParsedDecryptedMessage> {
    const state = generateSenderKey(GROUP_ID, SENDER_ID);
    saveSenderKeyState(configDir, SENDER_ID, GROUP_ID, [state]);
    primeRecipientWithSenderState(configDir, RECIPIENT_ID, GROUP_ID, state);
    const { result } = await encryptGroupMessage(
      configDir,
      SENDER_ID,
      GROUP_ID,
      state,
      payload,
    );
    return wireMessage("sender-key-v1", result.encrypted_payload, {
      group_id: GROUP_ID,
    });
  }

  it("without a memo the read cache still replays the second decrypt", async () => {
    // No memo and no shared client: this is the CLI's shape, a fresh process
    // per read. It used to answer "message key expired or already consumed" —
    // an error about a key that is simply gone — and now answers the message.
    const payload = { announcement: "once only" };
    const msg = await groupEnvelope(payload);

    const first = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg,
    });
    const second = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg,
    });

    expect(first.decrypt_error).toBeNull();
    expect(second.decrypt_error).toBeNull();
    expect(second.plaintext).toEqual(payload);
  });

  it("with the read cache taken away the ratchet refuses it, exactly as before", async () => {
    // The control arm, and the thing that makes the test above mean something:
    // one variable changes — the cache file — and the same row, the same config
    // dir and the same sender-key state are asked again. It also still pins the
    // underlying rine-core semantics, which have not changed: the ratchet step
    // is spent and the plaintext is kept beside it, not derived again.
    const msg = await groupEnvelope({ announcement: "once only" });

    await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg,
    });
    deleteGroupReadCache(configDir, RECIPIENT_ID, GROUP_ID);
    const second = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg,
    });

    expect(second.decrypt_error).toBe(
      "message key expired or already consumed",
    );
    expect(second.plaintext).toBeUndefined();
  });

  it("with a memo the second decrypt returns the same plaintext", async () => {
    const payload = { announcement: "meeting at 3pm", attendees: 4 };
    const msg = await groupEnvelope(payload);
    const memo = new GroupDecryptMemo();

    const first = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg,
      retrySenderKey: true,
      memo,
    });
    const second = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg,
      retrySenderKey: true,
      memo,
    });

    expect(first.plaintext).toEqual(payload);
    expect(second.decrypt_error).toBeNull();
    expect(second.plaintext).toEqual(payload);
    // Verification metadata replays too — a memoized read is not a
    // downgraded read.
    expect(second.verified).toBe(true);
    expect(second.verification_status).toBe("verified");
  });

  it("replays the memo for an honest repeat read whose sender id differs only in case", async () => {
    // The regression guard on how the replay is bound. Agent ids are
    // server-issued UUIDs and the sender comparison normalises them, so the same
    // row served again under an upper-cased id is the SAME honest read: it must
    // still replay. Binding the memo by key instead of by comparison would miss
    // here, land on the spent ratchet, and bring back the read-once bug.
    const payload = { announcement: "meeting at 3pm", attendees: 4 };
    const msg = await groupEnvelope(payload);
    const memo = new GroupDecryptMemo();

    await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg,
      retrySenderKey: true,
      memo,
    });
    const second = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg: { ...msg, from_agent_id: SENDER_ID.toUpperCase() },
      retrySenderKey: true,
      memo,
    });

    expect(second.decrypt_error).toBeNull();
    expect(second.plaintext).toEqual(payload);
    expect(second.verified).toBe(true);
    expect(second.verification_status).toBe("verified");
  });

  it("refuses a memoized row re-served under a different sender", async () => {
    // The memo holds what the bytes said; who sent them is decided per read. A
    // server (or an on-path attacker) that re-serves an already-opened row under
    // another sender must not get the first read's verdict back — and the
    // refusal must be the honest `sender-mismatch`, not the spent-ratchet error
    // the bare chain would have produced.
    const payload = { announcement: "meeting at 3pm", attendees: 4 };
    const msg = await groupEnvelope(payload);
    const memo = new GroupDecryptMemo();

    const first = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg,
      retrySenderKey: true,
      memo,
    });
    const second = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg: { ...msg, from_agent_id: RESEALER_ID },
      retrySenderKey: true,
      memo,
    });

    expect(first.plaintext).toEqual(payload);
    expect(second.plaintext).toBeUndefined();
    expect(second.verified).toBe(false);
    expect(second.verification_status).toBe("sender-mismatch");
    expect(second.decrypt_error).toBe(
      "Envelope sender does not match the message sender",
    );
  });

  it("never memoizes a 1:1 row, whose decrypt is already repeatable", async () => {
    // DM plaintext must not be retained: the recipient's private key does
    // not change, so re-decrypting costs nothing and caching would only
    // widen plaintext retention.
    const memo = new GroupDecryptMemo();
    const encrypted = await encryptMessage(
      configDir,
      SENDER_ID,
      RECIPIENT_ID,
      recipientKeysFor(RECIPIENT_ID),
      { dm: "hello" },
    );

    const result = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg: wireMessage("hpke-hybrid-v2", encrypted.encrypted_payload),
      memo,
    });

    expect(result.plaintext).toEqual({ dm: "hello" });
    expect(memo.size).toBe(0);
  });

  it("is keyed per reading agent and evicts oldest-first", async () => {
    const memo = new GroupDecryptMemo(2);
    const result = {
      plaintext: '{"n":1}',
      senderKid: `rine:${SENDER_ID}`,
      verified: true,
      verificationStatus: "verified" as const,
    };

    // Two agents in one process (a multi-agent org) must never be served
    // each other's plaintext for the same message id.
    memo.set(RECIPIENT_ID, MSG_ID, result);
    expect(memo.get(SENDER_ID, MSG_ID)).toBeUndefined();
    expect(memo.get(RECIPIENT_ID, MSG_ID)).toBe(result);
  });

  it("evicts oldest-first so the memo cannot grow without bound", async () => {
    const memo = new GroupDecryptMemo(2);
    const result = {
      plaintext: '{"n":1}',
      senderKid: `rine:${SENDER_ID}`,
      verified: true,
      verificationStatus: "verified" as const,
    };
    memo.set(RECIPIENT_ID, "msg-1", result);
    memo.set(RECIPIENT_ID, "msg-2", result);
    memo.set(RECIPIENT_ID, "msg-3", result);

    expect(memo.size).toBe(2);
    expect(memo.get(RECIPIENT_ID, "msg-1")).toBeUndefined();
    expect(memo.get(RECIPIENT_ID, "msg-3")).toBe(result);

    memo.clear();
    expect(memo.size).toBe(0);
  });

  it("refreshes recency on a hit (true LRU), matching the Python SDK", async () => {
    // Under FIFO the oldest-INSERTED entry is evicted regardless of reads,
    // so a re-read row would still be dropped and the memo would surface the
    // "message key expired or already consumed" error at a different point
    // than the Python SDK for an identical workload. True LRU keeps a
    // recently re-read row alive. This test fails under FIFO get().
    const memo = new GroupDecryptMemo(2);
    const result = {
      plaintext: '{"n":1}',
      senderKid: `rine:${SENDER_ID}`,
      verified: true,
      verificationStatus: "verified" as const,
    };

    memo.set(RECIPIENT_ID, "msg-1", result);
    memo.set(RECIPIENT_ID, "msg-2", result);
    // Re-read the oldest-inserted row: recency must move it to newest.
    expect(memo.get(RECIPIENT_ID, "msg-1")).toBe(result);
    // Inserting a third entry now evicts msg-2 (least recently USED),
    // not msg-1 (least recently INSERTED).
    memo.set(RECIPIENT_ID, "msg-3", result);

    expect(memo.size).toBe(2);
    expect(memo.get(RECIPIENT_ID, "msg-1")).toBe(result);
    expect(memo.get(RECIPIENT_ID, "msg-2")).toBeUndefined();
    expect(memo.get(RECIPIENT_ID, "msg-3")).toBe(result);
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
      RECIPIENT_ID,
      recipientKeysFor(RECIPIENT_ID),
      payload,
    );

    const result = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg: wireMessage("hpke-hybrid-v2", encrypted.encrypted_payload),
    });

    expect(result.verified).toBe(true);
    expect(result.verification_status).toBe("verified");
    expect(result.decrypt_error).toBeNull();
    // The honest row is untouched by the refusal rules below: it still carries
    // its content, so a suite that refuses everything cannot read as green.
    expect(result.plaintext).toEqual(payload);
  });

  it("invalid path (DM): sender key server returns a foreign signing key", async () => {
    // The message was signed by the sender's derived signing key, but the
    // signing key fetched during verify points to a different agent. Bytes whose
    // signature does not check out are refused on the 1:1 path exactly as they
    // are in a group: no plaintext, and a `decrypt_error` naming the failure.
    const payload = { msg: "spoofed" };
    const encrypted = await encryptMessage(
      configDir,
      SENDER_ID,
      RECIPIENT_ID,
      recipientKeysFor(RECIPIENT_ID),
      payload,
    );

    const badStore = makeMockCore(
      new Set([SENDER_ID]),
      new Map([[SENDER_ID, publishedKeys(RESEALER_ID).signing_public_key]]),
    );

    const result = await decryptEnvelope({
      core: asCore(badStore),
      configDir,
      agentId: RECIPIENT_ID,
      msg: wireMessage("hpke-hybrid-v2", encrypted.encrypted_payload),
    });

    expect(result.verified).toBe(false);
    expect(result.verification_status).toBe("invalid");
    expect(result.plaintext).toBeUndefined();
    expect(result.decrypt_error).toContain(
      "Sender signature verification failed",
    );
  });

  it("invalid path (group): rine-core throws, SDK surfaces decrypt_error", async () => {
    // Divergence vs the DM path: `decryptGroupMessage` refuses to advance
    // the ratchet on an invalid signature and throws, which
    // `decryptEnvelope` catches and turns into `decrypt_error`. Plaintext
    // is suppressed because the recipient's ratchet state was not advanced
    // and the derived key was zeroed.
    const state = generateSenderKey(GROUP_ID, SENDER_ID);
    saveSenderKeyState(configDir, SENDER_ID, GROUP_ID, [state]);
    primeRecipientWithSenderState(configDir, RECIPIENT_ID, GROUP_ID, state);

    const payload = { sensitive: "data" };
    const { result: encrypted } = await encryptGroupMessage(
      configDir,
      SENDER_ID,
      GROUP_ID,
      state,
      payload,
    );

    const badStore = makeMockCore(
      new Set([SENDER_ID]),
      new Map([[SENDER_ID, publishedKeys(RESEALER_ID).signing_public_key]]),
    );

    const msg = wireMessage("sender-key-v1", encrypted.encrypted_payload, {
      group_id: GROUP_ID,
    });
    const result = await decryptEnvelope({
      core: asCore(badStore),
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

  it("sender-mismatch path (DM): content re-sealed under another sender is not verified", async () => {
    // The envelope is genuinely signed by SENDER_ID. A peer that holds it can
    // re-seal the same bytes to this recipient and post it as its own — the
    // server then authenticates the resealer as the sender. The row's sender and
    // the envelope's signer disagree, so the turn is not verified content of
    // either agent.
    const payload = { msg: "authentic content of another agent" };
    const encrypted = await encryptMessage(
      configDir,
      SENDER_ID,
      RECIPIENT_ID,
      recipientKeysFor(RECIPIENT_ID),
      payload,
    );

    const mockCore = makeMockCore();
    const result = await decryptEnvelope({
      core: asCore(mockCore),
      configDir,
      agentId: RECIPIENT_ID,
      msg: wireMessage("hpke-hybrid-v2", encrypted.encrypted_payload, {
        from_agent_id: RESEALER_ID,
        // The header the sender supplies is relayed unchecked, so it still names
        // the original signer — it must not be what the check reads.
        sender_signing_kid: `rine:${SENDER_ID}`,
      }),
    });

    expect(result.verified).toBe(false);
    expect(result.verification_status).toBe("sender-mismatch");
    // Refused, not flagged: the content of the row is withheld, so a caller that
    // reads `plaintext` without reading `verified` still cannot render bytes
    // attributed to an agent that did not sign them. The verdict and the reason
    // stay on the message so an operator can tell this from a transient failure.
    expect(result.plaintext).toBeUndefined();
    expect(result.decrypt_error).toContain(
      "Envelope sender does not match the message sender",
    );
    // Disagreement over who authored the bytes is not a network question: no key
    // is fetched to reach the verdict.
    expect(mockCore.get).not.toHaveBeenCalled();
  });

  it("sender-mismatch path (group): a re-sealed turn is refused and the ratchet stands still", async () => {
    const state = generateSenderKey(GROUP_ID, SENDER_ID);
    saveSenderKeyState(configDir, SENDER_ID, GROUP_ID, [state]);
    primeRecipientWithSenderState(configDir, RECIPIENT_ID, GROUP_ID, state);
    const before = loadSenderKeyStates(configDir, RECIPIENT_ID, GROUP_ID);

    const { result: encrypted } = await encryptGroupMessage(
      configDir,
      SENDER_ID,
      GROUP_ID,
      state,
      { sensitive: "data" },
    );

    const result = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg: wireMessage("sender-key-v1", encrypted.encrypted_payload, {
        group_id: GROUP_ID,
        from_agent_id: RESEALER_ID,
      }),
    });

    expect(result.plaintext).toBeUndefined();
    expect(result.verified).toBe(false);
    expect(result.verification_status).toBe("sender-mismatch");
    expect(result.decrypt_error).toContain(
      "Envelope sender does not match the message sender",
    );
    // The refusal is not a retry oracle on the sender-key path: the recipient's
    // chain is exactly where it was, so the honest copy of this message still
    // opens.
    expect(loadSenderKeyStates(configDir, RECIPIENT_ID, GROUP_ID)).toEqual(
      before,
    );
  });

  it("unverifiable path: sender not in key cache returns plaintext + verified=false", async () => {
    // `verifyEnvelopeSender` catches the key-fetch rejection and falls
    // through to `verified: false, verificationStatus: 'unverifiable'`.
    // Plaintext is still returned because the HPKE layer succeeded: an
    // unreachable key endpoint is a transient condition, not a finding against
    // the message, and it must not cost the recipient readable content the way
    // an authenticity failure does.
    const payload = { msg: "unknown sender" };
    const encrypted = await encryptMessage(
      configDir,
      SENDER_ID,
      RECIPIENT_ID,
      recipientKeysFor(RECIPIENT_ID),
      payload,
    );

    const result = await decryptEnvelope({
      core: asCore(makeMockCore(new Set())),
      configDir,
      agentId: RECIPIENT_ID,
      msg: wireMessage("hpke-hybrid-v2", encrypted.encrypted_payload),
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
      RECIPIENT_ID,
      recipientKeysFor(RECIPIENT_ID),
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
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg: wireMessage("hpke-hybrid-v2", tamperedB64),
    });

    expect(result.decrypt_error).not.toBeNull();
    expect(typeof result.decrypt_error).toBe("string");
    expect(result.plaintext).toBeUndefined();
    expect(result.verified).toBe(false);
    expect(result.verification_status).toBe("unverifiable");
  });

  it("a retired hpke-v1 tag is refused as an unknown encryption_version", async () => {
    // `hpke-v1` and `hpke-hybrid-v1` are retired: 1:1 messages are
    // `hpke-hybrid-v2` only. A row still tagged with the old version must not
    // reach the crypto layer at all — it comes back closed, naming the version
    // it could not dispatch, and carrying no plaintext.
    const encrypted = await encryptMessage(
      configDir,
      SENDER_ID,
      RECIPIENT_ID,
      recipientKeysFor(RECIPIENT_ID),
      { payload: "retired" },
    );

    const result = await decryptEnvelope({
      core: asCore(makeMockCore()),
      configDir,
      agentId: RECIPIENT_ID,
      msg: wireMessage("hpke-v1", encrypted.encrypted_payload),
    });

    expect(result.decrypt_error).toBe("unknown encryption_version: hpke-v1");
    expect(result.plaintext).toBeUndefined();
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
    const core = makeMockCore();
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
    saveSenderKeyState(configDir, SENDER_ID, GROUP_ID, [state]);
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
        const match = p.match(/^\/agents\/([^/]+)\/keys$/);
        if (match) return publishedKeys(match[1] as string);
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
    saveSenderKeyState(configDir, SENDER_ID, GROUP_ID, [state]);
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
    const core = makeMockCore();
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
    saveSenderKeyState(configDir, SENDER_ID, GROUP_ID, [state]);
    const payload = { retry: "off" };
    const { result: encrypted } = await encryptGroupMessage(
      configDir,
      SENDER_ID,
      GROUP_ID,
      state,
      payload,
    );

    const core = makeMockCore();
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
