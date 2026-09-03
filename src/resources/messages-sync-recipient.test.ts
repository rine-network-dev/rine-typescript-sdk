/**
 * What `sendAndWait` does with a recipient that names a group — every spelling.
 *
 * `POST /messages/sync` is 1:1 only, so this verb has exactly one job with a
 * group: recognise it and refuse before anything is sealed. It did that for a
 * whole `#name@org` handle and for nothing else. The two holes this file pins
 * shut, both measured at `691fcb53`:
 *
 * 1. **A group's own UUID** was handed to `resolveToUuid` and HPKE-sealed to an
 *    agent that does not exist, so the caller got the server's bare
 *    `404: Agent not found` — on this SDK and on the two published connectors
 *    that wrap it (`rine-mastra`, `rine-eve`). `rine-mcp` already answered the
 *    same reference correctly, so one product had two answers.
 * 2. **The org-less `#ops`** fell past `isGroupHandle` — which requires
 *    `#name@org` — into the agent namespace and came back
 *    `Invalid agent identifier '#ops'`, a syntax complaint about a namespace the
 *    caller had said, with the sigil, that it did not mean.
 *
 * 🔴 Half of this file is ANTI-widening, and that half is the one that can fail
 * quietly. A refusal that fired on an agent UUID, on a handle, or on a bare word
 * would break 1:1 sending — the verb's entire purpose — so every class that must
 * still reach the agent namespace is driven here too, and the `GET /groups/…`
 * traffic is asserted rather than just the outcome: an arm that asked the group
 * namespace about a handle would still send, and only the traffic can see it.
 *
 * The transport is stubbed and everything above it is real: the resource, the
 * classification table, and `readableGroupById`'s own 404/403-is-a-miss rule.
 * `@rine-network/core` is mocked for encryption alone.
 */

import { randomUUID } from "node:crypto";
import { RineApiError } from "@rine-network/core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const SENDER_ID = randomUUID();
const GROUP_ID = randomUUID();
const BOT_ID = randomUUID();

/**
 * The refusal's HEAD, as `rine-mastra` and `rine-eve` prefix-match it.
 *
 * 🔴 Written out here rather than imported from the resource. Both connectors
 * hold their own `GROUP_ON_WAIT_PREFIX` string literal, are invisible to
 * `ci.sh`, and are typecheck-gated inside the publish train's `set -e` subshell
 * — so the thing worth asserting is that the shipped bytes still start this way,
 * which an import of the constant under test could not tell me.
 */
const REFUSAL_HEAD = "sendAndWait() does not support group handles";

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...actual,
		resolveAgent: vi.fn(async () => ({ agentId: SENDER_ID })),
		fetchAgents: vi.fn(async () => [
			{ id: SENDER_ID, handle: "me@acme.rine.network" },
		]),
		fetchRecipientKeys: vi.fn(async () => ({ encryption: new Uint8Array(32) })),
		encryptMessage: vi.fn(async () => ({
			encrypted_payload: "DM-CIPHERTEXT",
			encryption_version: "hpke-v1",
			sender_signing_kid: `rine:${SENDER_ID}`,
		})),
	};
});

const { AsyncRineClient } = await import("../client.js");
const { stubWebFinger } = await import("../_webfinger-stub.js");

const webfinger = stubWebFinger({ "bot@acme.rine.network": BOT_ID });

const GROUP_ROW = {
	id: GROUP_ID,
	name: "ops",
	handle: "#ops@acme.rine.network",
	created_at: "2026-01-01T00:00:00.000Z",
	mls_group_id: null,
};

const RESPONSE = {
	message: {
		id: randomUUID(),
		conversation_id: randomUUID(),
		from_agent_id: SENDER_ID,
		to_agent_id: BOT_ID,
		type: "rine.v1.task_request",
		encrypted_payload: "DM-CIPHERTEXT",
		encryption_version: "hpke-v1",
		created_at: "2026-01-01T00:00:00.000Z",
		metadata: {},
	},
	reply: null,
};

