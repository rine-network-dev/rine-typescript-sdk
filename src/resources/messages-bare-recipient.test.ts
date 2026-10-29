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
import { RineApiError } from "@rine-network/core";
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
		sealForAgent: vi.fn(async () => ({
			encrypted_payload: "DM-CIPHERTEXT",
			encryption_version: "hpke-hybrid-v2",
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
			// `/groups/{id}` is the id rung's own route, and it answers for one
			// row only: the org's group. Anything else is the 404 that
			// `readableGroupById` reads as a miss. Answering it with the list body
			// below instead would be a server naming a row nobody asked about,
			// which that function refuses rather than resolves.
			if (path.startsWith("/groups/")) {
				if (path === `/groups/${GROUP_ID}`) return GROUP_ROW;
				throw new RineApiError(404, "Group not found");
			}
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

/**
 * Everything this SDK writes to the operator log while the returned handle is
 * open, as whole lines.
 *
 * Restored by the caller rather than in `afterEach`: the suite's teardown
 * CLEARS mocks and does not restore them, so a `console.warn` spy left standing
 * would silence a later test that expects to see one.
 */
function captureWarnings(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const spy = vi
		.spyOn(console, "warn")
		.mockImplementation((...parts: unknown[]) => {
			lines.push(parts.map(String).join(" "));
		});
	return { lines, restore: () => spy.mockRestore() };
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

	it("leaves a handle alone — not one group read on the way to the agent", async () => {
		// 🔴 The bare-name rule, and the reason this assertion is `[]` and not "no group
		// send": a handle is a spelling `resolveToUuid` can still resolve, so it
		// must never reach the group ladder at all. Widening this is how a
		// routing change turns into a misdelivery on an E2EE product.
		const { client, bodies, paths } = makeClient([]);
		await client.send("bot@acme.rine.network" as never, { hi: true });
		expect(bodies[0]?.to_agent_id).toBe(BOT_ID);
		expect(paths).toEqual([]);
	});

	it("asks the group namespace for a UUID, and falls through when it misses", async () => {
		// The id rung splits the UUID off the rule above: an ID names an entity rather
		// than a namespace, so it costs exactly one credential-scoped group read, and a
		// miss hands the spelling back to the agent arm unchanged. The handle
		// case keeps `paths === []`; this one pins the single read, so a
		// regression that stopped asking and a regression that asked twice both
		// go red.
		const recipientId = randomUUID();
		const { client, bodies, paths } = makeClient([]);
		await client.send(recipientId as never, { hi: true });
		expect(bodies[0]?.to_agent_id).toBe(recipientId);
		expect(paths).toEqual([`/groups/${recipientId}`]);
	});

	it("sends to the group when the UUID is one this org can read", async () => {
		const { client, bodies, paths } = makeClient([]);
		await client.send(GROUP_ID as never, { hi: true });
		expect(bodies[0]?.to_handle).toBe(GROUP_ROW.handle);
		expect(bodies[0]?.to_agent_id).toBeUndefined();
		expect(paths).toContain(`/groups/${GROUP_ID}`);
	});

	// 🔴 No silent acceptance. The send above is the ONE substitution the ladder
	// makes that its caller cannot have intended — no agent holds that id, so the
	// message is sealed for a group and read by every org seated in it — and this
	// surface's channel for saying so is the operator log `resolveSenderId`
	// already warns on. Asserted on the BYTES, not on the call: a notice that
	// named a third handle or an `@org` slot would be a placeholder in a sentence
	// about a real send.
	it("warns that the ID named a group, quoting the spelling and the handle", async () => {
		const { client } = makeClient([]);
		const warned = captureWarnings();
		try {
			await client.send(GROUP_ID as never, { hi: true });
		} finally {
			warned.restore();
		}

		expect(warned.lines).toHaveLength(1);
		expect(warned.lines[0]).toContain(`'${GROUP_ID}'`);
		expect(warned.lines[0]).toContain(`'${GROUP_ROW.handle}'`);
	});

	// The other half of the rule, and why the notice asks the reference CLASS
	// rather than comparing the two strings alone: a group named by its own
	// spelling is a caller choosing the group namespace, and both of these
	// resolve to a handle that differs from what was typed. A notice on them
	// would ride every ordinary group send.
	it.each(["quarterly planning", "#quarterly-planning-401"])(
		"says nothing when the group was named as a group (%s)",
		async (spelling) => {
			const { client, bodies } = makeClient([]);
			const warned = captureWarnings();
			try {
				await client.send(spelling as never, { hi: true });
			} finally {
				warned.restore();
			}

			expect(bodies[0]?.to_handle).toBe(GROUP_ROW.handle);
			expect(warned.lines).toEqual([]);
		},
	);

	// And the miss: an ID that names no group of this org is an agent send, so
	// there is no substitution to report.
	it("says nothing when the UUID falls through to the agent namespace", async () => {
		const recipientId = randomUUID();
		const { client, bodies } = makeClient([]);
		const warned = captureWarnings();
		try {
			await client.send(recipientId as never, { hi: true });
		} finally {
			warned.restore();
		}

		expect(bodies[0]?.to_agent_id).toBe(recipientId);
		expect(warned.lines).toEqual([]);
	});
});
