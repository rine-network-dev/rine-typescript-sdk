/**
 * REQ-SDK-TS-02 (integration) — `client.conversation(id).thread()` with REAL crypto.
 *
 * Unlike `thread.test.ts` (which mocks `decryptEnvelope` to pin ciphertext
 * SELECTION), this suite exercises the END-TO-END decrypt path with real
 * `@rine-network/core` primitives — the SAME `encryptMessage` the SDK's
 * `send()` calls and the SAME `decryptEnvelope` the SDK runs inside
 * `fetchThread`. Nothing crypto is mocked; only the HTTP boundary is stubbed:
 *
 *   - `http.get('/conversations/{id}/messages')` returns a `{messages,truncated}`
 *     page of both-sided rows (the real Slice A endpoint shape, REQ-SRV-04),
 *   - `getCoreHttpClient().get('/agents/{id}/keys')` answers the sender-signature
 *     verification lookup from an in-memory keystore,
 *   - `resolveSenderId` returns the real caller id.
 *
 * This proves the gate behavior directly: a real two-turn 1:1 thread decrypts
 * BOTH sides (sent from the self-seal blob, received from the recipient blob),
 * ordered; and a sent row with `self_encrypted_payload: null` renders
 * `[unavailable]` without throwing. The fixtures mirror the Python SDK's
 * `test_thread.py::TestThread` so both SDKs are proven against identical data.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	type AgentKeys,
	type HttpClient as CoreHttpClient,
	encryptMessage,
	generateAgentKeys,
	saveAgentKeys,
	signingPublicKeyToJWK,
	toBase64Url,
} from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRead } from "../types.js";

const CONV_ID = "e5f6a7b8-c9d0-4234-efab-345678901234";
const SELF_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const PEER_ID = "b2c3d4e5-f6a7-4901-bcde-f12345678901";

let dir: string;
let selfKeys: AgentKeys;
let peerKeys: AgentKeys;

const { AsyncRineClient } = await import("../client.js");

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(tmpdir(), "rine-thread-int-"));
	selfKeys = generateAgentKeys();
	peerKeys = generateAgentKeys();
	saveAgentKeys(dir, SELF_ID, selfKeys);
	saveAgentKeys(dir, PEER_ID, peerKeys);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	vi.clearAllMocks();
});

/** In-memory `/agents/{id}/keys` answerer for sender-signature verification. */
function keysCore(): CoreHttpClient {
	const store = new Map<string, AgentKeys>([
		[SELF_ID, selfKeys],
		[PEER_ID, peerKeys],
	]);
	return {
		get: vi.fn(async (p: string) => {
			const m = p.match(/^\/agents\/([^/]+)\/keys$/);
			if (!m) throw new Error(`unexpected path: ${p}`);
			const keys = store.get(m[1] as string);
			if (!keys) throw new Error(`unknown agent: ${m[1]}`);
			return {
				agent_id: m[1],
				signing_public_key: signingPublicKeyToJWK(keys.signing.publicKey),
				encryption_public_key: {
					kty: "OKP",
					crv: "X25519",
					x: toBase64Url(keys.encryption.publicKey),
				},
			};
		}),
	} as unknown as CoreHttpClient;
}

function makeClient(rows: MessageRead[]): InstanceType<typeof AsyncRineClient> {
	const client = new AsyncRineClient({ agent: "me@acme.rine.network", configDir: dir });
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.get = vi.fn(async () => ({
		messages: rows,
		truncated: false,
	}));
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.getCoreHttpClient = () => keysCore();
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).messagingResource.resolveSenderId = vi
		.fn()
		.mockResolvedValue(SELF_ID);
	return client;
}

function row(over: Partial<MessageRead> & Pick<MessageRead, "type">): MessageRead {
	return {
		id: crypto.randomUUID(),
		conversation_id: CONV_ID,
		from_agent_id: SELF_ID,
		to_agent_id: PEER_ID,
		encrypted_payload: "",
		encryption_version: "hpke-v1",
		metadata: {},
		created_at: "2026-06-20T00:00:00.000Z",
		...over,
	} as MessageRead;
}

describe("REQ-SDK-TS-02 (integration) — thread() real-crypto round-trip", () => {
	it("decrypts a real two-turn 1:1 thread, both sides, ordered", async () => {
		// SENT: me → peer. encryptMessage yields BOTH the recipient copy and the
		// self-seal blob (sealed to my own key) — exactly what send() POSTs.
		const sent = await encryptMessage(
			dir,
			SELF_ID,
			peerKeys.encryption.publicKey,
			{ text: "hi peer, the codeword is albatross" },
		);
		expect(sent.self_encrypted_payload).toBeTruthy();

		// RECEIVED: peer → me, sealed to MY encryption key, signed by the peer.
		const received = await encryptMessage(
			dir,
			PEER_ID,
			selfKeys.encryption.publicKey,
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
		// Both signatures verify against the in-memory keystore.
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
});
