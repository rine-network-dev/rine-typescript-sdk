/**
 * `client.conversation(id).thread()`.
 *
 * `thread()` fetches `GET /conversations/{id}/messages`, picks the ciphertext
 * the caller can open by `direction` (self-blob for sent, recipient blob for
 * received, group decrypt for group rows), decrypts with the caller's OWN id,
 * and returns an ordered, role-tagged `ThreadEntry[]`. Undecryptable rows
 * (a sent row with no self-blob, or a decrypt failure) render `[unavailable]`
 * and never throw.
 *
 * `./decrypt.js` is mocked so decryption is deterministic AND so the test can
 * assert WHICH ciphertext each row was handed (sent→self blob, received→
 * encrypted_payload). `http.get` + `getCoreHttpClient` + `resolveSenderId` are
 * stubbed so the test touches no network/crypto/filesystem.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageRead } from "../types.js";

const CONV_ID = randomUUID();
const SELF_ID = randomUUID();
const PEER_ID = randomUUID();

// Mock decrypt BEFORE importing the SUT. The mock echoes the ciphertext it was
// handed (via `msg.encrypted_payload`) so tests can assert ciphertext
// selection, and renders a `{text}` payload so the render contract is exercised.
vi.mock("./decrypt.js", () => ({
	decryptEnvelope: vi.fn(
		async (opts: {
			// biome-ignore lint/suspicious/noExplicitAny: test shim
			msg: any;
		}) => {
			const ct = opts.msg?.encrypted_payload;
			if (ct === "BAD") {
				return {
					...opts.msg,
					plaintext: undefined,
					verified: false,
					verification_status: "unverifiable" as const,
					decrypt_error: "simulated failure",
				};
			}
			if (ct === "FORGED") {
				// A tampered/forged turn: core `decryptMessage` does NOT throw on
				// a bad signature — it returns the plaintext tagged "invalid".
				// The SDK must fail-closed (F3): such a row never renders content.
				return {
					...opts.msg,
					plaintext: { text: "forged content" },
					verified: false,
					verification_status: "invalid" as const,
					decrypt_error: null,
				};
			}
			return {
				...opts.msg,
				plaintext: { text: `decoded:${ct}` },
				verified: true,
				verification_status: "verified" as const,
				decrypt_error: null,
			};
		},
	),
}));

const decryptMod = await import("./decrypt.js");
const mockedDecrypt = vi.mocked(decryptMod.decryptEnvelope);

const { AsyncRineClient } = await import("../client.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function row(
	over: Partial<MessageRead> & Pick<MessageRead, "type">,
): MessageRead {
	return {
		id: randomUUID(),
		conversation_id: CONV_ID,
		from_agent_id: SELF_ID,
		to_agent_id: PEER_ID,
		encrypted_payload: "RECIPIENT-CT",
		encryption_version: "hpke-v1",
		metadata: {},
		created_at: "2026-06-20T00:00:00.000Z",
		...over,
	} as MessageRead;
}

function makeClient(rows: MessageRead[]): {
	client: InstanceType<typeof AsyncRineClient>;
	getCalls: Array<{
		path: string;
		params?: Record<string, unknown>;
		extraHeaders?: Record<string, string>;
	}>;
} {
	const client = new AsyncRineClient({ agent: "me@acme.rine.network" });
	const getCalls: Array<{
		path: string;
		params?: Record<string, unknown>;
		extraHeaders?: Record<string, string>;
	}> = [];

	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.get = vi.fn(
		async (
			path: string,
			opts?: {
				params?: Record<string, unknown>;
				extraHeaders?: Record<string, string>;
			},
		) => {
			getCalls.push({
				path,
				params: opts?.params,
				extraHeaders: opts?.extraHeaders,
			});
			// The real endpoint returns `{ messages, truncated }`,
			// NOT a cursor page — mirror that exact shape.
			return { messages: rows, truncated: false };
		},
	);
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.getCoreHttpClient = () => ({});
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).messagingResource.resolveSenderId = vi
		.fn()
		.mockResolvedValue(SELF_ID);

	return { client, getCalls };
}

afterEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationScope.thread()", () => {
	it("returns ordered role-tagged entries decrypted with the caller's keys", async () => {
		const rows = [
			row({
				type: "rine.v1.task_request",
				direction: "sent",
				sender_handle: "me@acme.rine.network",
				encrypted_payload: "RECIPIENT-CT-1",
				self_encrypted_payload: "SELF-CT-1",
			}),
			row({
				type: "rine.v1.task_response",
				direction: "received",
				from_agent_id: PEER_ID,
				to_agent_id: SELF_ID,
				sender_handle: "peer@acme.rine.network",
				encrypted_payload: "RECIPIENT-CT-2",
			}),
		];
		const { client, getCalls } = makeClient(rows);

		const out = await client.conversation(CONV_ID).thread();

		// (a) ordered + direction/senderHandle/type correct
		expect(out.map((e) => e.direction)).toEqual(["sent", "received"]);
		expect(out.map((e) => e.senderHandle)).toEqual([
			"me@acme.rine.network",
			"peer@acme.rine.network",
		]);
		expect(out.map((e) => e.type)).toEqual([
			"rine.v1.task_request",
			"rine.v1.task_response",
		]);

		// (b) text is the decoded body (the `{text}` payload is unwrapped)
		//     AND the SENT row was decrypted from the SELF blob, the RECEIVED
		//     row from the recipient blob.
		expect(out[0]?.text).toBe("decoded:SELF-CT-1");
		expect(out[1]?.text).toBe("decoded:RECIPIENT-CT-2");

		// (c) a successfully-decrypted+verified row carries its signature
		//     status (load-bearing for push-injection filtering).
		expect(out[0]?.verificationStatus).toBe("verified");
		expect(out[1]?.verificationStatus).toBe("verified");

		// the endpoint + limit wiring
		expect(getCalls[0]?.path).toBe(`/conversations/${CONV_ID}/messages`);
	});

	it("renders a sent row with null self_encrypted_payload as [unavailable] (no throw, no decrypt)", async () => {
		const rows = [
			row({
				type: "rine.v1.task_request",
				direction: "sent",
				sender_handle: "me@acme.rine.network",
				self_encrypted_payload: null,
			}),
		];
		const { client } = makeClient(rows);

		const out = await client.conversation(CONV_ID).thread();

		expect(out).toHaveLength(1);
		expect(out[0]?.text).toBe("[unavailable]");
		// A null-self-blob sent row must not even attempt decrypt.
		expect(mockedDecrypt).not.toHaveBeenCalled();
	});

	it("renders a decrypt failure as [unavailable] without throwing", async () => {
		const rows = [
			row({
				type: "rine.v1.task_response",
				direction: "received",
				from_agent_id: PEER_ID,
				to_agent_id: SELF_ID,
				encrypted_payload: "BAD",
			}),
		];
		const { client } = makeClient(rows);

		const out = await client.conversation(CONV_ID).thread();

		expect(out[0]?.text).toBe("[unavailable]");
	});

	it("decrypts a group row via the group path (encrypted_payload, retry on)", async () => {
		const rows = [
			row({
				type: "rine.v1.text",
				direction: "sent",
				sender_handle: "me@acme.rine.network",
				encryption_version: "sender-key-v1",
				group_id: randomUUID(),
				group_handle: "#devs@acme.rine.network",
				encrypted_payload: "GROUP-CT",
				// Group rows have no self-blob; the path must NOT degrade to
				// [unavailable] but decrypt from encrypted_payload.
				self_encrypted_payload: null,
			}),
		];
		const { client } = makeClient(rows);

		const out = await client.conversation(CONV_ID).thread();

		expect(out[0]?.text).toBe("decoded:GROUP-CT");
		// The group row was decrypted from encrypted_payload with retry enabled.
		expect(mockedDecrypt).toHaveBeenCalledTimes(1);
		const call = mockedDecrypt.mock.calls[0]?.[0] as {
			msg: { encrypted_payload: string };
			retrySenderKey?: boolean;
		};
		expect(call.msg.encrypted_payload).toBe("GROUP-CT");
		expect(call.retrySenderKey).toBe(true);
	});

	it("forwards the limit param to the history endpoint", async () => {
		const { client, getCalls } = makeClient([]);

		await client.conversation(CONV_ID).thread({ limit: 10 });

		expect(getCalls[0]?.params?.limit).toBe(10);
	});

	it("fail-closed: a received turn with an invalid signature renders [unavailable] (F3)", async () => {
		// A forged/tampered turn — `decryptEnvelope` returns the plaintext tagged
		// "invalid" (core never throws on a bad signature). It must NEVER enter
		// the transcript as trusted content.
		const rows = [
			row({
				type: "rine.v1.task_response",
				direction: "received",
				from_agent_id: PEER_ID,
				to_agent_id: SELF_ID,
				sender_handle: "attacker@acme.rine.network",
				encrypted_payload: "FORGED",
			}),
		];
		const { client } = makeClient(rows);

		const out = await client.conversation(CONV_ID).thread();

		expect(out[0]?.text).toBe("[unavailable]");
		// The forged plaintext must not leak into the rendered turn.
		expect(out[0]?.text).not.toContain("forged content");
		// A degraded row reports the underlying signature status, not a
		// hardcoded/silent "verified".
		expect(out[0]?.verificationStatus).toBe("invalid");
	});

	it("forwards the agent override as the X-Rine-Agent header (F1)", async () => {
		const { client, getCalls } = makeClient([]);

		await client
			.conversation(CONV_ID)
			.thread({ agent: "other@acme.rine.network" });

		// The self-sealed `sent` blob is sealed to one specific agent, so a
		// non-default agent must read its own thread via the override header.
		expect(getCalls[0]?.extraHeaders?.["X-Rine-Agent"]).toBe(
			"other@acme.rine.network",
		);
	});
});
