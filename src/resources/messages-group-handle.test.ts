/**
 * What a group send puts on the wire when the handle it was given is not the
 * handle the server holds.
 *
 * Every group verb has a resolver ladder, so `#quarterly-planning@acme…`
 * resolves to the group whose real handle is `#quarterly-planning-401@gqb401…`.
 * The resolve was only half of it: `POST /messages` looks `to_handle` up by
 * exact equality, so a body carrying the spelling the CALLER wrote is refused
 * by the server with a bare `Group not found` — sealed for the right group,
 * refused on the way out, and indistinguishable from the ladder never having
 * run. This file is that second half, pinned.
 *
 * 🔴 The `get` stub FILTERS, and that is the whole test. A stub that answers
 * every `?handle=` with the row it holds makes the exact rung appear to work,
 * so nothing reaches the fallback and nothing ever posts a spelling the server
 * would refuse — the mock reproduces the bug's own invisibility.
 *
 * `@rine-network/core` is mocked for encryption only; the group resolver under
 * test is the real one, driven through the stub.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const SENDER_ID = randomUUID();
const GROUP_ID = randomUUID();

/** The handle the server holds. Nothing here answers to `acme`. */
const REAL_HANDLE = "#quarterly-planning-401@gqb401.rine.network";

/**
 * What a model writes: the local part learned from the conversation, the
 * domain copied out of a tool description. The measured shape, not a guess.
 */
const COMPOSED_HANDLE = "#quarterly-planning@acme.rine.network";

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...actual,
		fetchAgents: vi.fn(async () => [
			{ id: SENDER_ID, handle: "me@acme.rine.network" },
		]),
		resolveAgent: vi.fn(async () => ({ agentId: SENDER_ID })),
		assertNoMlsDowngrade: vi.fn(),
		getOrCreateSenderKey: vi.fn(async () => ({ state: {}, groupId: GROUP_ID })),
		encryptGroupMessage: vi.fn(async () => ({
			result: {
				encrypted_payload: "GROUP-CIPHERTEXT",
				encryption_version: "sender-key-v1",
				sender_signing_kid: `rine:${SENDER_ID}`,
			},
		})),
	};
});

const core = await import("@rine-network/core");
const { AsyncRineClient } = await import("../client.js");

const GROUP_ROW = {
	id: GROUP_ID,
	name: "quarterly-planning-401",
	handle: REAL_HANDLE,
	created_at: "2026-01-01T00:00:00.000Z",
	mls_group_id: null,
};

const RESPONSE = {
	id: randomUUID(),
	conversation_id: randomUUID(),
	from_agent_id: SENDER_ID,
	to_agent_id: randomUUID(),
	type: "rine.v1.task_request",
	encrypted_payload: "GROUP-CIPHERTEXT",
	encryption_version: "sender-key-v1",
	created_at: "2026-01-01T00:00:00.000Z",
	metadata: {},
};

function makeClient(): {
	client: InstanceType<typeof AsyncRineClient>;
	bodies: Array<Record<string, unknown>>;
	filters: Array<string | undefined>;
} {
	const client = new AsyncRineClient({ agent: "me@acme.rine.network" });
	const bodies: Array<Record<string, unknown>> = [];
	const filters: Array<string | undefined> = [];

	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.getCoreHttpClient = () => ({
		get: async (path: string, params?: Record<string, unknown>) => {
			if (path !== "/groups") return {};
			const handle = params?.handle as string | undefined;
			filters.push(handle);
			return {
				items: handle
					? [GROUP_ROW].filter((row) => row.handle === handle)
					: [GROUP_ROW],
			};
		},
	});
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.post = vi.fn(
		async (_path: string, body: Record<string, unknown>) => {
			bodies.push(body);
			return RESPONSE;
		},
	);

	return { client, bodies, filters };
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("send() to a group handle the server does not hold", () => {
	it("posts the handle the server holds, never the one it was given", async () => {
		const { client, bodies, filters } = makeClient();

		await client.send(COMPOSED_HANDLE as never, { hi: true });

		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.to_handle).toBe(REAL_HANDLE);
		// The exact rung was tried first and answered nothing — otherwise this
		// test proves only that a correct handle survives being sent.
		expect(filters).toEqual([COMPOSED_HANDLE, undefined]);
	});

	it("keys the sender key to the resolved handle too", async () => {
		// Everything downstream addresses the group the SERVER holds. The
		// sender-key helper resolves the handle it is given all over again, so
		// handing it the caller's spelling buys a second round trip and a second
		// chance for the two resolutions to disagree.
		const { client } = makeClient();

		await client.send(COMPOSED_HANDLE as never, { hi: true });

		expect(core.getOrCreateSenderKey).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			SENDER_ID,
			REAL_HANDLE,
			expect.anything(),
		);
	});

	it("leaves a handle the server does hold exactly as written", async () => {
		// The fallback is a fallback: a correct handle must still cost one round
		// trip, or every group send in the product pays for a miss nobody made.
		const { client, bodies, filters } = makeClient();

		await client.send(REAL_HANDLE as never, { hi: true });

		expect(bodies[0]?.to_handle).toBe(REAL_HANDLE);
		expect(filters).toEqual([REAL_HANDLE]);
	});
});
