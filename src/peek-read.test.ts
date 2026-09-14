/**
 * A peek read declines the delivery mark, and a plain read still takes it.
 *
 * 🔴 **The assertion is on the wire.** What a caller passes as `peek` is only
 * ever worth anything if it arrives as `X-Rine-Peek` on the `GET /messages/{id}`
 * the SDK actually issues — the server reads a header, not an option — so every
 * test here drives the public `AsyncRineClient.read()` and inspects the request
 * that came out the bottom. A test that asserted the resource read `opts.peek`
 * would pass with the header wired nowhere.
 *
 * The negative half is the load-bearing half. A read consumes the row, and
 * there is no un-mark route, so a header wired on unconditionally would silently
 * stop every plain read from marking anything and an inbox would grow without
 * bound with no error anywhere to notice it. Absent is the untouched-behaviour
 * case, and absent is what is asserted — not `X-Rine-Peek: 0`, which the server
 * parses false and which would be equivalent on the wire but is not what the
 * default sends.
 *
 * `PEEK_HEADER` is imported from `@rine-network/core`, never retyped: the one
 * failure on this path that is silent rather than loud is a misspelled header
 * name — a client that misspells it gets an ordinary `200` and consumes every
 * row it believed it was deferring. `rine-core/test/message-words-twin.test.ts`
 * binds that spelling to the server's own constant.
 */

import { ACTING_AGENT_HEADER, PEEK_HEADER } from "@rine-network/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// The decrypt is not what this file is about: mocked so a fabricated envelope
// needs no key material and no config directory on disk.
vi.mock("./resources/decrypt.js", () => ({
	decryptEnvelope: vi.fn(async (opts: { msg: Record<string, unknown> }) => ({
		...opts.msg,
		plaintext: '{"ok":true}',
		verified: true,
		verification_status: "verified" as const,
		decrypt_error: null,
	})),
}));

const { AsyncRineClient } = await import("./client.js");
const { SDKHttpClient } = await import("./api/http.js");

type MessageUuid = import("./types.js").MessageUuid;
type CoreHttpClient = import("@rine-network/core").HttpClient;

const OPS_ID = "11111111-1111-4111-8111-111111111111";
const BOT_ID = "22222222-2222-4222-8222-222222222222";
const OPS = { id: OPS_ID, name: "ops", handle: "ops@acme.rine.network" };
const BOT = { id: BOT_ID, name: "bot", handle: "bot@acme.rine.network" };

const MESSAGE_ID = "44444444-4444-4444-8444-444444444444" as MessageUuid;

/** The wire row `GET /messages/{id}` answers with, before any decrypt. */
function messageRow(): Record<string, unknown> {
	return {
		id: MESSAGE_ID,
		conversation_id: "55555555-5555-4555-8555-555555555555",
		from_agent_id: BOT_ID,
		to_agent_id: OPS_ID,
		type: "rine.v1.task_request",
		encrypted_payload: "ENC(DM)",
		encryption_version: "hpke-v1",
		created_at: "2026-04-11T12:00:00Z",
		metadata: {},
	};
}

interface Harness {
	client: InstanceType<typeof AsyncRineClient>;
	/** Every GET the SDK layer issued, with the headers it declared. */
	gets: { path: string; headers: Record<string, string> | undefined }[];
}

/**
 * A real client whose org holds exactly `agents`, with the HTTP layer stubbed
 * at the class it delegates to — so the whole resolve-then-read ladder above it
 * runs, from the option a caller passes.
 */
function harness(agents: object[]): Harness {
	const gets: { path: string; headers: Record<string, string> | undefined }[] =
		[];
	vi.spyOn(SDKHttpClient.prototype, "getCoreHttpClient").mockReturnValue({
		get: async () => ({ items: agents, total: agents.length }),
	} as unknown as CoreHttpClient);
	vi.spyOn(SDKHttpClient.prototype, "get").mockImplementation((async (
		path: string,
		opts: { extraHeaders?: Record<string, string> } = {},
	) => {
		gets.push({ path, headers: opts.extraHeaders });
		return messageRow();
	}) as never);
	// An explicit configDir so nothing resolves one off the filesystem.
	const client = new AsyncRineClient({ configDir: "/tmp/rine-peek-read" });
	return { client, gets };
}

/** The one `GET /messages/{id}` a read issues. */
function theRead(h: Harness) {
	const read = h.gets.find((g) => g.path === `/messages/${MESSAGE_ID}`);
	expect(read).toBeDefined();
	return read as { path: string; headers: Record<string, string> | undefined };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("read({ peek: true })", () => {
	it("sends the peek header alongside the acting agent", async () => {
		const h = harness([OPS]);

		await h.client.read(MESSAGE_ID, { peek: true });

		expect(theRead(h).headers).toEqual({
			[ACTING_AGENT_HEADER]: OPS_ID,
			[PEEK_HEADER]: "1",
		});
	});

	it("still reads AS the resolved agent — peek suppresses the mark only", async () => {
		// The header has to name the agent whose key decrypts the envelope one
		// call later, and a peek does not change who that is. A handle goes out
		// resolved here for the same reason it does on a plain read.
		const h = harness([OPS, BOT]);

		await h.client.read(MESSAGE_ID, {
			agent: "bot@acme.rine.network",
			peek: true,
		});

		expect(theRead(h).headers).toEqual({
			[ACTING_AGENT_HEADER]: BOT_ID,
			[PEEK_HEADER]: "1",
		});
	});

	it("survives the client rung alongside a schema", async () => {
		// `read<T>()` strips `schema` and spreads the rest into the resource. A
		// rung that forwarded a named subset instead would drop `peek` here
		// while every other test in this file still passed.
		const h = harness([OPS]);
		const schema = {
			"~standard": {
				version: 1 as const,
				vendor: "test",
				validate: (value: unknown) => ({ value: value as { ok: boolean } }),
			},
		};

		const msg = await h.client.read(MESSAGE_ID, {
			peek: true,
			schema,
		});

		expect(theRead(h).headers?.[PEEK_HEADER]).toBe("1");
		// The schema stayed a client-rung concern and never reached the wire.
		expect(theRead(h).headers).not.toHaveProperty("schema");
		// And the schema still ran on the peeked row's plaintext.
		expect(msg.plaintext).toEqual({ ok: true });
	});
});

describe("a plain read", () => {
	it("sends no peek header at all", async () => {
		const h = harness([OPS]);

		await h.client.read(MESSAGE_ID);

		expect(theRead(h).headers).toEqual({ [ACTING_AGENT_HEADER]: OPS_ID });
		// Absent, not a false spelling: this is byte-for-byte the request the
		// SDK issued before peek existed.
		expect(theRead(h).headers).not.toHaveProperty(PEEK_HEADER);
	});

	it("sends no peek header when the caller asked for peek: false", async () => {
		const h = harness([OPS]);

		await h.client.read(MESSAGE_ID, { peek: false });

		expect(theRead(h).headers).toEqual({ [ACTING_AGENT_HEADER]: OPS_ID });
	});
});