/**
 * A client whose group route answers for one row, and refuses everything else.
 *
 * `refuseWith` overrides the status `GET /groups/{id}` answers a given id with,
 * which is how the two answers an org's own listing cannot describe are
 * reached: the **403** the real route gives for a group this caller is neither
 * owner of nor seated in, and a server fault, which is not an answer about the
 * reference at all.
 */
function makeClient(refuseWith: Record<string, number> = {}): {
	client: InstanceType<typeof AsyncRineClient>;
	reads: string[];
	writes: string[];
} {
	const client = new AsyncRineClient({ agent: "me@acme.rine.network" });
	const reads: string[] = [];
	const writes: string[] = [];

	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.getCoreHttpClient = () => ({
		get: async (path: string) => {
			reads.push(path);
			if (path.startsWith("/groups/")) {
				const asked = path.slice("/groups/".length);
				const refused = refuseWith[asked];
				if (refused !== undefined)
					throw new RineApiError(refused, "refused");
				if (asked === GROUP_ID) return GROUP_ROW;
				throw new RineApiError(404, "Group not found");
			}
			return { items: [] };
		},
	});
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.post = vi.fn(async (path: string) => {
		writes.push(path);
		return RESPONSE;
	});

	return { client, reads, writes };
}

/** Every `GET /groups/…` a call paid for — the anti-widening assertion. */
const groupReads = (reads: string[]) =>
	reads.filter((path) => path.startsWith("/groups/"));

/**
 * The first {@link REFUSAL_HEAD}-many characters of the refusal a call raised.
 *
 * 🔴 A slice compared for EQUALITY, never `toThrow(REFUSAL_HEAD)` and never a
 * `RegExp` built from it. `toThrow(string)` is a substring test, which would
 * pass on a message that merely CONTAINS the head — and the head's whole value
 * to `rine-mastra` and `rine-eve` is that it comes first, because both reach the
 * pinned model-facing sentence through `startsWith`. A `RegExp` built from the
 * head is worse than useless: `sendAndWait()` carries a literal `()`, which is
 * an empty capture group, so the pattern silently stops requiring the two
 * characters it looks like it is requiring.
 *
 * Resolving is a failure with its own sentence, so a verb that stopped refusing
 * cannot read as a wrong message.
 */
async function refusalHead(call: Promise<unknown>): Promise<string> {
	const message = await call.then(
		() => "sendAndWait() RESOLVED — it must refuse this recipient",
		(error: unknown) => (error as Error).message,
	);
	return message.slice(0, REFUSAL_HEAD.length);
}

afterEach(() => {
	vi.clearAllMocks();
});

afterAll(() => {
	webfinger.restore();
});

