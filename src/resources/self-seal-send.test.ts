/**
 * The self-seal blob rides the wire on 1:1 send + reply.
 *
 * `encryptMessage` returns `self_encrypted_payload` on its
 * `EncryptResult`; both `send()` (1:1 branch of `buildSendBody`) and `reply()`
 * spread `...encrypted` into the POST body, so the blob reaches the server
 * with NO production code change. These tests pin that contract by capturing
 * the POST body. A group send must NOT carry the blob (the group
 * `EncryptResult` omits it).
 *
 * `@rine-network/core` is mocked so encryption is deterministic and the test
 * touches no real crypto, filesystem, or network. `http.post` is stubbed to
 * capture the body.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const SENDER_ID = randomUUID();
const RECIPIENT_ID = randomUUID();
const GROUP_ID = randomUUID();
const SELF_BLOB = "SELF-SEALED-BLOB";

// Mock the rine-core bridge BEFORE importing the SUT. `encryptMessage` returns
// the self blob; the group encrypt helpers do NOT.
vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...actual,
		fetchAgents: vi.fn(async () => [
			{ id: SENDER_ID, handle: "me@acme.rine.network" },
		]),
		resolveAgent: vi.fn(async () => ({ agentId: SENDER_ID })),
		fetchRecipientKeys: vi.fn(async () => ({ encryption: new Uint8Array(32) })),
		normalizeHandle: vi.fn((h: string) => h),
		encryptMessage: vi.fn(async () => ({
			encrypted_payload: "RECIPIENT-CIPHERTEXT",
			encryption_version: "hpke-v1",
			sender_signing_kid: `rine:${SENDER_ID}`,
			self_encrypted_payload: SELF_BLOB,
		})),
		getOrCreateSenderKey: vi.fn(async () => ({
			state: {},
			groupId: GROUP_ID,
		})),
		// The downgrade guard reads real local MLS state off disk. This file
		// pins the self-seal blob, not the guard, and runs with no config dir.
		assertNoMlsDowngrade: vi.fn(),
		encryptGroupMessage: vi.fn(async () => ({
			result: {
				encrypted_payload: "GROUP-CIPHERTEXT",
				encryption_version: "sender-key-v1",
				sender_signing_kid: `rine:${SENDER_ID}`,
				// Group EncryptResult has no self_encrypted_payload.
			},
		})),
	};
});

const { AsyncRineClient } = await import("../client.js");
const { stubWebFinger } = await import("../_webfinger-stub.js");

// The 1:1 recipient, answered where the resolve actually leaves the process.
// `send()` resolves through the recipient contract, which calls the agent
// resolver inside the core bundle — a `vi.mock` on the exported
// `resolveToUuid` is not on that path and would pass while being ignored.
const webfinger = stubWebFinger({ "bot@acme.rine.network": RECIPIENT_ID });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESPONSE = {
	id: randomUUID(),
	conversation_id: randomUUID(),
	from_agent_id: SENDER_ID,
	to_agent_id: RECIPIENT_ID,
	type: "rine.v1.task_request",
	encrypted_payload: "RECIPIENT-CIPHERTEXT",
	encryption_version: "hpke-v1",
	created_at: "2026-06-20T00:00:00.000Z",
	metadata: {},
};

function makeClient(): {
	client: InstanceType<typeof AsyncRineClient>;
	bodies: Array<{ path: string; body: Record<string, unknown> }>;
} {
	const client = new AsyncRineClient({ agent: "me@acme.rine.network" });
	const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];

	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.getCoreHttpClient = () => ({
		get: async () => ({}),
		post: async () => ({}),
	});
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.post = vi.fn(
		async (path: string, body: Record<string, unknown>) => {
			bodies.push({ path, body });
			return RESPONSE;
		},
	);
	// resolveGroup hits core.get("/groups") — stub a full GroupRead so the
	// GroupReadSchema parse succeeds for the group test.
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.getCoreHttpClient = () => ({
		get: async () => ({
			items: [
				{
					id: GROUP_ID,
					name: "devs",
					handle: "#devs@acme.rine.network",
					created_at: "2026-06-20T00:00:00.000Z",
					mls_group_id: null,
				},
			],
		}),
	});

	return { client, bodies };
}

afterEach(() => {
	vi.clearAllMocks();
});

afterAll(() => {
	webfinger.restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("self-seal on send/reply", () => {
	it("a 1:1 send carries self_encrypted_payload to the server", async () => {
		const { client, bodies } = makeClient();

		await client.send("bot@acme.rine.network" as never, { hello: 1 });

		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.path).toBe("/messages");
		expect(bodies[0]?.body.self_encrypted_payload).toBe(SELF_BLOB);
		expect(bodies[0]?.body.to_agent_id).toBe(RECIPIENT_ID);
	});

	it("a 1:1 reply carries self_encrypted_payload to the server", async () => {
		const { client, bodies } = makeClient();
		const original = {
			...RESPONSE,
			id: randomUUID(),
			// The peer is the original sender; reply seals to them.
			from_agent_id: RECIPIENT_ID,
			to_agent_id: SENDER_ID,
		};
		// reply() fetches the original via core.get, then resolves owned agents.
		// biome-ignore lint/suspicious/noExplicitAny: test override
		(client as any).http.getCoreHttpClient = () => ({
			get: async () => original,
		});

		await client.reply(original.id as never, { ok: true });

		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.path).toBe(`/messages/${original.id}/reply`);
		expect(bodies[0]?.body.self_encrypted_payload).toBe(SELF_BLOB);
	});

	it("a group send does NOT carry self_encrypted_payload", async () => {
		const { client, bodies } = makeClient();

		await client.send("#devs@acme.rine.network" as never, { hi: true });

		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.body.to_handle).toBe("#devs@acme.rine.network");
		expect(bodies[0]?.body).not.toHaveProperty("self_encrypted_payload");
	});
});
