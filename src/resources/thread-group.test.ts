/**
 * `client.thread()` when what the caller holds is a GROUP.
 *
 * The transcript read used to take a conversation UUID and nothing else — the
 * id of a different entity, whose only source was a column another method
 * returned. This asserts the two halves of the fix: a group reference reaches
 * the group's own route, and the two references that cannot both be right are
 * refused offline, before a request is spent.
 *
 * `./decrypt.js` is mocked (the rows here are empty in every case that matters;
 * the render contract is `thread.test.ts`'s subject, not this one's) and both
 * HTTP seams are stubbed, so nothing touches the network, crypto or the
 * filesystem.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const GROUP_ID = randomUUID();
const CONV_ID = randomUUID();
const SELF_ID = randomUUID();
const HANDLE = "#ops@acme.rine.network";

vi.mock("./decrypt.js", () => ({
	decryptEnvelope: vi.fn(async (opts: { msg: unknown }) => opts.msg),
}));

const { AsyncRineClient } = await import("../client.js");

interface Seen {
	readonly sdk: string[];
	readonly core: Array<[string, unknown]>;
}

// A whole row, not the two columns the assertions read. The resolver hands its
// answer back through `GroupReadSchema` — the same parse `groups.get` has always
// made of the same body — so a stub that omits a column the server always sends
// tests a server that does not exist.
const GROUP_ROW = {
	id: GROUP_ID,
	handle: HANDLE,
	name: "ops",
	created_at: "2026-01-01T00:00:00Z",
};

function makeClient(groups: unknown[] = [GROUP_ROW]): {
	client: InstanceType<typeof AsyncRineClient>;
	seen: Seen;
} {
	const client = new AsyncRineClient({ agent: "me@acme.rine.network" });
	const seen: Seen = { sdk: [], core: [] };

	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.get = vi.fn(async (path: string) => {
		seen.sdk.push(path);
		return { messages: [], truncated: false };
	});
	// 🔴 The group's OWN route answers a row; `/groups` answers a page. The
	// resolver's ladder is split across the two — a UUID is read from
	// `GET /groups/{id}`, a handle or a bare name still walks the list — so a
	// stub that answered `{ items }` to both handed the UUID rung a page where a
	// row belongs and resolved to no id at all.
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.getCoreHttpClient = () => ({
		get: async (path: string, params?: unknown) => {
			seen.core.push([path, params]);
			const row = groups.find(
				(g) => `/groups/${(g as { id?: string }).id}` === path,
			);
			return row ?? { items: groups };
		},
	});
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).messagingResource.resolveSenderId = vi
		.fn()
		.mockResolvedValue(SELF_ID);

	return { client, seen };
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("client.thread({ group })", () => {
	it("reads the group's own route, not a conversation's", async () => {
		// 🔴 The group route filters `messages.group_id`. A group's
		// history and its conversation's are two different sets of rows, and on a
		// group founded before the cutover they legitimately disagree.
		const { client, seen } = makeClient();
		await client.thread({ group: HANDLE });
		expect(seen.sdk).toEqual([`/groups/${GROUP_ID}/messages`]);
	});

	it("resolves a handle through the one group resolver, once", async () => {
		const { client, seen } = makeClient();
		await client.thread({ group: "#ops@acme" });
		expect(seen.core).toEqual([
			["/groups", { handle: HANDLE }],
		]);
	});

	// 🔴 Named for the ratified behaviour, not against it. This test read
	// *spends no lookup on a group UUID* until the resolver closed the
	// passthrough — an id nobody had checked reached the transcript route and
	// came back a bare server 404, measured at a 0/6 recovery rate. The
	// replacement is priced: the group's own indexed row, and the
	// unpaginated `GET /groups` only to name the caller's groups in a refusal.
	it("reads a group UUID off the group's own row, and spends no roster on it", async () => {
		const { client, seen } = makeClient();
		await client.thread({ group: GROUP_ID });
		expect(seen.core).toEqual([[`/groups/${GROUP_ID}`, undefined]]);
		expect(seen.sdk).toEqual([`/groups/${GROUP_ID}/messages`]);
	});

	it("reads a group named the way it is said out loud", async () => {
		const { client, seen } = makeClient();
		await client.thread({ group: "ops" });
		// A bare name cannot go through `?handle=` — that filter matches a full
		// handle only — so it is compared against the caller's own groups.
		expect(seen.core).toEqual([["/groups", undefined]]);
		expect(seen.sdk).toEqual([`/groups/${GROUP_ID}/messages`]);
	});
});

describe("client.thread() with a conversation id", () => {
	it("still reads the conversation route, positionally, as before", async () => {
		const { client, seen } = makeClient();
		await client.thread(CONV_ID);
		expect(seen.sdk).toEqual([`/conversations/${CONV_ID}/messages`]);
		expect(seen.core).toEqual([]);
	});
});

describe("naming the wrong thing costs no request", () => {
	it("refuses both references in one sentence naming both", async () => {
		const { client, seen } = makeClient();
		await expect(client.thread(CONV_ID, { group: HANDLE })).rejects.toThrow(
			"Name exactly one of group (a group handle, name or UUID) or " +
				"conversationId (a conversation UUID).",
		);
		expect(seen.sdk).toEqual([]);
		expect(seen.core).toEqual([]);
	});

	it("refuses neither reference in the same sentence", async () => {
		const { client } = makeClient();
		await expect(client.thread({})).rejects.toThrow(
			"Name exactly one of group",
		);
	});

	it("refuses a group named to the conversation parameter, and says where it goes", async () => {
		// The likeliest mistake there was, and the one the old signature invited:
		// the caller held a group, the verb offered nowhere to put it.
		//
		// 🔴 Rung 2. This sentence printed
		// `group=#logistics@acme.rine.network` until the worked example was
		// retired — a model pastes a printed domain back verbatim while inventing
		// the local part. It still names the parameter
		// that takes a group and still lists the three spellings that parameter
		// accepts; what it no longer hands over is a handle to paste.
		const { client, seen } = makeClient();
		await expect(client.thread(HANDLE)).rejects.toThrow(
			`conversationId must be a conversation UUID; "${HANDLE}" is not one. ` +
				"To read a group, name the group instead — group takes a group's " +
				"whole handle, a bare group name, or its UUID.",
		);
		expect(seen.sdk).toEqual([]);
	});

	// The ban itself, not just the one wording above it: a later edit could swap
	// `#logistics@acme…` for a different invented handle inside a reworded
	// sentence and the assertion above would still pass. The probe is run on a
	// reference carrying no `@`, so the only `@` a refusal may legitimately echo
	// — the caller's own — is not there to mask one this SDK invented.
	it("shows no handle of its own in that refusal", async () => {
		const { client } = makeClient();
		const refusal = await client
			.thread("quarterly planning group")
			.then(
				() => "",
				(err: Error) => err.message,
			);

		expect(refusal).toContain("must be a conversation UUID");
		expect(refusal).not.toContain("@");
	});

	it("accepts a conversation id in every spelling the wire reads", async () => {
		// A pre-flight may only refuse what the wire would have refused: the
		// server types this path parameter `uuid.UUID`, which takes all of these.
		const dashless = CONV_ID.replace(/-/g, "");
		const { client, seen } = makeClient();
		await client.thread(dashless);
		await client.thread(`urn:uuid:${CONV_ID}`);
		expect(seen.sdk).toEqual([
			`/conversations/${dashless}/messages`,
			`/conversations/urn:uuid:${CONV_ID}/messages`,
		]);
	});
});
