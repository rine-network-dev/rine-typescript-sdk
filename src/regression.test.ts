/** Regression tests for critical bug fixes in the SDK. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type WebFingerStub, stubWebFinger } from "./_webfinger-stub.js";

// ---------------------------------------------------------------------------
// Mock @rine-network/core BEFORE importing any SUT. Resource layer imports
// the real crypto/resolve functions at module load time.
// ---------------------------------------------------------------------------

// Core HTTP client stub. `get("/groups", { handle })` is exercised by the
// group send path, which resolves the group to inspect its `mls_group_id`
// latch. A null latch selects the legacy sender-key path (these regression
// tests assert sender-key behavior).
const CORE_HTTP_STUB = {
	__stub: "core",
	get: vi.fn(async () => ({
		items: [
			{
				id: "33333333-3333-4333-8333-333333333333",
				name: "dev",
				handle: "#dev@acme.rine.network",
				created_at: "2026-01-01T00:00:00Z",
				mls_group_id: null,
			},
		],
	})),
};

vi.mock("@rine-network/core", async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>;
	return {
		...original,
		// resolveSenderId path
		fetchAgents: vi.fn(async () => [
			{
				id: "11111111-1111-4111-8111-111111111111",
				handle: "me@acme.rine.network",
			},
		]),
		resolveAgent: vi.fn(async () => ({
			agentId: "11111111-1111-4111-8111-111111111111",
		})),
		// Recipient resolution
		resolveToUuid: vi.fn(async () => "22222222-2222-4222-8222-222222222222"),
		fetchRecipientKeys: vi.fn(async () => ({ encryption: new Uint8Array(32) })),
		// Encryption returns a body fragment the resource layer spreads.
		encryptMessage: vi.fn(async () => ({
			encrypted_payload: "ENC(DM)",
			encryption_version: "hpke-v1",
			sender_signing_kid: "sig-kid-1",
		})),
		encryptGroupMessage: vi.fn(async () => ({
			result: {
				encrypted_payload: "ENC(GROUP)",
				encryption_version: "sender-key-v1",
				sender_signing_kid: "sig-kid-grp",
			},
		})),
		getOrCreateSenderKey: vi.fn(async () => ({
			state: { __state: true },
			groupId: "33333333-3333-4333-8333-333333333333",
		})),
		// The downgrade guard reads real local MLS state off disk. These tests
		// pin routing, not the guard (`messages-send-downgrade.test.ts` does
		// that), and run with no config dir at all.
		assertNoMlsDowngrade: vi.fn(),
		// Decryption for the read block (read uses the bridge fallback for
		// sender-key retry; we never hit it because `decryptEnvelope` itself is
		// mocked — but keep these stubs so `decrypt.ts` can be imported
		// unchanged.)
		decryptMessage: vi.fn(),
		decryptGroupMessage: vi.fn(),
		fetchAndIngestPendingSKDistributions: vi.fn(),
	};
});

// Mock the local `decryptEnvelope` so inbox/read/sendAndWait tests can observe
// it being called without touching real crypto.
vi.mock("./resources/decrypt.js", () => ({
	decryptEnvelope: vi.fn(async (opts: { msg: Record<string, unknown> }) => ({
		...opts.msg,
		metadata: opts.msg.metadata ?? {},
		plaintext: "plaintext:ok",
		verified: true,
		verification_status: "verified" as const,
		decrypt_error: null,
	})),
}));

// SUT imports (after mocks are registered).
const { MessagesResource } = await import("./resources/messages.js");
const { IdentityResource } = await import("./resources/identity.js");
const { DiscoveryResource } = await import("./resources/discovery.js");
const core = await import("@rine-network/core");
const { ReplyAttributionError, RineError } = await import("./errors.js");
const decryptMod = await import("./resources/decrypt.js");

type SDKHttpClient = import("./api/http.js").SDKHttpClient;
type AgentUuid = import("./types.js").AgentUuid;
type GroupUuid = import("./types.js").GroupUuid;
type MessageUuid = import("./types.js").MessageUuid;
type AgentHandle = import("./types.js").AgentHandle;
type GroupHandle = import("./types.js").GroupHandle;

// ---------------------------------------------------------------------------
// HTTP stub — records every call site. Enough fields are populated to let
// MessagesResource/IdentityResource/DiscoveryResource drive through.
// ---------------------------------------------------------------------------

interface RecordedCall {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	body?: unknown;
	opts?: Record<string, unknown>;
}

interface StubResponses {
	get?: (path: string) => unknown;
	post?: (path: string, body: unknown) => unknown;
	put?: (path: string, body: unknown) => unknown;
	patch?: (path: string, body: unknown) => unknown;
	delete?: (path: string) => unknown;
}

function makeHttpStub(
	responses: StubResponses = {},
	configDir = "/tmp/fake-rine-sdk",
): { http: SDKHttpClient; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const stub = {
		apiUrl: "https://api.test.rine.network",
		configDir,
		agentHeader: { "X-Rine-Agent": "me@acme.rine.network" },
		timeout: 30_000,
		getCoreHttpClient: () => CORE_HTTP_STUB,
		async get<T>(p: string, opts?: Record<string, unknown>): Promise<T> {
			calls.push({ method: "GET", path: p, opts });
			const r = responses.get?.(p) ?? {};
			return r as T;
		},
		async post<T>(
			p: string,
			body?: unknown,
			opts?: Record<string, unknown>,
		): Promise<T> {
			calls.push({ method: "POST", path: p, body, opts });
			const r = responses.post?.(p, body) ?? {};
			return r as T;
		},
		async put<T>(
			p: string,
			body?: unknown,
			opts?: Record<string, unknown>,
		): Promise<T> {
			calls.push({ method: "PUT", path: p, body, opts });
			const r = responses.put?.(p, body) ?? {};
			return r as T;
		},
		async patch<T>(
			p: string,
			body?: unknown,
			opts?: Record<string, unknown>,
		): Promise<T> {
			calls.push({ method: "PATCH", path: p, body, opts });
			const r = responses.patch?.(p, body) ?? {};
			return r as T;
		},
		async delete<T>(p: string, opts?: Record<string, unknown>): Promise<T> {
			calls.push({ method: "DELETE", path: p, opts });
			const r = responses.delete?.(p) ?? undefined;
			return r as T;
		},
	} as unknown as SDKHttpClient;
	return { http: stub, calls };
}

// Standard MessageRead response from the server (post-encrypt).
function sampleMessageRead(
	over: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: "44444444-4444-4444-8444-444444444444",
		conversation_id: "55555555-5555-4555-8555-555555555555",
		from_agent_id: "11111111-1111-4111-8111-111111111111",
		to_agent_id: "22222222-2222-4222-8222-222222222222",
		type: "rine.v1.task_request",
		encrypted_payload: "ENC(DM)",
		encryption_version: "hpke-v1",
		created_at: "2026-04-11T12:00:00Z",
		metadata: {},
		...over,
	};
}

// Cursor-page wire shape expected by `parseCursorPage`.
function sampleInboxPage(items: unknown[]): Record<string, unknown> {
	return {
		items,
		total: items.length,
		next_cursor: null,
		prev_cursor: null,
	};
}

const SENDER_UUID = "11111111-1111-4111-8111-111111111111" as AgentUuid;
const RECIPIENT_UUID = "22222222-2222-4222-8222-222222222222" as AgentUuid;
// Shared by the identity blocks — distinct from SENDER_UUID so cross-block
// traces are easy to spot.
const AGENT_ID_7 = "77777777-7777-4777-8777-777777777777" as AgentUuid;

afterEach(() => {
	vi.clearAllMocks();
});

// ===========================================================================
// send() route + body
// ===========================================================================

describe("send() — route and body shape", () => {
	let webfinger: WebFingerStub;
	beforeEach(() => {
		webfinger = stubWebFinger({ "alice@acme.rine.network": RECIPIENT_UUID });
	});
	afterEach(() => webfinger.restore());

	it("POSTs to `/messages` with `to_agent_id` in the body (not `/messages/:to`)", async () => {
		const { http, calls } = makeHttpStub({
			post: () => sampleMessageRead(),
		});
		const messages = new MessagesResource(http);

		await messages.send("alice@acme.rine.network" as AgentHandle, {
			text: "hi",
		});

		// Exactly one POST to /messages (no path parameter).
		const postCalls = calls.filter((c) => c.method === "POST");
		expect(postCalls).toHaveLength(1);
		expect(postCalls[0]?.path).toBe("/messages");

		// Body carries to_agent_id (the resolved UUID from `resolveToUuid`) and
		// the encrypted envelope fields — NOT a raw `payload` plaintext.
		const body = postCalls[0]?.body as Record<string, unknown>;
		expect(body.to_agent_id).toBe(RECIPIENT_UUID);
		expect(body.encrypted_payload).toBe("ENC(DM)");
		expect(body.encryption_version).toBe("hpke-v1");
		expect(body).not.toHaveProperty("payload");
	});

	it("POSTs to `/messages` with `to_handle` for group sends (sender-key envelope)", async () => {
		const { http, calls } = makeHttpStub({
			post: () =>
				sampleMessageRead({
					encrypted_payload: "ENC(GROUP)",
					encryption_version: "sender-key-v1",
					group_handle: "#dev@acme.rine.network",
				}),
		});
		const messages = new MessagesResource(http);

		await messages.send("#dev@acme.rine.network" as never, { text: "hi" });

		const postCalls = calls.filter((c) => c.method === "POST");
		expect(postCalls[0]?.path).toBe("/messages");
		const body = postCalls[0]?.body as Record<string, unknown>;
		expect(body.to_handle).toBe("#dev@acme.rine.network");
		expect(body.encryption_version).toBe("sender-key-v1");
		expect(body).not.toHaveProperty("to_agent_id");
	});
});

// ===========================================================================
// Short-handle normalization — send()
// ===========================================================================

describe("send() — short-handle normalization", () => {
	// 🔴 Pinned on the WebFinger request, not on a mocked `resolveToUuid`.
	// `send()` resolves through the recipient contract, which calls the agent
	// resolver inside the core bundle — a `vi.mock` on the exported name is no
	// longer on the path, so it would go on passing while the product stopped
	// asking it. The claim these tests make has always been about the wire.
	let webfinger: WebFingerStub;
	beforeEach(() => {
		webfinger = stubWebFinger({
			"alice@acmecorp.rine.network": RECIPIENT_UUID,
		});
	});
	afterEach(() => webfinger.restore());

	it("short agent handle is normalized before the WebFinger lookup", async () => {
		// "alice@acmecorp" has no dot in the domain — normalizeHandle appends
		// ".rine.network" before the handle is looked up.
		const { http } = makeHttpStub({
			post: () => sampleMessageRead(),
		});
		const messages = new MessagesResource(http);

		await messages.send("alice@acmecorp" as AgentHandle, { text: "hi" });

		// The lookup must ask for the expanded handle, not the raw short form.
		expect(webfinger.resources).toEqual([
			"acct:alice@acmecorp.rine.network",
		]);
	});

	it("short group handle is normalized before getOrCreateSenderKey", async () => {
		// "#dev@acme" — short group handle, no dot in the domain. After
		// normalization it becomes "#dev@acme.rine.network", which isGroupHandle()
		// still matches, so the sender-key path is taken.
		//
		// 🔴 The org half is the one the stub's server actually holds, and it has
		// to be: everything downstream of the resolve now addresses the group the
		// SERVER returned rather than the spelling the caller wrote, so a fixture
		// asking for one org and answered with another would pin the expansion
		// against a handle no lookup could have produced.
		const { http, calls } = makeHttpStub({
			post: () =>
				sampleMessageRead({
					encrypted_payload: "ENC(GROUP)",
					encryption_version: "sender-key-v1",
					group_handle: "#dev@acme.rine.network",
				}),
		});
		const messages = new MessagesResource(http);

		await messages.send("#dev@acme" as any, { text: "hi group" });

		// getOrCreateSenderKey receives the normalized handle as its 4th argument.
		expect(core.getOrCreateSenderKey).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			expect.any(String),
			"#dev@acme.rine.network",
			expect.anything(),
		);

		// POST body carries the normalized handle in to_handle.
		const postCalls = calls.filter((c) => c.method === "POST");
		const body = postCalls[0]?.body as Record<string, unknown>;
		expect(body.to_handle).toBe("#dev@acme.rine.network");
	});

	it("full handle passes through without double-appending .rine.network", async () => {
		// A handle that already contains a dot in its domain must not receive
		// a second ".rine.network" suffix.
		const { http } = makeHttpStub({
			post: () => sampleMessageRead(),
		});
		const messages = new MessagesResource(http);

		await messages.send("alice@acmecorp.rine.network" as AgentHandle, {
			text: "hi",
		});

		expect(webfinger.resources).toEqual([
			"acct:alice@acmecorp.rine.network",
		]);
		// Confirm the suffix was NOT doubled.
		expect(webfinger.resources[0]).not.toContain(
			"rine.network.rine.network",
		);
	});
});

// ===========================================================================
// Short-handle normalization — sendAndWait()
// ===========================================================================

describe("sendAndWait() — short-handle normalization", () => {
	it("short agent handle is normalized in sendAndWait", async () => {
		// sendAndWait delegates to buildSendBody which calls normalizeHandle,
		// so the short handle should reach resolveToUuid fully expanded.
		const CONV_ID = "55555555-5555-4555-8555-555555555555";
		const { http, calls } = makeHttpStub({
			post: (p) => {
				if (p === "/messages/sync") {
					return {
						message: sampleMessageRead({ conversation_id: CONV_ID }),
						reply: null,
						conversation_id: CONV_ID,
						status: "timeout",
					};
				}
				return {};
			},
		});
		const messages = new MessagesResource(http);

		await messages.sendAndWait("bob@myorg" as AgentHandle, { text: "sync" });

		// resolveToUuid must receive the fully-qualified handle.
		expect(core.resolveToUuid).toHaveBeenCalledWith(
			expect.any(String),
			"bob@myorg.rine.network",
		);

		// The POST must go to /messages/sync (not /messages).
		const postCalls = calls.filter((c) => c.method === "POST");
		expect(postCalls).toHaveLength(1);
		expect(postCalls[0]?.path).toBe("/messages/sync");
	});

	it("short group handle is rejected by sendAndWait", async () => {
		// sendAndWait classifies the raw (pre-normalization) spelling before
		// entering buildSendBody, and `classifyReference` reads the sigil alone —
		// so a short-form `#team@acme` is refused here for the same reason
		// `#team` and `#team@acme.rine.network` are, rather than for the org half
		// `GROUP_HANDLE_RE` used to insist on.
		const { http } = makeHttpStub({});
		const messages = new MessagesResource(http);

		await expect(
			messages.sendAndWait("#team@acme" as any, { text: "hi" }),
		).rejects.toThrow("does not support group handles");
	});
});

// ===========================================================================
// inbox() decryption
// ===========================================================================

describe("inbox() — per-envelope decryption", () => {
	it("dispatches decryptEnvelope for every returned item", async () => {
		const items = [
			sampleMessageRead({
				id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			}),
			sampleMessageRead({
				id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			}),
			sampleMessageRead({
				id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			}),
		];
		const { http, calls } = makeHttpStub({
			get: () => sampleInboxPage(items),
		});
		const messages = new MessagesResource(http);

		const page = await messages.inbox();

		// Route is scoped to the resolved sender agent.
		const getCalls = calls.filter((c) => c.method === "GET");
		expect(getCalls).toHaveLength(1);
		expect(getCalls[0]?.path).toBe(`/agents/${SENDER_UUID}/messages`);

		// One decrypt call per item.
		expect(decryptMod.decryptEnvelope).toHaveBeenCalledTimes(items.length);
		// Each call must receive the matching envelope, not the same item
		// repeated or the items out of order.
		const decryptCalls = (
			decryptMod.decryptEnvelope as ReturnType<typeof vi.fn>
		).mock.calls;
		const passedIds = decryptCalls.map(
			(c) => (c[0] as { msg: { id: string } }).msg.id,
		);
		expect(passedIds).toEqual(items.map((item) => item.id));

		expect(page.items).toHaveLength(items.length);
		for (const msg of page.items) {
			expect(msg.plaintext).toBe("plaintext:ok");
			expect(msg.decrypt_error).toBeNull();
		}
	});

	it("asks for sender-key/MLS recovery on every item, like read() does", async () => {
		// `inbox()` used to decrypt without recovery, so a group row whose
		// key material had not been ingested yet came back
		// `decrypt_error: "unknown sender key id: …"` and never self-healed —
		// while `read()` on the same row recovered and returned plaintext.
		const groupRow = sampleMessageRead({
			id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			encryption_version: "sender-key-v1",
			encrypted_payload: "ENC(GROUP)",
			group_id: "33333333-3333-4333-8333-333333333333",
		});
		const { http } = makeHttpStub({ get: () => sampleInboxPage([groupRow]) });
		const messages = new MessagesResource(http);

		const page = await messages.inbox();

		const opts = (decryptMod.decryptEnvelope as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as { retrySenderKey?: boolean };
		expect(opts.retrySenderKey).toBe(true);
		expect(page.items[0]?.plaintext).toBe("plaintext:ok");
		expect(page.items[0]?.decrypt_error).toBeNull();
	});
});

// ===========================================================================
// inbox({ status }) filter
// ===========================================================================

describe("inbox({ status }) — status query param", () => {
	it("adds status=new to the GET messages query when status is provided", async () => {
		const { http, calls } = makeHttpStub({
			get: () => sampleInboxPage([]),
		});
		const messages = new MessagesResource(http);

		await messages.inbox({ status: "new" });

		const getCall = calls.find((c) => c.method === "GET");
		expect(getCall?.path).toBe(`/agents/${SENDER_UUID}/messages`);
		const params = (getCall?.opts as { params: Record<string, unknown> })
			.params;
		expect(params.status).toBe("new");
	});

	it("sends no status param when status is omitted (back-compat)", async () => {
		const { http, calls } = makeHttpStub({
			get: () => sampleInboxPage([]),
		});
		const messages = new MessagesResource(http);

		await messages.inbox();

		const getCall = calls.find((c) => c.method === "GET");
		const params = (getCall?.opts as { params: Record<string, unknown> })
			.params;
		// `status` resolves to `undefined` and `buildUrl` strips undefined
		// params before they reach the wire — no `?status=` query is emitted.
		expect(params.status).toBeUndefined();
	});
});

// ===========================================================================
// markDelivered() route + body
// ===========================================================================

describe("markDelivered() — route and body", () => {
	it("POSTs { message_ids } to the agent-scoped mark-delivered route and returns the server count", async () => {
		const ids = [
			"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		] as MessageUuid[];
		const { http, calls } = makeHttpStub({
			post: () => ({ marked: 2 }),
		});
		const messages = new MessagesResource(http);

		const marked = await messages.markDelivered(ids, { agent: "me@acme" });

		const postCall = calls.find((c) => c.method === "POST");
		expect(postCall?.path).toBe(
			`/agents/${SENDER_UUID}/messages/mark-delivered`,
		);
		expect(postCall?.body).toEqual({ message_ids: ids });
		// Acting agent threads through as the X-Rine-Agent override header — as
		// the id the short-form handle resolved to in this org's own agents,
		// which is the same id the route in the path was built from. The two
		// used to be able to disagree: the path carried the resolved id and the
		// header carried the caller's handle.
		expect(
			(postCall?.opts as { extraHeaders?: Record<string, string> })
				.extraHeaders,
		).toMatchObject({ "X-Rine-Agent": SENDER_UUID });
		expect(marked).toBe(2);
	});

	it("is idempotent — re-marking already-delivered ids returns 0 newly-marked", async () => {
		const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] as MessageUuid[];
		// Server returns the count of messages it *newly* transitioned; a second
		// call over the same ids transitions nothing.
		const { http } = makeHttpStub({
			post: () => ({ marked: 0 }),
		});
		const messages = new MessagesResource(http);

		const marked = await messages.markDelivered(ids);

		expect(marked).toBe(0);
	});

	it("defaults a missing `marked` field to 0", async () => {
		const { http } = makeHttpStub({
			post: () => ({}),
		});
		const messages = new MessagesResource(http);

		const marked = await messages.markDelivered([
			"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		] as MessageUuid[]);

		expect(marked).toBe(0);
	});
});

// ===========================================================================
// The acting agent as the caller spelled it
// ===========================================================================

describe("X-Rine-Agent — the per-call actor's spelling", () => {
	let webfinger: WebFingerStub;
	beforeEach(() => {
		webfinger = stubWebFinger({ "alice@acme.rine.network": RECIPIENT_UUID });
	});
	afterEach(() => webfinger.restore());

	// `resolveSenderId` has always accepted a bare name on this stack: it is the
	// spelling every actor refusal prints, and it is what decrypts. The header
	// was then built from the RAW value, and `X-Rine-Agent` takes a UUID or a
	// handle only (`src/rine/api/agent_identity.py`) — so naming an agent the way
	// the SDK asked for it turned a send into a 422 while the same call had
	// already resolved the id it needed. What goes out is now the resolved id for
	// a bare name AND for a handle — both are looked up in this org's own agents,
	// because an acting agent must be an agent the caller owns — and the caller's
	// own spelling only for a UUID, which is already an agent id.

	it("sends a bare agent name on send() as the id it resolved to", async () => {
		const { http, calls } = makeHttpStub({ post: () => sampleMessageRead() });

		await new MessagesResource(http).send(
			"alice@acme.rine.network" as AgentHandle,
			{ text: "hi" },
			{ agent: "ops" },
		);

		const post = calls.find((c) => c.method === "POST");
		expect(
			(post?.opts as { extraHeaders?: Record<string, string> }).extraHeaders,
		).toMatchObject({ "X-Rine-Agent": SENDER_UUID });
	});

	it("sends a handle as the id it resolved to in this org's own agents", async () => {
		// This pinned the opposite until the actor slot stopped asking WebFinger
		// who owns a handle. The header does take a handle — but taking it only
		// moved the ownership question to the server, which answers a handle it
		// cannot place with a 422 naming no agent. Resolving it here costs the
		// same `GET /agents` a bare name already costs, and refuses by name.
		const { http, calls } = makeHttpStub({ post: () => sampleMessageRead() });

		await new MessagesResource(http).send(
			"alice@acme.rine.network" as AgentHandle,
			{ text: "hi" },
			{ agent: "sibling@acme.rine.network" },
		);

		const post = calls.find((c) => c.method === "POST");
		expect(
			(post?.opts as { extraHeaders?: Record<string, string> }).extraHeaders,
		).toMatchObject({ "X-Rine-Agent": SENDER_UUID });
	});

	it("sends a UUID exactly as the caller typed it — it is already an agent id", async () => {
		// The one spelling the wire reads as an id without a lookup. Overriding
		// it with whatever the surrounding call resolved would silently retarget
		// the request to a different agent than the caller named.
		const OTHER_UUID = "99999999-9999-4999-8999-999999999999";
		const { http, calls } = makeHttpStub({ post: () => sampleMessageRead() });

		await new MessagesResource(http).send(
			"alice@acme.rine.network" as AgentHandle,
			{ text: "hi" },
			{ agent: OTHER_UUID },
		);

		const post = calls.find((c) => c.method === "POST");
		expect(
			(post?.opts as { extraHeaders?: Record<string, string> }).extraHeaders,
		).toMatchObject({ "X-Rine-Agent": OTHER_UUID });
	});

	it("resolves the name on inbox() and markDelivered() too", async () => {
		// Neither route reads the header today, which is exactly why they drift:
		// they are the two calls the phase's harnesses make most, and a header
		// that is inert now is a 422 the day the route starts reading it.
		const inbox = makeHttpStub({ get: () => sampleInboxPage([]) });
		await new MessagesResource(inbox.http).inbox({ agent: "ops" });

		const get = inbox.calls.find((c) => c.method === "GET");
		expect(
			(get?.opts as { extraHeaders?: Record<string, string> }).extraHeaders,
		).toMatchObject({ "X-Rine-Agent": SENDER_UUID });

		const marked = makeHttpStub({ post: () => ({ marked: 1 }) });
		await new MessagesResource(marked.http).markDelivered(
			["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] as MessageUuid[],
			{ agent: "ops" },
		);

		const post = marked.calls.find((c) => c.method === "POST");
		expect(
			(post?.opts as { extraHeaders?: Record<string, string> }).extraHeaders,
		).toMatchObject({ "X-Rine-Agent": SENDER_UUID });
	});
});

// ===========================================================================
// read() decryption
// ===========================================================================

describe("read() — single-message decryption", () => {
	it("dispatches decryptEnvelope with retrySenderKey enabled", async () => {
		const { http, calls } = makeHttpStub({
			get: () => sampleMessageRead(),
		});
		const messages = new MessagesResource(http);

		const msg = await messages.read(
			"44444444-4444-4444-8444-444444444444" as MessageUuid,
		);

		expect(
			calls.find(
				(c) =>
					c.method === "GET" &&
					c.path === "/messages/44444444-4444-4444-8444-444444444444",
			),
		).toBeDefined();
		expect(decryptMod.decryptEnvelope).toHaveBeenCalledTimes(1);
		const envOpts = (decryptMod.decryptEnvelope as ReturnType<typeof vi.fn>)
			.mock.calls[0]?.[0] as { retrySenderKey?: boolean };
		expect(envOpts.retrySenderKey).toBe(true);
		expect(msg.plaintext).toBe("plaintext:ok");
	});

	it("names the resolved reader on the GET, so the read marks its own row", async () => {
		// The server marks the delivery row of the agent the header names
		// and no sibling's, so an unheadered read from a multi-agent org shows
		// the message and leaves it queued forever. The RESOLVED id, never the
		// `me@acme.rine.network` handle this client carries: `X-Rine-Agent` is
		// resolved server-side and a spelling it refuses is a 422, not a mark.
		const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
		const { http, calls } = makeHttpStub({
			get: () => sampleMessageRead(),
		});
		const messages = new MessagesResource(http);

		await messages.read(MESSAGE_ID as MessageUuid);

		const read = calls.find(
			(c) => c.method === "GET" && c.path === `/messages/${MESSAGE_ID}`,
		);
		expect(read?.opts?.extraHeaders).toEqual({
			"X-Rine-Agent": SENDER_UUID,
		});
	});
});

// ===========================================================================
// reply() encryption
// ===========================================================================

describe("reply() — encrypts to original sender", () => {
	// Install the rine-core bridge `get()` on the shared stub in beforeEach
	// and remove it in afterEach so a mid-test throw can never leak state
	// into sibling test blocks.
	beforeEach(() => {
		const originalMsg = sampleMessageRead({
			id: "44444444-4444-4444-8444-444444444444",
			from_agent_id: RECIPIENT_UUID, // original sender = our reply recipient
			to_agent_id: SENDER_UUID,
		});
		(CORE_HTTP_STUB as Record<string, unknown>).get = vi
			.fn()
			.mockResolvedValue(originalMsg);
	});
	afterEach(() => {
		delete (CORE_HTTP_STUB as Record<string, unknown>).get;
	});

	it("encrypts to the original sender and POSTs to `/messages/{id}/reply`", async () => {
		const ORIGINAL_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";

		const { http, calls } = makeHttpStub({
			post: () =>
				sampleMessageRead({
					type: "rine.v1.task_response",
				}),
		});
		const messages = new MessagesResource(http);

		await messages.reply(ORIGINAL_MESSAGE_ID as MessageUuid, { text: "ack" });

		// encryptMessage must have been called with the original sender's
		// recipient public key — that's the whole point of the fix.
		expect(core.encryptMessage).toHaveBeenCalledTimes(1);
		expect(core.fetchRecipientKeys).toHaveBeenCalledWith(
			CORE_HTTP_STUB,
			RECIPIENT_UUID,
		);

		// The POST body carries the encrypted envelope (spread), not `payload`.
		const postCall = calls.find((c) => c.method === "POST");
		expect(postCall?.path).toBe(`/messages/${ORIGINAL_MESSAGE_ID}/reply`);
		const body = postCall?.body as Record<string, unknown>;
		expect(body.encrypted_payload).toBe("ENC(DM)");
		expect(body.encryption_version).toBe("hpke-v1");
		expect(body).not.toHaveProperty("payload");
	});

	it("names the reader on the GET, so answering a message also marks it delivered", async () => {
		// The fetch of the original is a read like any other: the server marks
		// the ACTING agent's delivery row and marks nothing at all when
		// the caller names nobody. Unheadered, a multi-agent org could answer a
		// message and leave it queued forever — the reply is proof it was read.
		const ORIGINAL_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
		const { http } = makeHttpStub({
			post: () => sampleMessageRead({ type: "rine.v1.task_response" }),
		});
		const messages = new MessagesResource(http);

		await messages.reply(ORIGINAL_MESSAGE_ID as MessageUuid, { text: "ack" });

		// The RESOLVED id, not the `me@acme.rine.network` handle the client was
		// constructed with: a header the server cannot resolve is a 422, not a
		// silently unmarked read.
		const getCall = vi.mocked(
			CORE_HTTP_STUB.get as (
				p: string,
				params?: unknown,
				headers?: Record<string, string>,
			) => unknown,
		).mock.calls[0];
		expect(getCall?.[0]).toBe(`/messages/${ORIGINAL_MESSAGE_ID}`);
		expect(getCall?.[2]).toEqual({ "X-Rine-Agent": SENDER_UUID });
	});
});

// ===========================================================================
// reply() skips foreign `to_agent_id` hints
// ===========================================================================

describe("reply() — foreign to_agent_id handling", () => {
	// Scenario: Alice sends a message to Bob, then fetches it and calls
	// `reply()` on her own message. The original carries
	//    from_agent_id = SENDER_UUID (Alice — us)
	//    to_agent_id   = RECIPIENT_UUID (Bob — foreign)
	// Previously, `senderHint` picked `to_agent_id` unconditionally, and
	// `resolveSenderId()` threw "not owned by current org" because Bob is
	// not in Alice's agents list. Post-fix, the foreign `to_agent_id` is
	// skipped, the caller's default agent is used, and the existing
	// "cannot reply to your own message" guard fires — producing a clear
	// SDK-level error instead of the confusing ownership exception.
	it("ignores original.to_agent_id when it is not in the caller's org", async () => {
		const ORIGINAL_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";

		// Install a bridge `get()` that returns an Alice-sent original.
		(CORE_HTTP_STUB as Record<string, unknown>).get = vi.fn().mockResolvedValue(
			sampleMessageRead({
				id: ORIGINAL_MESSAGE_ID,
				from_agent_id: SENDER_UUID, // Alice (us) sent it
				to_agent_id: RECIPIENT_UUID, // Bob (foreign)
			}),
		);

		const { http } = makeHttpStub({
			post: () => sampleMessageRead({ type: "rine.v1.task_response" }),
		});
		const messages = new MessagesResource(http);

		await expect(
			messages.reply(ORIGINAL_MESSAGE_ID as MessageUuid, { text: "self" }),
		).rejects.toThrow(/Cannot reply to your own message/);

		// Verify: `resolveAgent` was NOT handed the foreign RECIPIENT_UUID as
		// a hint. The fallback should resolve to the default agent header.
		// The hint is the SECOND argument — `resolveAgent(agents, hint, …)`;
		// it lost the leading `apiUrl` when the actor slot stopped being able
		// to reach WebFinger at all.
		const calls = vi.mocked(core.resolveAgent).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		for (const [, hint] of calls) {
			expect(hint).not.toBe(RECIPIENT_UUID);
		}

		delete (CORE_HTTP_STUB as Record<string, unknown>).get;
	});

	it("refuses to reply as an agent the original was not addressed to", async () => {
		// The org owns two agents; the message landed in the sibling's
		// mailbox, and the caller named the other one. This used to encrypt
		// under the named agent and POST anyway — a 201 whose attribution the
		// caller never chose. It now refuses, and the refusal NAMES the
		// addressee, because "which agent should I have been" is the only
		// question the caller has.
		const ORIGINAL_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
		const SIBLING_UUID = "55555555-5555-4555-8555-555555555555";

		vi.mocked(core.fetchAgents).mockResolvedValueOnce([
			{ id: SENDER_UUID, handle: "me@acme.rine.network" },
			{ id: SIBLING_UUID, handle: "sibling@acme.rine.network" },
		] as never);
		(CORE_HTTP_STUB as Record<string, unknown>).get = vi.fn().mockResolvedValue(
			sampleMessageRead({
				id: ORIGINAL_MESSAGE_ID,
				from_agent_id: RECIPIENT_UUID, // the peer wrote it
				to_agent_id: SIBLING_UUID, // …to our OTHER agent
			}),
		);

		const { http, calls } = makeHttpStub({
			post: () => sampleMessageRead({ type: "rine.v1.task_response" }),
		});
		const messages = new MessagesResource(http);

		const refusal = await messages
			.reply(ORIGINAL_MESSAGE_ID as MessageUuid, { text: "ack" })
			.catch((e: unknown) => e);

		// Typed, like the Python SDK's twin, and carrying the three ids as
		// fields: a caller retries as the addressee without parsing a sentence,
		// and the SDK-wide `catch (e) { if (e instanceof RineError) … }` sees it
		// — a bare `Error` would have escaped exactly that catch.
		expect(refusal).toBeInstanceOf(ReplyAttributionError);
		expect(refusal).toBeInstanceOf(RineError);
		expect((refusal as InstanceType<typeof ReplyAttributionError>).addresseeAgentId).toBe(
			SIBLING_UUID,
		);
		expect(String(refusal)).toContain(SIBLING_UUID);

		// Refused before the encrypt, and nothing was posted.
		expect(calls.find((c) => c.method === "POST")).toBeUndefined();

		delete (CORE_HTTP_STUB as Record<string, unknown>).get;
	});

	it("keeps honouring original.to_agent_id when it IS in the caller's org", async () => {
		// Positive regression: Bob (us) replying to Alice's message — the
		// original's `to_agent_id` is our own agent, so the hint is still
		// used. This path must not regress.
		const ORIGINAL_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";

		(CORE_HTTP_STUB as Record<string, unknown>).get = vi.fn().mockResolvedValue(
			sampleMessageRead({
				id: ORIGINAL_MESSAGE_ID,
				from_agent_id: RECIPIENT_UUID, // Alice (peer)
				to_agent_id: SENDER_UUID, // Bob (us)
			}),
		);

		const { http, calls } = makeHttpStub({
			post: () => sampleMessageRead({ type: "rine.v1.task_response" }),
		});
		const messages = new MessagesResource(http);

		await messages.reply(ORIGINAL_MESSAGE_ID as MessageUuid, { text: "ack" });

		const postCall = calls.find((c) => c.method === "POST");
		expect(postCall?.path).toBe(`/messages/${ORIGINAL_MESSAGE_ID}/reply`);

		delete (CORE_HTTP_STUB as Record<string, unknown>).get;
	});
});

// ===========================================================================
// sendAndWait() atomic /messages/sync contract
// ===========================================================================

describe("sendAndWait() — atomic sync with decryption", () => {
	it("POSTs encrypted body to `/messages/sync` (single call, not two-phase)", async () => {
		const CONV_ID = "55555555-5555-4555-8555-555555555555";
		const REPLY_ID = "66666666-6666-4666-8666-666666666666";

		const { http, calls } = makeHttpStub({
			post: (p) => {
				if (p === "/messages/sync") {
					return {
						message: sampleMessageRead({ conversation_id: CONV_ID }),
						reply: sampleMessageRead({
							id: REPLY_ID,
							conversation_id: CONV_ID,
							from_agent_id: RECIPIENT_UUID,
							to_agent_id: SENDER_UUID,
							type: "rine.v1.task_response",
						}),
						conversation_id: CONV_ID,
						status: "completed",
					};
				}
				return {};
			},
		});
		const messages = new MessagesResource(http);

		const result = await messages.sendAndWait(
			"alice@acme.rine.network" as AgentHandle,
			{ text: "ping" },
		);

		// Single POST to /messages/sync — the encrypted body goes directly.
		const postCalls = calls.filter((c) => c.method === "POST");
		expect(postCalls).toHaveLength(1);
		expect(postCalls[0]?.path).toBe("/messages/sync");
		// Body is the full encrypted MessageCreate, not {conversation_id}.
		expect(postCalls[0]?.body).toHaveProperty("encrypted_payload");
		expect(postCalls[0]?.body).toHaveProperty("type");

		// Sent message parsed from response.message.
		expect(result.sent.conversation_id).toBe(CONV_ID);

		// Reply was decrypted through the helper.
		expect(decryptMod.decryptEnvelope).toHaveBeenCalled();
		expect(result.reply?.id).toBe(REPLY_ID);
		expect(result.reply?.plaintext).toBe("plaintext:ok");
	});

	it("returns `reply: null` on long-poll timeout (server reply = null)", async () => {
		const CONV_ID = "55555555-5555-4555-8555-555555555555";

		const { http } = makeHttpStub({
			post: (p) => {
				if (p === "/messages/sync") {
					return {
						message: sampleMessageRead({ conversation_id: CONV_ID }),
						reply: null,
						conversation_id: CONV_ID,
						status: "timeout",
					};
				}
				return {};
			},
		});
		const messages = new MessagesResource(http);

		const result = await messages.sendAndWait(
			"alice@acme.rine.network" as AgentHandle,
			{ text: "ping" },
		);

		expect(result.reply).toBeNull();
		expect(result.sent.conversation_id).toBe(CONV_ID);
	});

	it("rejects group handles (server does not support group sync)", async () => {
		const { http } = makeHttpStub({});
		const messages = new MessagesResource(http);

		await expect(
			messages.sendAndWait("#team@acme.rine.network" as GroupHandle, {
				text: "nope",
			}),
		).rejects.toThrow("does not support group handles");
	});
});

// ===========================================================================
// createAgent keypair generation (smoke; full coverage in identity.test.ts)
// ===========================================================================

describe("createAgent() — local keypair generation", () => {
	let configDir: string;
	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "rine-c6-"));
	});
	afterEach(() => {
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	it("posts public JWKs (not private) and writes private keys under configDir/keys/", async () => {
		// Reset @rine-network/core back to the REAL implementation for this
		// test by importing from vi.importActual — the file-level vi.mock
		// replaces it with our stubs. We only need the real keygen/persist
		// helpers to validate the fix.
		const real =
			await vi.importActual<typeof import("@rine-network/core")>(
				"@rine-network/core",
			);
		// Override the three functions IdentityResource.createAgent needs.
		vi.spyOn(core, "generateAgentKeys").mockImplementation(
			real.generateAgentKeys,
		);
		vi.spyOn(core, "signingPublicKeyToJWK").mockImplementation(
			real.signingPublicKeyToJWK,
		);
		vi.spyOn(core, "encryptionPublicKeyToJWK").mockImplementation(
			real.encryptionPublicKeyToJWK,
		);
		vi.spyOn(core, "saveAgentKeys").mockImplementation(real.saveAgentKeys);

		const { http, calls } = makeHttpStub(
			{
				post: () => ({
					id: AGENT_ID_7,
					name: "alice",
					handle: "alice@acme.rine.network",
					human_oversight: true,
					incoming_policy: "accept_all",
					outgoing_policy: "send_all",
					created_at: "2026-04-11T12:00:00Z",
				}),
			},
			configDir,
		);
		const identity = new IdentityResource(http);
		await identity.createAgent("alice");

		const postCall = calls.find((c) => c.method === "POST");
		const body = postCall?.body as Record<string, unknown>;
		// Both JWKs posted — `createAgent` must generate and include them.
		const sigJwk = body.signing_public_key as Record<string, unknown>;
		const encJwk = body.encryption_public_key as Record<string, unknown>;
		expect(sigJwk.crv).toBe("Ed25519");
		expect(encJwk.crv).toBe("X25519");
		expect(sigJwk).not.toHaveProperty("d");
		expect(encJwk).not.toHaveProperty("d");

		// Private half persisted.
		expect(
			fs.existsSync(path.join(configDir, "keys", AGENT_ID_7, "signing.key")),
		).toBe(true);
		expect(
			fs.existsSync(path.join(configDir, "keys", AGENT_ID_7, "encryption.key")),
		).toBe(true);
	});
});

// ===========================================================================
// rotateKeys route + body (smoke; full coverage in identity.test.ts)
// ===========================================================================

describe("rotateKeys() — route and body", () => {
	it("POSTs to `/agents/{id}/keys` with both public JWKs in the body", async () => {
		const real =
			await vi.importActual<typeof import("@rine-network/core")>(
				"@rine-network/core",
			);
		vi.spyOn(core, "generateAgentKeys").mockImplementation(
			real.generateAgentKeys,
		);
		vi.spyOn(core, "signingPublicKeyToJWK").mockImplementation(
			real.signingPublicKeyToJWK,
		);
		vi.spyOn(core, "encryptionPublicKeyToJWK").mockImplementation(
			real.encryptionPublicKeyToJWK,
		);
		vi.spyOn(core, "saveAgentKeys").mockImplementation(() => undefined);

		const { http, calls } = makeHttpStub(
			{
				post: () => ({
					id: AGENT_ID_7,
					name: "alice",
					handle: "alice@acme.rine.network",
					human_oversight: true,
					incoming_policy: "accept_all",
					outgoing_policy: "send_all",
					created_at: "2026-04-11T12:00:00Z",
				}),
			},
			"/tmp/fake-rine-rotate",
		);
		const identity = new IdentityResource(http);
		await identity.rotateKeys(AGENT_ID_7);

		const postCall = calls.find((c) => c.method === "POST");
		expect(postCall?.path).toBe(`/agents/${AGENT_ID_7}/keys`);
		const body = postCall?.body as Record<string, unknown>;
		expect(body).toHaveProperty("signing_public_key");
		expect(body).toHaveProperty("encryption_public_key");
	});
});

// ===========================================================================
// regeneratePollToken route
// ===========================================================================

describe("regeneratePollToken() — correct route", () => {
	it("POSTs to `/agents/{id}/poll-token` (no `/regenerate` suffix, no body)", async () => {
		const { http, calls } = makeHttpStub({
			post: () => ({
				agent_id: AGENT_ID_7,
				poll_url: "https://api.test/poll",
				token: "abc123",
				expires_at: "2026-04-12T12:00:00Z",
			}),
		});
		const identity = new IdentityResource(http);
		await identity.regeneratePollToken(AGENT_ID_7);

		const postCall = calls.find((c) => c.method === "POST");
		expect(postCall?.path).toBe(`/agents/${AGENT_ID_7}/poll-token`);
		// Ensure no `/regenerate` suffix is appended — the route is just
		// `/agents/{id}/poll-token`.
		expect(postCall?.path).not.toContain("/regenerate");
		// No request body — the server derives the new token server-side.
		expect(postCall?.body).toBeUndefined();
	});
});

// ===========================================================================
// setAgentCard rine sub-object nesting
// ===========================================================================

describe("setAgentCard() — rine field nesting", () => {
	it("nests categories/languages/pricing_model inside `rine`, keeps top-level fields flat", async () => {
		const { http, calls } = makeHttpStub({
			put: (_p, body) => {
				const b = body as { rine?: Record<string, unknown> };
				return {
					id: "88888888-8888-4888-8888-888888888888",
					agent_id: AGENT_ID_7,
					name: "test",
					description: "desc",
					is_public: true,
					skills: [],
					rine: b.rine ?? {},
					created_at: "2026-04-11T12:00:00Z",
				};
			},
		});
		const identity = new IdentityResource(http);

		await identity.setAgentCard(AGENT_ID_7, {
			name: "AgentName",
			description: "A description",
			version: "1.0.0",
			is_public: true,
			skills: [{ id: "s1", name: "skill", description: "d" }],
			categories: ["productivity"],
			languages: ["en", "fr"],
			pricing_model: "free",
		});

		const putCall = calls.find((c) => c.method === "PUT");
		expect(putCall?.path).toBe(`/agents/${AGENT_ID_7}/card`);
		const body = putCall?.body as Record<string, unknown>;

		// Top-level fields stay flat.
		expect(body.name).toBe("AgentName");
		expect(body.description).toBe("A description");
		expect(body.version).toBe("1.0.0");
		expect(body.is_public).toBe(true);
		expect(Array.isArray(body.skills)).toBe(true);

		// rine-specific fields MUST be nested under `rine` — flattening them
		// would cause the server to silently drop the values.
		const rine = body.rine as Record<string, unknown>;
		expect(rine).toBeDefined();
		expect(rine.categories).toEqual(["productivity"]);
		expect(rine.languages).toEqual(["en", "fr"]);
		expect(rine.pricing_model).toBe("free");

		// Those fields must NOT leak to the top level.
		expect(body).not.toHaveProperty("categories");
		expect(body).not.toHaveProperty("languages");
		expect(body).not.toHaveProperty("pricing_model");
	});

	it("omits the `rine` object entirely when no rine-specific fields are supplied", async () => {
		const { http, calls } = makeHttpStub({
			put: () => ({
				id: "88888888-8888-4888-8888-888888888888",
				agent_id: AGENT_ID_7,
				name: "Bare",
				description: "Bare",
				is_public: false,
				skills: [],
				rine: {},
				created_at: "2026-04-11T12:00:00Z",
			}),
		});
		const identity = new IdentityResource(http);
		await identity.setAgentCard(AGENT_ID_7, {
			name: "Bare",
			description: "Bare",
		});

		const body = calls.find((c) => c.method === "PUT")?.body as Record<
			string,
			unknown
		>;
		expect(body).not.toHaveProperty("rine");
	});
});

// ===========================================================================
// inspect() A2A card unwrap
// ===========================================================================

describe("inspect() — A2A card envelope unwrapping", () => {
	it("reads `rine.agent_id` / `rine.handle` / top-level `card.name`+`card.description`", async () => {
		const AGENT_ID = "99999999-9999-4999-8999-999999999999";
		const envelope = {
			card: {
				name: "TestAgent",
				description: "A wrapped agent",
				rine: {
					agent_id: AGENT_ID,
					handle: "wrapped@acme.rine.network",
					category: "productivity",
					verified: true,
					human_oversight: true,
				},
			},
			directory_metadata: { registered_at: "2026-01-01T00:00:00Z" },
		};
		const { http } = makeHttpStub({ get: () => envelope });
		const discovery = new DiscoveryResource(http);

		const profile = await discovery.inspect("wrapped@acme.rine.network");

		expect(profile.id).toBe(AGENT_ID);
		expect(profile.name).toBe("TestAgent");
		expect(profile.handle).toBe("wrapped@acme.rine.network");
		expect(profile.description).toBe("A wrapped agent");
		expect(profile.category).toBe("productivity");
		expect(profile.verified).toBe(true);
		expect(profile.created_at).toBe("2026-01-01T00:00:00Z");
	});

	it("falls through to legacy flat shape when `card` envelope is absent", async () => {
		const AGENT_ID = "99999999-9999-4999-8999-999999999999";
		const flat = {
			id: AGENT_ID,
			name: "Flat",
			handle: "flat@acme.rine.network",
			description: "Legacy flat",
			category: null,
			verified: false,
			human_oversight: true,
			created_at: "2026-01-01T00:00:00Z",
		};
		const { http } = makeHttpStub({ get: () => flat });
		const discovery = new DiscoveryResource(http);

		const profile = await discovery.inspect("flat@acme.rine.network");
		expect(profile.id).toBe(AGENT_ID);
		expect(profile.name).toBe("Flat");
		expect(profile.verified).toBe(false);
	});
});

// ===========================================================================
// inspect() resolves handle to UUID
// ===========================================================================

describe("inspect() — handle resolution", () => {
	it("resolves agent handles to UUIDs before hitting /directory/agents", async () => {
		const UUID = "22222222-2222-4222-8222-222222222222";
		const { http, calls } = makeHttpStub({
			get: () => ({
				id: UUID,
				name: "Alice",
				handle: "alice@acme.rine.network",
				description: null,
				category: null,
				verified: false,
				human_oversight: true,
				created_at: "2026-01-01T00:00:00Z",
			}),
		});
		const discovery = new DiscoveryResource(http);

		await discovery.inspect("alice@acme.rine.network");

		// The mocked `resolveToUuid` returns RECIPIENT_UUID; the GET path
		// should use that resolved UUID, not the raw handle.
		const getCall = calls.find((c) => c.method === "GET");
		expect(getCall?.path).toBe(`/directory/agents/${UUID}`);
		// And resolveToUuid must have been called with the handle as input.
		expect(core.resolveToUuid).toHaveBeenCalledWith(
			expect.any(String),
			"alice@acme.rine.network",
		);
	});

	it("passes UUIDs through unchanged (resolveToUuid short-circuits)", async () => {
		const UUID = "22222222-2222-4222-8222-222222222222";
		const { http, calls } = makeHttpStub({
			get: () => ({
				id: UUID,
				name: "Alice",
				handle: "alice@acme.rine.network",
				description: null,
				category: null,
				verified: false,
				human_oversight: true,
				created_at: "2026-01-01T00:00:00Z",
			}),
		});
		const discovery = new DiscoveryResource(http);

		await discovery.inspect(UUID);

		const getCall = calls.find((c) => c.method === "GET");
		// The mocked `resolveToUuid` always returns RECIPIENT_UUID, so the
		// assertion below only pins that the GET path uses whatever the
		// resolver returned — i.e., that inspect() goes through the
		// resolver and does not hand-craft the path itself.
		expect(getCall?.path).toBe(`/directory/agents/${UUID}`);
	});
});

// ===========================================================================
// branded ID types are compile-time distinct
// ===========================================================================

describe("branded UUID types — compile-time type safety", () => {
	it("blocks cross-assignment at compile time (ts-expect-error sentinel)", () => {
		const agent = "11111111-1111-4111-8111-111111111111" as AgentUuid;
		const group = "33333333-3333-4333-8333-333333333333" as GroupUuid;
		const message = "44444444-4444-4444-8444-444444444444" as MessageUuid;

		// These three must be mutually non-assignable. The `@ts-expect-error`
		// directives will FAIL the TS compile if the brand collapses back to a
		// shared structural type — which is exactly the regression we're
		// guarding against. The runtime body just keeps the variables live.
		function takesAgent(_: AgentUuid): void {}
		function takesGroup(_: GroupUuid): void {}
		function takesMessage(_: MessageUuid): void {}

		takesAgent(agent);
		takesGroup(group);
		takesMessage(message);

		// @ts-expect-error GroupUuid is not assignable to AgentUuid
		takesAgent(group);
		// @ts-expect-error AgentUuid is not assignable to GroupUuid
		takesGroup(agent);
		// @ts-expect-error AgentUuid is not assignable to MessageUuid
		takesMessage(agent);
		// @ts-expect-error a raw string literal must not satisfy AgentUuid
		takesAgent("11111111-1111-4111-8111-111111111111");

		// Runtime sanity — the branded values still carry their string contents.
		expect(agent).toBe("11111111-1111-4111-8111-111111111111");
		expect(group).toBe("33333333-3333-4333-8333-333333333333");
		expect(message).toBe("44444444-4444-4444-8444-444444444444");
	});
});

// ===========================================================================
// PQ hybrid negotiation on send() and reply().
//
// The branch shipped post-quantum hybrid encryption but no SDK test ever drove
// the send/reply paths against a recipient that publishes an ML-KEM-768 key.
// `buildSendBody` / `reply` call `fetchRecipientKeys` and pass the recovered
// `pqEncryption` to `encryptMessage` — when present, `encryptMessage` MUST tag
// the envelope `hpke-hybrid-v1`; when absent it falls back to `hpke-v1`.
//
// The rest of this file stubs `encryptMessage` to a fixed `hpke-v1` fragment,
// which can never exercise PQ negotiation. So these two blocks restore the REAL
// `fetchRecipientKeys` + `encryptMessage` (the same `vi.importActual` +
// `vi.spyOn(core, …).mockImplementation(real.*)` technique createAgent and
// rotateKeys use) and assert on the version tag in the POSTed envelope.
//
// Reverting the hybrid wiring — dropping the `recipientKeys.pqEncryption`
// argument passed into `encryptMessage`, or `encryptMessage`'s hybrid branch —
// flips the asserted `encryption_version` back to `hpke-v1` and fails the test.
// ===========================================================================

describe("send() — PQ hybrid negotiation", () => {
	let configDir: string;
	let webfinger: WebFingerStub;
	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "rine-a5-"));
		webfinger = stubWebFinger({ "alice@acme.rine.network": RECIPIENT_UUID });
	});
	afterEach(() => {
		webfinger.restore();
		delete (CORE_HTTP_STUB as Record<string, unknown>).get;
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	it("sends an hpke-hybrid-v1 envelope when the recipient publishes a PQ key", async () => {
		const real =
			await vi.importActual<typeof import("@rine-network/core")>(
				"@rine-network/core",
			);

		// Sender keys must exist on disk so the real `encryptMessage` can load
		// and sign with them. SENDER_UUID is what the mocked `resolveAgent`
		// returns for the default agent header.
		real.saveAgentKeys(configDir, SENDER_UUID, real.generateAgentKeys());

		// The recipient identity carries a real ML-KEM-768 public key.
		const recipientKeys = real.generateAgentKeys();
		if (!recipientKeys.pqEncryption) throw new Error("no recipient PQ key");

		// Restore the real negotiation + seal — the file-level stubs would
		// otherwise force `hpke-v1` regardless of the recipient's keys.
		vi.spyOn(core, "fetchRecipientKeys").mockImplementation(
			real.fetchRecipientKeys,
		);
		vi.spyOn(core, "encryptMessage").mockImplementation(real.encryptMessage);

		// `fetchRecipientKeys` hits the rine-core bridge `get('/agents/{id}/keys')`.
		// Publish the recipient's X25519 + ML-KEM-768 public keys there.
		(CORE_HTTP_STUB as Record<string, unknown>).get = vi.fn(
			async (p: string) => {
				if (p === `/agents/${RECIPIENT_UUID}/keys`) {
					return {
						agent_id: RECIPIENT_UUID,
						signing_public_key: real.signingPublicKeyToJWK(
							recipientKeys.signing.publicKey,
						),
						encryption_public_key: {
							kty: "OKP",
							crv: "X25519",
							x: real.toBase64Url(recipientKeys.encryption.publicKey),
						},
						pq_encryption_public_key: real.pqPublicKeyToJWK(
							recipientKeys.pqEncryption?.publicKey as Uint8Array,
						),
					};
				}
				throw new Error(`unexpected bridge path: ${p}`);
			},
		);

		const { http, calls } = makeHttpStub(
			{ post: () => sampleMessageRead() },
			configDir,
		);
		const messages = new MessagesResource(http);

		await messages.send("alice@acme.rine.network" as AgentHandle, {
			text: "quantum-safe hi",
		});

		const postCall = calls.find((c) => c.method === "POST");
		expect(postCall?.path).toBe("/messages");
		const body = postCall?.body as Record<string, unknown>;
		// The whole point: a PQ-capable recipient negotiates the hybrid version.
		expect(body.encryption_version).toBe("hpke-hybrid-v1");
		expect(body.to_agent_id).toBe(RECIPIENT_UUID);
		expect(typeof body.encrypted_payload).toBe("string");
	});

	it("falls back to hpke-v1 when the recipient has no PQ key (negative control)", async () => {
		// This test would ALSO pass against the pre-fix code — it is a boundary
		// guard proving version is negotiated, not hard-coded.
		// Same wiring, but the recipient publishes NO `pq_encryption_public_key`.
		// `encryptMessage` must stay on the classical path — proves the hybrid
		// version is negotiated from the recipient's key, not hard-coded.
		const real =
			await vi.importActual<typeof import("@rine-network/core")>(
				"@rine-network/core",
			);
		real.saveAgentKeys(configDir, SENDER_UUID, real.generateAgentKeys());
		const recipientKeys = real.generateAgentKeys();

		vi.spyOn(core, "fetchRecipientKeys").mockImplementation(
			real.fetchRecipientKeys,
		);
		vi.spyOn(core, "encryptMessage").mockImplementation(real.encryptMessage);

		(CORE_HTTP_STUB as Record<string, unknown>).get = vi.fn(
			async (p: string) => {
				if (p === `/agents/${RECIPIENT_UUID}/keys`) {
					return {
						agent_id: RECIPIENT_UUID,
						signing_public_key: real.signingPublicKeyToJWK(
							recipientKeys.signing.publicKey,
						),
						encryption_public_key: {
							kty: "OKP",
							crv: "X25519",
							x: real.toBase64Url(recipientKeys.encryption.publicKey),
						},
						// No pq_encryption_public_key on purpose.
					};
				}
				throw new Error(`unexpected bridge path: ${p}`);
			},
		);

		const { http, calls } = makeHttpStub(
			{ post: () => sampleMessageRead() },
			configDir,
		);
		const messages = new MessagesResource(http);

		await messages.send("alice@acme.rine.network" as AgentHandle, {
			text: "classical hi",
		});

		const body = calls.find((c) => c.method === "POST")?.body as Record<
			string,
			unknown
		>;
		expect(body.encryption_version).toBe("hpke-v1");
	});
});

describe("reply() — PQ hybrid negotiation", () => {
	let configDir: string;
	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "rine-a6-"));
	});
	afterEach(() => {
		delete (CORE_HTTP_STUB as Record<string, unknown>).get;
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	it("encrypts the reply as hpke-hybrid-v1 when the original sender has a PQ key", async () => {
		const ORIGINAL_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
		const real =
			await vi.importActual<typeof import("@rine-network/core")>(
				"@rine-network/core",
			);

		// We (SENDER_UUID) reply to a message Alice (RECIPIENT_UUID) sent us, so
		// the reply is encrypted TO RECIPIENT_UUID's keys.
		real.saveAgentKeys(configDir, SENDER_UUID, real.generateAgentKeys());
		const recipientKeys = real.generateAgentKeys();
		if (!recipientKeys.pqEncryption) throw new Error("no recipient PQ key");

		vi.spyOn(core, "fetchRecipientKeys").mockImplementation(
			real.fetchRecipientKeys,
		);
		vi.spyOn(core, "encryptMessage").mockImplementation(real.encryptMessage);

		// The bridge `get` serves BOTH the original-message fetch and the
		// recipient-keys fetch that `reply()` performs.
		(CORE_HTTP_STUB as Record<string, unknown>).get = vi.fn(
			async (p: string) => {
				if (p === `/messages/${ORIGINAL_MESSAGE_ID}`) {
					return sampleMessageRead({
						id: ORIGINAL_MESSAGE_ID,
						from_agent_id: RECIPIENT_UUID, // original sender = reply recipient
						to_agent_id: SENDER_UUID, // landed in our mailbox
					});
				}
				if (p === `/agents/${RECIPIENT_UUID}/keys`) {
					return {
						agent_id: RECIPIENT_UUID,
						signing_public_key: real.signingPublicKeyToJWK(
							recipientKeys.signing.publicKey,
						),
						encryption_public_key: {
							kty: "OKP",
							crv: "X25519",
							x: real.toBase64Url(recipientKeys.encryption.publicKey),
						},
						pq_encryption_public_key: real.pqPublicKeyToJWK(
							recipientKeys.pqEncryption?.publicKey as Uint8Array,
						),
					};
				}
				throw new Error(`unexpected bridge path: ${p}`);
			},
		);

		const { http, calls } = makeHttpStub(
			{ post: () => sampleMessageRead({ type: "rine.v1.task_response" }) },
			configDir,
		);
		const messages = new MessagesResource(http);

		await messages.reply(ORIGINAL_MESSAGE_ID as MessageUuid, { text: "ack" });

		const postCall = calls.find((c) => c.method === "POST");
		expect(postCall?.path).toBe(`/messages/${ORIGINAL_MESSAGE_ID}/reply`);
		const body = postCall?.body as Record<string, unknown>;
		expect(body.encryption_version).toBe("hpke-hybrid-v1");
		expect(typeof body.encrypted_payload).toBe("string");
	});
});