describe("sendAndWait() with a recipient that names a group", () => {
	it("refuses a UUID this org can read a group of, and sends nothing", async () => {
		const { client, reads, writes } = makeClient();

		expect(await refusalHead(client.sendAndWait(GROUP_ID as never, { hi: true }))).toBe(
			REFUSAL_HEAD,
		);
		expect(writes).toEqual([]);
		// Exactly one org-scoped read is what the fix costs. Two would mean the
		// probe ran and the 1:1 path then asked again; none would mean the
		// refusal is guessing from the spelling.
		expect(groupReads(reads)).toEqual([`/groups/${GROUP_ID}`]);
	});

	it("refuses the org-less sigil without asking either namespace", async () => {
		// `#ops` is a group as WRITTEN, so no read decides it — which is
		// also why the refusal is available before a transport exists.
		const { client, reads, writes } = makeClient();

		expect(await refusalHead(client.sendAndWait("#ops" as never, { hi: true }))).toBe(
			REFUSAL_HEAD,
		);
		expect(writes).toEqual([]);
		expect(groupReads(reads)).toEqual([]);
	});

	it("refuses a whole group handle, as it always has", async () => {
		const { client, writes } = makeClient();

		expect(
			await refusalHead(
				client.sendAndWait("#ops@acme.rine.network" as never, { hi: true }),
			),
		).toBe(REFUSAL_HEAD);
		expect(writes).toEqual([]);
	});

	it("refuses a dropped org half locally instead of sealing it for the server to reject", async () => {
		// 🔴 A behaviour change, recorded here because it is user-visible.
		// `#ops@` is not a whole handle, so it used to escape the raw-spelling
		// guard, acquire the default domain in `normalizeHandle`, resolve, mint a
		// sender key, seal, POST — and be answered by the server's
		// `422 sync endpoint does not support group handles`. The classification
		// table reads the sigil alone, so the same refusal now arrives before any
		// of that: same class of answer, no key minted, nothing written, and the
		// sentence the two connectors prefix-match instead of a raw 422.
		const { client, writes } = makeClient();

		expect(await refusalHead(client.sendAndWait("#ops@" as never, { hi: true }))).toBe(
			REFUSAL_HEAD,
		);
		expect(writes).toEqual([]);
	});
});

describe("sendAndWait() with everything that is NOT a group", () => {
	it("still sends to an agent UUID, after one group read that missed", async () => {
		// The half that must not move: a UUID has been a legitimate agent id for
		// as long as the product has existed, and a 404 from the group route is
		// not an answer about the recipient.
		const { client, reads, writes } = makeClient();
		const recipient = randomUUID();

		await client.sendAndWait(recipient as never, { hi: true });

		expect(writes).toEqual(["/messages/sync"]);
		expect(groupReads(reads)).toEqual([`/groups/${recipient}`]);
	});

	it("treats a 403 as a miss and sends 1:1", async () => {
		// The disclosure rule, through the verb. `GET /groups/{id}` 403s a group
		// belonging to an org this caller is neither owner of nor seated in;
		// refusing there would confirm which unknown ids exist AND break every
		// agent id that happens to collide with a stranger's group.
		const stranger = randomUUID();
		const { client, writes } = makeClient({ [stranger]: 403 });

		await client.sendAndWait(stranger as never, { hi: true });

		expect(writes).toEqual(["/messages/sync"]);
	});

	it("lets a server fault reach the caller instead of swallowing it into a send", async () => {
		// A 500 is not "no group of that id". Falling through would tell a caller
		// their recipient was wrong about an outage, and would then seal a group
		// id to a nonexistent agent.
		const id = randomUUID();
		const { client, writes } = makeClient({ [id]: 500 });

		await expect(client.sendAndWait(id as never, { hi: true })).rejects.toThrow(
			RineApiError,
		);
		expect(writes).toEqual([]);
	});

	it("leaves an agent handle alone — not one group read on the way", async () => {
		// 🔴 `[]`, not "did not refuse": a handle is a spelling the agent
		// namespace resolves, so it must never reach the group route at all. An
		// arm widened past the id class would still send here, and only the
		// traffic can see it.
		const { client, reads, writes } = makeClient();

		await client.sendAndWait("bot@acme.rine.network" as never, { hi: true });

		expect(writes).toEqual(["/messages/sync"]);
		expect(groupReads(reads)).toEqual([]);
	});

	it("still refuses a bare word in the agent namespace, and asks no group", async () => {
		// 🔴 `sendAndWait` deliberately does NOT read a bare word as a group,
		// unlike `send`. Routing it through that door would turn a certain
		// syntactic refusal into a group send `/messages/sync` then rejects — so
		// the refusal here is the agent namespace's, and it stays that way.
		const { client, reads, writes } = makeClient();

		await expect(
			client.sendAndWait("ops" as never, { hi: true }),
		).rejects.toThrow(/ops/);
		expect(writes).toEqual([]);
		expect(groupReads(reads)).toEqual([]);
	});
});
