/**
 * Integration — `client.conversation(id).thread()` with REAL crypto.
 *
 * Unlike `thread.test.ts` (which mocks `decryptEnvelope` to pin ciphertext
 * SELECTION), this suite exercises the END-TO-END decrypt path with real
 * `@rine-network/core` primitives — the SAME `encryptMessage` the SDK's
 * `send()` calls and the SAME `decryptEnvelope` the SDK runs inside
 * `fetchThread`. Nothing crypto is mocked; only the HTTP boundary is stubbed:
 *
 *   - `http.get('/conversations/{id}/messages')` returns a `{messages,truncated}`
 *     page of both-sided rows (the real endpoint shape),
 *   - `getCoreHttpClient().get('/agents/{id}/keys')` answers the sender-signature
 *     verification lookup from the fixture's published key chain,
 *   - `resolveSenderId` returns the real caller id.
 *
 * The agents are real derived agents of a custody fixture (`seedAgent` writes
 * their generation-0 leaf keys, `publishedKeys` is what the server answers for
 * them), so the signature scope ids are canonical UUIDs and the keys the
 * envelope is sealed to are the keys the derivation tree really holds.
 *
 * This proves the gate behavior directly: a real two-turn 1:1 thread decrypts
 * BOTH sides (sent from the self-seal blob, received from the recipient blob),
 * ordered; a sent row with `self_encrypted_payload: null` renders
 * `[unavailable]` without throwing; and a refused row — a signature that does
 * not check out, or one naming an agent other than the row's sender — renders
 * `[unavailable]` carrying its verdict. The fixtures mirror the Python SDK's
 * `test_thread.py::TestThread` so both SDKs are proven against identical data.
 */

import {
	type AgentKeysResponse,
	type HttpClient as CoreHttpClient,
	encryptMessage,
	jwkToPqPublicKey,
	jwkToPublicKey,
} from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRead } from "../types.js";
import {
	type CustodyFixture,
	makeCustodyFixture,
	publishedKeys,
	seedAgent,
} from "@rine-network/core/testing";

const CONV_ID = "e5f6a7b8-c9d0-4234-efab-345678901234";
const SELF_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const PEER_ID = "b2c3d4e5-f6a7-4901-bcde-f12345678901";
/** A peer that re-seals another agent's signed envelope and posts it as its own. */
const RESEALER_ID = "c3d4e5f6-a7b8-4012-cdef-123456789012";

let fx: CustodyFixture;

const { AsyncRineClient } = await import("../client.js");

beforeEach(() => {
	fx = makeCustodyFixture();
	seedAgent(fx, SELF_ID);
	seedAgent(fx, PEER_ID);
});

afterEach(() => {
	fx.cleanup();
	vi.clearAllMocks();
});

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
 * In-memory `/agents/{id}/keys` answerer for sender-signature verification.
 *
 * `publishedSigning` overrides the signing key an agent publishes, so a row can
 * be signed by one key and checked against another — what a recipient sees when
 * the signature does not check out.
 */
function keysCore(
	publishedSigning: Map<string, AgentKeysResponse["signing_public_key"]> = new Map(),
): CoreHttpClient {
	return {
		get: vi.fn(async (p: string) => {
			const m = p.match(/^\/agents\/([^/]+)\/keys$/);
			if (!m) throw new Error(`unexpected path: ${p}`);
			const id = m[1] as string;
			const body = publishedKeys(id);
			const signing = publishedSigning.get(id);
			return signing ? { ...body, signing_public_key: signing } : body;
		}),
	} as unknown as CoreHttpClient;
}

function makeClient(
	rows: MessageRead[],
	publishedSigning?: Map<string, AgentKeysResponse["signing_public_key"]>,
): InstanceType<typeof AsyncRineClient> {
	const client = new AsyncRineClient({
		agent: "me@acme.rine.network",
		configDir: fx.dirs.configDir,
		ownerDir: fx.dirs.ownerDir,
	});
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.get = vi.fn(async () => ({
		messages: rows,
		truncated: false,
	}));
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.getCoreHttpClient = () => keysCore(publishedSigning);
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).messagingResource.resolveSenderId = vi
		.fn()
		.mockResolvedValue(SELF_ID);
	return client;
}

function row(
	over: Partial<MessageRead> & Pick<MessageRead, "type">,
): MessageRead {
	return {
		id: crypto.randomUUID(),
		conversation_id: CONV_ID,
		from_agent_id: SELF_ID,
		to_agent_id: PEER_ID,
		encrypted_payload: "",
		encryption_version: "hpke-hybrid-v2",
		metadata: {},
		created_at: "2026-06-20T00:00:00.000Z",
		...over,
	} as MessageRead;
}

