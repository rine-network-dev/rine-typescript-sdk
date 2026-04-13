/**
 * Resource smoke tests — covers the passthrough resources
 * (`groups`, `webhooks`, `polling`, plus the `decryptEnvelope` dispatch)
 * so the Step-21 `≥ 70%` function-coverage threshold is met.
 *
 * These tests are intentionally shallow: they verify route + body + a
 * single response round-trip per method. Behavioural depth lives in the
 * audit-regression suite and in the resource-specific test files.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock rine-core crypto for the decrypt-dispatch test (C2/C3 sibling).
// ---------------------------------------------------------------------------

const decryptMessageMock = vi.fn();
const decryptGroupMessageMock = vi.fn();
const fetchSKMock = vi.fn();

vi.mock("@rine-network/core", async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>;
	return {
		...original,
		decryptMessage: decryptMessageMock,
		decryptGroupMessage: decryptGroupMessageMock,
		fetchAndIngestPendingSKDistributions: fetchSKMock,
		// `PollingResource.poll()` reads the default credential entry's
		// `poll_url` (SPEC §10.2 + step-27 adherence audit B2 fix). Return a
		// deterministic stub here so the tests don't hit the real `loadCredentials`
		// → `fs.readFileSync` path.
		loadCredentials: () => ({
			default: {
				client_id: "test-client",
				client_secret: "test-secret",
				poll_url: "/poll/test-token",
			},
		}),
	};
});

const { GroupsResource } = await import("./resources/groups.js");
const { WebhooksResource } = await import("./resources/webhooks.js");
const { PollingResource } = await import("./resources/polling.js");
const { decryptEnvelope } = await import("./resources/decrypt.js");

type SDKHttpClient = import("./api/http.js").SDKHttpClient;
type AgentUuid = import("./types.js").AgentUuid;
type GroupUuid = import("./types.js").GroupUuid;
type WebhookUuid = import("./types.js").WebhookUuid;

// ---------------------------------------------------------------------------
// HTTP stub
// ---------------------------------------------------------------------------

interface RecordedCall {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	body?: unknown;
	opts?: Record<string, unknown>;
}

function makeHttpStub(respond: (call: RecordedCall) => unknown): {
	http: SDKHttpClient;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const handle = async <T>(
		method: RecordedCall["method"],
		path: string,
		body: unknown,
		opts?: Record<string, unknown>,
	): Promise<T> => {
		const call: RecordedCall = { method, path, body, opts };
		calls.push(call);
		return respond(call) as T;
	};
	const stub = {
		// `PollingResource.poll()` reads `this.http.configDir`; a real SDK
		// client computes this via `resolveConfigDir()` but the stub just
		// exposes an empty string — the mocked `loadCredentials` above ignores
		// the argument entirely, so the value is only used for type conformance.
		configDir: "",
		async get<T>(p: string, opts?: Record<string, unknown>): Promise<T> {
			return handle<T>("GET", p, undefined, opts);
		},
		async post<T>(
			p: string,
			body?: unknown,
			opts?: Record<string, unknown>,
		): Promise<T> {
			return handle<T>("POST", p, body, opts);
		},
		async postWithStatus<T>(
			p: string,
			body?: unknown,
			opts?: Record<string, unknown>,
		): Promise<{ status: number; body: T }> {
			const call: RecordedCall = { method: "POST", path: p, body, opts };
			calls.push(call);
			const result = respond(call);
			const r = result as { __status?: number };
			const status = r?.__status ?? 200;
			return { status, body: result as T };
		},
		async put<T>(
			p: string,
			body?: unknown,
			opts?: Record<string, unknown>,
		): Promise<T> {
			return handle<T>("PUT", p, body, opts);
		},
		async patch<T>(
			p: string,
			body?: unknown,
			opts?: Record<string, unknown>,
		): Promise<T> {
			return handle<T>("PATCH", p, body, opts);
		},
		async delete<T>(p: string, opts?: Record<string, unknown>): Promise<T> {
			return handle<T>("DELETE", p, undefined, opts);
		},
	} as unknown as SDKHttpClient;
	return { http: stub, calls };
}

const GROUP_ID = "33333333-3333-4333-8333-333333333333" as GroupUuid;
const AGENT_ID = "11111111-1111-4111-8111-111111111111" as AgentUuid;
const WEBHOOK_ID = "44444444-4444-4444-8444-444444444444" as WebhookUuid;

afterEach(() => {
	vi.clearAllMocks();
});

// ===========================================================================
// GroupsResource
// ===========================================================================

describe("GroupsResource", () => {
	function sampleGroup(
		over: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			id: GROUP_ID,
			name: "dev",
			handle: "#dev@acme.rine.network",
			created_at: "2026-04-11T12:00:00Z",
			...over,
		};
	}

	it("list() GETs /groups and parses a cursor page", async () => {
		const { http, calls } = makeHttpStub(() => ({
			items: [sampleGroup()],
			total: 1,
		}));
		const groups = new GroupsResource(http);
		const page = await groups.list();
		expect(calls[0]?.path).toBe("/groups");
		expect(page.items).toHaveLength(1);
	});

	it("create() POSTs /groups with mapped enrollment_policy", async () => {
		const { http, calls } = makeHttpStub(() => sampleGroup());
		const groups = new GroupsResource(http);
		await groups.create("dev", {
			description: "desc",
			enrollment: "majority",
			visibility: "public",
		});
		expect(calls[0]?.path).toBe("/groups");
		expect(calls[0]?.body).toMatchObject({
			name: "dev",
			description: "desc",
			enrollment_policy: "majority",
			visibility: "public",
		});
	});

	it("create() accepts an options-bag first argument (REQ-04)", async () => {
		const { http, calls } = makeHttpStub(() => sampleGroup());
		const groups = new GroupsResource(http);
		await groups.create({
			name: "dev",
			visibility: "public",
			enrollment: "open",
		});
		expect(calls[0]?.path).toBe("/groups");
		expect(calls[0]?.body).toMatchObject({
			name: "dev",
			visibility: "public",
			enrollment_policy: "open",
		});
		// `name` on the wire is a bare string, not a nested object (the bug
		// the options-bag overload guards against).
		const body = calls[0]?.body as Record<string, unknown>;
		expect(typeof body.name).toBe("string");
	});

	it("get() GETs /groups/{id}", async () => {
		const { http, calls } = makeHttpStub(() => sampleGroup());
		const groups = new GroupsResource(http);
		await groups.get(GROUP_ID);
		expect(calls[0]?.path).toBe(`/groups/${GROUP_ID}`);
	});

	it("update() PATCHes /groups/{id} with camel → snake body", async () => {
		const { http, calls } = makeHttpStub(() => sampleGroup());
		const groups = new GroupsResource(http);
		await groups.update(GROUP_ID, {
			description: "x",
			enrollment: "closed",
			visibility: "private",
			voteDurationHours: 48,
		});
		expect(calls[0]?.method).toBe("PATCH");
		expect(calls[0]?.path).toBe(`/groups/${GROUP_ID}`);
		expect(calls[0]?.body).toEqual({
			description: "x",
			enrollment_policy: "closed",
			visibility: "private",
			vote_duration_hours: 48,
		});
	});

	it("delete() DELETEs /groups/{id}", async () => {
		const { http, calls } = makeHttpStub(() => undefined);
		const groups = new GroupsResource(http);
		await groups.delete(GROUP_ID);
		expect(calls[0]?.method).toBe("DELETE");
		expect(calls[0]?.path).toBe(`/groups/${GROUP_ID}`);
	});

	it("join() POSTs /groups/{id}/join with optional message", async () => {
		const { http, calls } = makeHttpStub(() => ({
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			group_id: GROUP_ID,
			agent_id: AGENT_ID,
			role: "member",
			joined_at: "2026-04-12T00:00:00.000Z",
			agent_handle: "bot@acme.rine.network",
		}));
		const groups = new GroupsResource(http);
		const result = await groups.join(GROUP_ID, {
			message: "please let me in",
		});
		expect(calls[0]?.path).toBe(`/groups/${GROUP_ID}/join`);
		expect(calls[0]?.body).toEqual({ message: "please let me in" });
		expect(result.status).toBe("joined");
	});

	it("invite() POSTs /groups/{id}/invite with agent_id in body", async () => {
		const { http, calls } = makeHttpStub(() => ({ status: "pending" }));
		const groups = new GroupsResource(http);
		await groups.invite(GROUP_ID, AGENT_ID, { message: "join us" });
		expect(calls[0]?.path).toBe(`/groups/${GROUP_ID}/invite`);
		expect(calls[0]?.body).toMatchObject({
			agent_id: AGENT_ID,
			message: "join us",
		});
	});

	it("removeMember() DELETEs /groups/{id}/members/{agentId}", async () => {
		const { http, calls } = makeHttpStub(() => undefined);
		const groups = new GroupsResource(http);
		await groups.removeMember(GROUP_ID, AGENT_ID);
		expect(calls[0]?.method).toBe("DELETE");
		expect(calls[0]?.path).toBe(`/groups/${GROUP_ID}/members/${AGENT_ID}`);
	});

	it("members() GETs /groups/{id}/members (cursor page)", async () => {
		const { http, calls } = makeHttpStub(() => ({ items: [], total: 0 }));
		const groups = new GroupsResource(http);
		const page = await groups.members(GROUP_ID);
		expect(calls[0]?.path).toBe(`/groups/${GROUP_ID}/members`);
		expect(page.items).toEqual([]);
	});

	it("listRequests() GETs /groups/{id}/requests and returns items[]", async () => {
		const { http, calls } = makeHttpStub(() => ({ items: [], total: 0 }));
		const groups = new GroupsResource(http);
		const list = await groups.listRequests(GROUP_ID);
		expect(calls[0]?.path).toBe(`/groups/${GROUP_ID}/requests`);
		expect(list).toEqual([]);
	});

	it("vote() POSTs /groups/{id}/requests/{requestId}/vote", async () => {
		const REQ_ID = "55555555-5555-4555-8555-555555555555";
		const { http, calls } = makeHttpStub(() => ({
			request_id: REQ_ID,
			your_vote: "approve",
			status: "pending",
		}));
		const groups = new GroupsResource(http);
		await groups.vote(GROUP_ID, REQ_ID, "approve");
		expect(calls[0]?.path).toBe(`/groups/${GROUP_ID}/requests/${REQ_ID}/vote`);
		expect(calls[0]?.body).toEqual({ vote: "approve" });
	});
});

// ===========================================================================
// WebhooksResource
// ===========================================================================

describe("WebhooksResource", () => {
	function sampleWebhook(
		over: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			id: WEBHOOK_ID,
			agent_id: AGENT_ID,
			url: "https://example.test/hook",
			active: true,
			created_at: "2026-04-11T12:00:00Z",
			...over,
		};
	}

	it("create() POSTs /webhooks with agent_id + events", async () => {
		const { http, calls } = makeHttpStub(() => ({
			...sampleWebhook(),
			secret: "s3cret",
		}));
		const webhooks = new WebhooksResource(http);
		await webhooks.create(AGENT_ID, "https://example.test/hook", {
			events: ["message.received"],
		});
		expect(calls[0]?.path).toBe("/webhooks");
		expect(calls[0]?.body).toEqual({
			agent_id: AGENT_ID,
			url: "https://example.test/hook",
			events: ["message.received"],
		});
	});

	it("list() GETs /webhooks with params", async () => {
		const { http, calls } = makeHttpStub(() => ({ items: [], total: 0 }));
		const webhooks = new WebhooksResource(http);
		await webhooks.list({ agentId: AGENT_ID, includeInactive: true });
		expect(calls[0]?.path).toBe("/webhooks");
		expect(
			(calls[0]?.opts as { params: Record<string, unknown> }).params,
		).toEqual({
			agent_id: AGENT_ID,
			include_inactive: true,
		});
	});

	it("update() PATCHes /webhooks/{id} with only {active}", async () => {
		const { http, calls } = makeHttpStub(() =>
			sampleWebhook({ active: false }),
		);
		const webhooks = new WebhooksResource(http);
		await webhooks.update(WEBHOOK_ID, { active: false });
		expect(calls[0]?.method).toBe("PATCH");
		expect(calls[0]?.path).toBe(`/webhooks/${WEBHOOK_ID}`);
		expect(calls[0]?.body).toEqual({ active: false });
	});

	it("delete() DELETEs /webhooks/{id}", async () => {
		const { http, calls } = makeHttpStub(() => undefined);
		const webhooks = new WebhooksResource(http);
		await webhooks.delete(WEBHOOK_ID);
		expect(calls[0]?.method).toBe("DELETE");
		expect(calls[0]?.path).toBe(`/webhooks/${WEBHOOK_ID}`);
	});

	it("deliveries() GETs /webhooks/{id}/deliveries", async () => {
		const { http, calls } = makeHttpStub(() => ({ items: [], total: 0 }));
		const webhooks = new WebhooksResource(http);
		await webhooks.deliveries(WEBHOOK_ID, {
			status: "failed",
			limit: 25,
			offset: 0,
		});
		expect(calls[0]?.path).toBe(`/webhooks/${WEBHOOK_ID}/deliveries`);
		expect(
			(calls[0]?.opts as { params: Record<string, unknown> }).params,
		).toEqual({
			status: "failed",
			limit: 25,
			offset: 0,
		});
	});

	it("deliverySummary() GETs /webhooks/{id}/deliveries/summary", async () => {
		const { http, calls } = makeHttpStub(() => ({
			total: 10,
			delivered: 7,
			failed: 2,
			dead: 1,
			pending: 0,
			processing: 0,
		}));
		const webhooks = new WebhooksResource(http);
		const summary = await webhooks.deliverySummary(WEBHOOK_ID);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.path).toBe(`/webhooks/${WEBHOOK_ID}/deliveries/summary`);
		expect(calls[0]?.body).toBeUndefined();
		expect(summary).toEqual({
			total: 10,
			delivered: 7,
			failed: 2,
			dead: 1,
			pending: 0,
			processing: 0,
		});
	});
});

// ===========================================================================
// PollingResource
// ===========================================================================

describe("PollingResource", () => {
	it("poll() GETs the credential poll_url unauthenticated and coerces various response shapes", async () => {
		const responses = [5, { count: 7 }, "3"];
		let i = 0;
		const { http, calls } = makeHttpStub(() => responses[i++]);
		const polling = new PollingResource(http);
		expect(await polling.poll()).toBe(5);
		expect(await polling.poll()).toBe(7);
		expect(await polling.poll()).toBe(3);
		for (const c of calls) {
			// Fix from step-27 adherence audit B2: the SDK reads `poll_url`
			// from the default credential entry rather than hardcoding `/poll`.
			// The mocked `loadCredentials` above returns `/poll/test-token`.
			expect(c.path).toBe("/poll/test-token");
			expect((c.opts as { unauthenticated: boolean }).unauthenticated).toBe(
				true,
			);
		}
	});

	it("watchPoll() fires the callback on monotonic count increases and stops on unsubscribe", async () => {
		vi.useFakeTimers();
		try {
			const counts = [0, 1, 1, 2, 2];
			let i = 0;
			const { http } = makeHttpStub(() => counts[i++] ?? 2);
			const polling = new PollingResource(http);

			const seen: number[] = [];
			const unsubscribe = polling.watchPoll((n) => seen.push(n), {
				interval: 1_000,
			});

			// Each iteration: poll() (microtask) → sleep(1000) (timer).
			// Drain 5 iterations so we observe 0→1 and 1→2 transitions.
			for (let k = 0; k < 5; k++) {
				await vi.advanceTimersByTimeAsync(1_000);
			}
			const beforeUnsubscribe = seen.length;
			unsubscribe();

			// After unsubscribe the loop must not run the callback again
			// even if more timers would fire.
			await vi.advanceTimersByTimeAsync(10_000);
			expect(seen.length).toBe(beforeUnsubscribe);
			// Must have observed exactly the 1 and 2 transitions (duplicates filtered).
			expect(seen).toEqual([1, 2]);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ===========================================================================
// decryptEnvelope — dispatch routing
// ===========================================================================

describe("decryptEnvelope dispatch", () => {
	const agentId = "11111111-1111-4111-8111-111111111111";
	const coreStub = {} as import("@rine-network/core").HttpClient;

	it("routes hpke-v1 envelopes through decryptMessage", async () => {
		decryptMessageMock.mockResolvedValue({
			plaintext: "hello",
			verified: true,
			verificationStatus: "verified",
		});
		const out = await decryptEnvelope({
			core: coreStub,
			configDir: "/tmp",
			agentId,
			msg: {
				id: "msg-1",
				conversation_id: "c1",
				type: "rine.v1.task_request",
				encrypted_payload: "ENC",
				encryption_version: "hpke-v1",
				created_at: "2026-04-11T12:00:00Z",
			} as never,
		});
		expect(decryptMessageMock).toHaveBeenCalledTimes(1);
		expect(out.plaintext).toBe("hello");
		expect(out.verified).toBe(true);
		expect(out.decrypt_error).toBeNull();
	});

	it("routes sender-key-v1 envelopes through decryptGroupMessage", async () => {
		decryptGroupMessageMock.mockResolvedValue({
			plaintext: "group-hi",
			verified: true,
			verificationStatus: "verified",
		});
		const out = await decryptEnvelope({
			core: coreStub,
			configDir: "/tmp",
			agentId,
			msg: {
				id: "msg-2",
				conversation_id: "c1",
				group_id: "33333333-3333-4333-8333-333333333333",
				type: "rine.v1.task_request",
				encrypted_payload: "ENC",
				encryption_version: "sender-key-v1",
				created_at: "2026-04-11T12:00:00Z",
			} as never,
		});
		expect(decryptGroupMessageMock).toHaveBeenCalledTimes(1);
		expect(out.plaintext).toBe("group-hi");
	});

	it("retries sender-key decrypt once after fetchAndIngestPendingSKDistributions", async () => {
		decryptGroupMessageMock
			.mockRejectedValueOnce(new Error("no key"))
			.mockResolvedValueOnce({
				plaintext: "after-retry",
				verified: true,
				verificationStatus: "verified",
			});
		fetchSKMock.mockResolvedValue(undefined);

		const out = await decryptEnvelope({
			core: coreStub,
			configDir: "/tmp",
			agentId,
			msg: {
				id: "msg-3",
				conversation_id: "c1",
				group_id: "33333333-3333-4333-8333-333333333333",
				type: "rine.v1.task_request",
				encrypted_payload: "ENC",
				encryption_version: "sender-key-v1",
				created_at: "2026-04-11T12:00:00Z",
			} as never,
			retrySenderKey: true,
		});

		expect(fetchSKMock).toHaveBeenCalledTimes(1);
		expect(decryptGroupMessageMock).toHaveBeenCalledTimes(2);
		expect(out.plaintext).toBe("after-retry");
	});

	it("populates decrypt_error on unknown encryption_version", async () => {
		const out = await decryptEnvelope({
			core: coreStub,
			configDir: "/tmp",
			agentId,
			msg: {
				id: "msg-4",
				conversation_id: "c1",
				type: "rine.v1.task_request",
				encrypted_payload: "ENC",
				encryption_version: "mystery",
				created_at: "2026-04-11T12:00:00Z",
			} as never,
		});
		expect(out.decrypt_error).toMatch(/unknown encryption_version/);
		expect(out.plaintext).toBeUndefined();
	});

	it("populates decrypt_error on missing encrypted_payload", async () => {
		const out = await decryptEnvelope({
			core: coreStub,
			configDir: "/tmp",
			agentId,
			msg: {
				id: "msg-5",
				conversation_id: "c1",
				type: "rine.v1.task_request",
				encrypted_payload: "",
				encryption_version: "hpke-v1",
				created_at: "2026-04-11T12:00:00Z",
			} as never,
		});
		expect(out.decrypt_error).toMatch(/missing encrypted_payload/);
	});
});

// ===========================================================================
// decryptEnvelope — plaintext auto-parse (REQ-05 / sdk-handoff-fixes)
// ===========================================================================

describe("decryptEnvelope plaintext auto-parse", () => {
	const agentId = "11111111-1111-4111-8111-111111111111";
	const coreStub = {} as import("@rine-network/core").HttpClient;

	function makeMsg(contentType: string | null | undefined) {
		return {
			id: "msg-ap",
			conversation_id: "c1",
			type: "rine.v1.task_request",
			content_type: contentType,
			encrypted_payload: "ENC",
			encryption_version: "hpke-v1",
			created_at: "2026-04-11T12:00:00Z",
		} as never;
	}

	it("parses valid JSON when content_type is application/json", async () => {
		decryptMessageMock.mockResolvedValue({
			plaintext: '{"text":"hi"}',
			verified: true,
			verificationStatus: "verified",
		});
		const out = await decryptEnvelope({
			core: coreStub,
			configDir: "/tmp",
			agentId,
			msg: makeMsg("application/json"),
		});
		expect(out.plaintext).toEqual({ text: "hi" });
		expect(out.decrypt_error).toBeNull();
	});

	it("defaults to JSON when content_type is missing", async () => {
		decryptMessageMock.mockResolvedValue({
			plaintext: '[1,2,3]',
			verified: true,
			verificationStatus: "verified",
		});
		const out = await decryptEnvelope({
			core: coreStub,
			configDir: "/tmp",
			agentId,
			msg: makeMsg(undefined),
		});
		expect(out.plaintext).toEqual([1, 2, 3]);
	});

	it("keeps the raw string for non-JSON content_type", async () => {
		decryptMessageMock.mockResolvedValue({
			plaintext: "plain text body",
			verified: true,
			verificationStatus: "verified",
		});
		const out = await decryptEnvelope({
			core: coreStub,
			configDir: "/tmp",
			agentId,
			msg: makeMsg("text/plain"),
		});
		expect(out.plaintext).toBe("plain text body");
	});

	it("falls back to raw string when JSON is malformed (no decrypt_error)", async () => {
		decryptMessageMock.mockResolvedValue({
			plaintext: "{not json",
			verified: true,
			verificationStatus: "verified",
		});
		const out = await decryptEnvelope({
			core: coreStub,
			configDir: "/tmp",
			agentId,
			msg: makeMsg("application/json"),
		});
		// Crypto succeeded; format layer is best-effort per SPEC REQ-05.
		expect(out.plaintext).toBe("{not json");
		expect(out.decrypt_error).toBeNull();
	});

	it("handles a JSON-string primitive round-trip (e.g. '\"hello\"')", async () => {
		decryptMessageMock.mockResolvedValue({
			plaintext: '"hello"',
			verified: true,
			verificationStatus: "verified",
		});
		const out = await decryptEnvelope({
			core: coreStub,
			configDir: "/tmp",
			agentId,
			msg: makeMsg("application/json"),
		});
		expect(out.plaintext).toBe("hello");
	});
});
