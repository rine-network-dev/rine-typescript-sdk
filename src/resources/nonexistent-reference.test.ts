/**
 * The behavioural negative probe: a reference the CLIENT composed, that names
 * no group, fed to the verbs that take one.
 *
 * Every other harness here asserts a reference that RESOLVES, or asserts a
 * refusal's sentence against the function that composes it. Neither is this:
 * what it covers is a nonexistent reference travelling the whole way through a
 * real verb — the ladder, the refusal, and the thing the verb did NOT do on
 * its way out.
 *
 * The two properties, and why each is here rather than in a unit test:
 *
 * 1. **Nothing is written.** A send whose recipient does not resolve must refuse
 *    before `POST /messages`. A resolver unit test cannot see that; only a verb
 *    driven end to end over a transport that records its writes can.
 * 2. **The refusal survives the trip.** The sentence the ladder composed is the
 *    sentence the caller catches, not a wrapper's summary of it — which is what
 *    `#ops` used to get, and is the whole reason the group slot exists.
 *
 * The transport is stubbed and everything above it is real: the client, the
 * recipient door (`rine-core`'s `resolveRecipient`), both group ladders and the
 * refusals they mint. `@rine-network/core` is mocked for encryption alone, so a
 * test that stops refusing would reach a recorded `POST` rather than a crypto
 * error, and fail on the assertion that matters.
 *
 * ⚠️ The BARE miss is deliberately asserted on its two corrections and not on
 * its opening words. `GROUP_NOT_FOUND_LEAD` is a cross-package client protocol
 * with six live consumers, and what a bare name's miss leads with is due to
 * change; pinning the lead HERE would red a gate for the change that is
 * supposed to happen. The sigil and whole-handle misses are group-slot
 * refusals either way, and their lead is pinned.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GROUP_NOT_FOUND_LEAD } from "@rine-network/core";

const SENDER_ID = randomUUID();

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...actual,
		fetchAgents: vi.fn(async () => [
			{ id: SENDER_ID, handle: "me@acme.rine.network" },
		]),
		resolveAgent: vi.fn(async () => ({ agentId: SENDER_ID })),
		sealForAgent: vi.fn(async () => ({
			encrypted_payload: "DM-CIPHERTEXT",
			encryption_version: "hpke-hybrid-v2",
			sender_signing_kid: `rine:${SENDER_ID}`,
		})),
		assertNoMlsDowngrade: vi.fn(),
		getOrCreateSenderKey: vi.fn(async () => ({ state: {}, groupId: randomUUID() })),
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

/** The one group this org is in — never the one any test below names. */
const SEATED = {
	id: randomUUID(),
	name: "ops",
	handle: "#ops@acme.rine.network",
	created_at: "2026-01-01T00:00:00.000Z",
	mls_group_id: null,
};

function makeClient(): {
	client: InstanceType<typeof AsyncRineClient>;
	writes: string[];
} {
	const client = new AsyncRineClient({ agent: "me@acme.rine.network" });
	const writes: string[] = [];

	// Every read answers truthfully for an org seated in exactly one group:
	// the roster lists it, and a lookup for any other handle finds nothing.
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.getCoreHttpClient = () => ({
		get: async (path: string, params?: Record<string, unknown>) => {
			if (!path.startsWith("/groups")) return { items: [] };
			// `?handle=` is the server's own exact-equality filter. Answering it
			// with a row that is not the one asked for is how a stub grants a
			// resolve the product would never have made.
			const wanted = params?.handle;
			if (typeof wanted === "string") {
				return { items: wanted === SEATED.handle ? [SEATED] : [] };
			}
			return { items: [SEATED] };
		},
	});
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.get = async () => ({ items: [] });
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.post = vi.fn(async (path: string) => {
		writes.push(path);
		return {};
	});

	return { client, writes };
}

describe("a reference that names no group, through a real verb", () => {
	it("refuses a sigiled name and sends nothing", async () => {
		const { client, writes } = makeClient();

		await expect(client.send("#nope" as never, { hi: true })).rejects.toThrow(
			new RegExp(`^${GROUP_NOT_FOUND_LEAD}: #nope\\.`),
		);
		expect(writes).toEqual([]);
	});

	it("refuses a whole handle nobody answers to, and sends nothing", async () => {
		const { client, writes } = makeClient();

		await expect(
			client.send("#nope@acme.rine.network" as never, { hi: true }),
		).rejects.toThrow(
			new RegExp(`^${GROUP_NOT_FOUND_LEAD}: #nope@acme\\.rine\\.network\\.`),
		);
		expect(writes).toEqual([]);
	});

	it("refuses a bare name with both corrections, and sends nothing", async () => {
		// A bare word is the one spelling that could have meant either namespace,
		// so its refusal has to print both repairs — an agent written in full and
		// a group written whole. See the ⚠️ in this file's header for why the
		// opening words are not pinned here.
		const { client, writes } = makeClient();

		const raised = await client
			.send("kofi" as never, { hi: true })
			.then(() => null)
			.catch((e: unknown) => e as Error);

		expect(raised?.message).toContain("an at sign, and its org's domain");
		expect(raised?.message).toContain("a leading hash and the same three parts");
		expect(raised?.message).toContain(SEATED.handle);
		expect(writes).toEqual([]);
	});

	it("refuses it on sendAndWait as a group, without asking whether it exists", async () => {
		// 🔴 The assertion that MOVED, and the behaviour change it records. This
		// used to read `/Invalid agent identifier '#nope'/`: `sendAndWait` asked
		// `isGroupHandle`, which requires a whole `#name@org`, so an org-less
		// sigil fell past the guard into the AGENT namespace and came back a
		// syntax complaint about an identifier the caller had never claimed was
		// an agent. Every other surface reads `#nope` as a group.
		//
		// The refusal is now the group one, and it is composed on the SPELLING —
		// `/messages/sync` is 1:1 whether or not the group exists, so this verb
		// never spends a read to find out. That is why this case belongs in a
		// file about references naming nothing and still asserts nothing was
		// written: the sigil class is refused before either namespace is asked.
		const { client, writes } = makeClient();

		await expect(
			client.sendAndWait("#nope" as never, { hi: true }),
		).rejects.toThrow(/^sendAndWait\(\) does not support group handles/);
		expect(writes).toEqual([]);
	});

	it("refuses it on groups.resolveRef, naming the groups that do answer", async () => {
		const { client } = makeClient();

		await expect(client.groups.resolveRef("#nope")).rejects.toThrow(
			new RegExp(`^${GROUP_NOT_FOUND_LEAD}: #nope\\.`),
		);
	});

	it("refuses it on the join ladder, which walks different rungs", async () => {
		// 🔴 A separate ladder by design: `join` targets a group this org holds no
		// seat in, so the roster the refusals above quote is the one set it cannot
		// be aimed at. What this pins is only that the negative answer is a refusal
		// here as well — never a resolved id, and never a silent undefined.
		const { client } = makeClient();

		await expect(client.groups.resolveRefForJoin("#nope")).rejects.toThrow(
			/#nope/,
		);
	});
});