describe("thread() real-crypto round-trip (integration)", () => {
	it("decrypts a real two-turn 1:1 thread, both sides, ordered", async () => {
		// SENT: me → peer. encryptMessage yields BOTH the recipient copy and the
		// self-seal blob (sealed to my own key) — exactly what send() POSTs.
		const sent = await encryptMessage(
			fx.dirs.configDir,
			SELF_ID,
			PEER_ID,
			recipientKeysFor(PEER_ID),
			{ text: "hi peer, the codeword is albatross" },
		);
		expect(sent.self_encrypted_payload).toBeTruthy();

		// RECEIVED: peer → me, sealed to MY encryption key, signed by the peer.
		const received = await encryptMessage(
			fx.dirs.configDir,
			PEER_ID,
			SELF_ID,
			recipientKeysFor(SELF_ID),
			{ text: "got it, albatross noted" },
		);

		const rows = [
			row({
				type: "rine.v1.task_request",
				direction: "sent",
				sender_handle: "me@acme.rine.network",
				encrypted_payload: sent.encrypted_payload,
				self_encrypted_payload: sent.self_encrypted_payload,
			}),
			row({
				type: "rine.v1.task_response",
				direction: "received",
				from_agent_id: PEER_ID,
				to_agent_id: SELF_ID,
				sender_handle: "peer@acme.rine.network",
				encrypted_payload: received.encrypted_payload,
			}),
		];

		const out = await makeClient(rows).conversation(CONV_ID).thread();

		expect(out.map((e) => e.direction)).toEqual(["sent", "received"]);
		// Real decrypt: the SENT turn opened from the self-blob, the RECEIVED
		// turn from the recipient blob — both unwrapped to the bare body string.
		expect(out[0]?.text).toBe("hi peer, the codeword is albatross");
		expect(out[1]?.text).toBe("got it, albatross noted");
		// Both signatures verify against the published key chain.
		expect(out[0]?.verificationStatus).toBe("verified");
		expect(out[1]?.verificationStatus).toBe("verified");
		expect(out.map((e) => e.senderHandle)).toEqual([
			"me@acme.rine.network",
			"peer@acme.rine.network",
		]);
	});

	it("renders a sent row with null self_encrypted_payload as [unavailable] without throwing", async () => {
		const rows = [
			row({
				type: "rine.v1.task_request",
				direction: "sent",
				sender_handle: "me@acme.rine.network",
				encrypted_payload: "legacy-recipient-only-blob",
				self_encrypted_payload: null,
			}),
		];

		const out = await makeClient(rows).conversation(CONV_ID).thread();

		expect(out).toHaveLength(1);
		expect(out[0]?.text).toBe("[unavailable]");
	});

	it("refuses a received turn whose signature does not check out", async () => {
		// Mirrors `test_thread.py::TestThread::test_async_thread_forged_signature_is_unavailable`:
		// the peer publishes a signing key that is not the key that signed the row.
		const received = await encryptMessage(
			fx.dirs.configDir,
			PEER_ID,
			SELF_ID,
			recipientKeysFor(SELF_ID),
			{ text: "got it, albatross noted" },
		);
		const rows = [
			row({
				type: "rine.v1.task_response",
				direction: "received",
				from_agent_id: PEER_ID,
				to_agent_id: SELF_ID,
				sender_handle: "peer@acme.rine.network",
				encrypted_payload: received.encrypted_payload,
			}),
		];

		const out = await makeClient(
			rows,
			new Map([[PEER_ID, publishedKeys(RESEALER_ID).signing_public_key]]),
		)
			.conversation(CONV_ID)
			.thread();

		expect(out[0]?.text).toBe("[unavailable]");
		expect(out[0]?.text).not.toContain("albatross");
		// "invalid", not the default "unverifiable" — the same verdict the Python
		// SDK reports for this row, so both transcripts read alike.
		expect(out[0]?.verificationStatus).toBe("invalid");
	});

	it("refuses a received turn signed by an agent other than its sender", async () => {
		// The peer's genuinely signed bytes, re-sealed by a third agent and posted
		// as its own: the server authenticates the resealer, the envelope names the
		// peer. Nobody is accountable for the content, so it never renders.
		const received = await encryptMessage(
			fx.dirs.configDir,
			PEER_ID,
			SELF_ID,
			recipientKeysFor(SELF_ID),
			{ text: "got it, albatross noted" },
		);
		const rows = [
			row({
				type: "rine.v1.task_response",
				direction: "received",
				from_agent_id: RESEALER_ID,
				to_agent_id: SELF_ID,
				sender_handle: "resealer@acme.rine.network",
				encrypted_payload: received.encrypted_payload,
			}),
		];

		const out = await makeClient(rows).conversation(CONV_ID).thread();

		expect(out[0]?.text).toBe("[unavailable]");
		expect(out[0]?.text).not.toContain("albatross");
		expect(out[0]?.verificationStatus).toBe("sender-mismatch");
	});
});
