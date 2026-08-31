/**
 * A bare `send()` recipient reaches the caller's own groups, or a refusal that
 * names both spellings.
 *
 * The precondition this rests on is a property of the agent namespace, not of
 * the group one: `resolveToUuid` (`rine-core/src/resolve-agent.ts`) accepts a
 * UUID or something containing `@` and refuses everything else on syntax,
 * before any request. So the calls routed here were a certain failure, and the
 * tests below pin the two directions that matters in — a name that is a group's
 * now sends, and a name that is an AGENT's still refuses rather than becoming a
 * silent post to a like-named group.
 *
 * `@rine-network/core` is mocked for encryption and for the agent list; the
 * group resolver under test is the real one, driven through a stubbed `get`.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const SENDER_ID = randomUUID();
const GROUP_ID = randomUUID();

/**
 * The org's agents besides the sender, as one test's `makeClient` set them.
 *
 * `send()` reads `GET /agents` ONCE and hands the list to both the acting-agent
 * resolution and the bare-recipient collision guard, so the suite has to have
 * one source for it too. A second stub answering the same route is how a guard
 * comes to be asserted against a list the product never showed it.
 */
const ORG_AGENTS: Array<Record<string, unknown>> = [];

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...actual,
		fetchAgents: vi.fn(async () => [
			{ id: SENDER_ID, handle: "me@acme.rine.network" },
			...ORG_AGENTS,
		]),
		resolveAgent: vi.fn(async () => ({ agentId: SENDER_ID })),
		fetchRecipientKeys: vi.fn(async () => ({ encryption: new Uint8Array(32) })),
		encryptMessage: vi.fn(async () => ({
			encrypted_payload: "DM-CIPHERTEXT",
			encryption_version: "hpke-v1",
			sender_signing_kid: `rine:${SENDER_ID}`,
		})),
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

const { AsyncRineClient } = await import("../client.js");
const { stubWebFinger } = await import("../_webfinger-stub.js");

/** The agent the third test sends to, answered where WebFinger is asked. */
const BOT_ID = randomUUID();
const webfinger = stubWebFinger({ "bot@acme.rine.network": BOT_ID });

const GROUP_ROW = {
	id: GROUP_ID,
	name: "Quarterly planning",
	handle: "#quarterly-planning-401@acme.rine.network",
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

function makeClient(agents: unknown[]): {
	client: InstanceType<typeof AsyncRineClient>;
	bodies: Array<Record<string, unknown>>;
	paths: string[];
} {
	const client = new AsyncRineClient({ agent: "me@acme.rine.network" });
	const bodies: Array<Record<string, unknown>> = [];
	const paths: string[] = [];

	ORG_AGENTS.length = 0;
	ORG_AGENTS.push(...(agents as Array<Record<string, unknown>>));

	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.getCoreHttpClient = () => ({
		get: async (path: string) => {
			paths.push(path);
			// `/agents` is `fetchAgents`' route, and `send()` reads it once through
			// the mock above and hands the one list to both the acting-agent
			// resolution and the collision guard. Nothing may ask for it here, so a
			// regression to two fetches fails loudly instead of quietly reading a
			// second, differently-populated list.
			if (path === "/agents") throw new Error("second GET /agents");
			return { items: [GROUP_ROW] };
		},
	});
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.post = vi.fn(
		async (_path: string, body: Record<string, unknown>) => {
			bodies.push(body);
			return RESPONSE;
		},
	);

	return { client, bodies, paths };
}

afterEach(() => {
	vi.clearAllMocks();
});

afterAll(() => {
	webfinger.restore();
});

describe("send() with a bare recipient", () => {
	it("posts to the group the name resolves to", async () => {
		const { client, bodies } = makeClient([]);

		await client.send("quarterly planning" as never, { hi: true });

		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.to_handle).toBe(GROUP_ROW.handle);
	});

	it("refuses a name that is an agent's, naming the handle that would work", async () => {
		// The dropped-`@org` case. A silent DM is not on the table either —
		// recipient resolution requires a handle by design — so this refuses and
		// prints the spelling the caller meant.
		const { client } = makeClient([
			{ id: randomUUID(), name: "quarterly planning", handle: "qp@acme.rine.network" },
		]);

		await expect(
			client.send("quarterly planning" as never, { hi: true }),
		).rejects.toThrow(/qp@acme\.rine\.network/);
	});

	it("leaves every spelling the agent namespace still accepts alone", async () => {
		// The predicate is the exact complement of the one `resolveToUuid`
		// refuses on. A handle and a UUID are both spellings it can still
		// resolve, so neither may reach the group ladder — widening this is how
		// a routing change turns into a misdelivery on an E2EE product. What
		// pins that here is `paths`: not one `/groups` read on either spelling.
		const recipientId = randomUUID();
		for (const [spelling, resolved] of [
			["bot@acme.rine.network", BOT_ID],
			[recipientId, recipientId],
		] as const) {
			const { client, bodies, paths } = makeClient([]);
			await client.send(spelling as never, { hi: true });
			expect(bodies[0]?.to_agent_id).toBe(resolved);
			expect(paths).toEqual([]);
		}
	});
});
