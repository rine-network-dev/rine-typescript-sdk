/**
 * Tests for the org & agent lifecycle additions:
 *   - register()
 *   - createAgent() poll_url persist
 *   - updateOrg / eraseOrg / exportOrg
 *   - lazy org-ID cache
 *   - domain constant objects
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SDKHttpClient } from "./api/http.js";

// ---------------------------------------------------------------------------
// register() — mock the rine-core registration helper
// ---------------------------------------------------------------------------

const performRegistrationMock = vi.fn();
vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		performRegistration: (...args: unknown[]) =>
			performRegistrationMock(...args),
	};
});

// Import AFTER the mock — the SDK's onboard.ts binds the mocked function.
const { register, validateSlug } = await import("./onboard.js");
const {
	ConflictError,
	RateLimitError,
	RineError,
	ValidationError,
} = await import("./errors.js");
const {
	ConversationStatus,
	JoinRequestStatus,
	VoteChoice,
	WebhookJobStatus,
	EncryptionVersion,
	ErasureResultSchema,
} = await import("./types.js");

describe("register() — slug validation (client-side)", () => {
	beforeEach(() => {
		performRegistrationMock.mockReset();
	});

	it("throws ValidationError on a syntactically invalid slug", async () => {
		await expect(
			register({
				apiUrl: "https://rine.network",
				configDir: "/tmp/x",
				email: "a@b.c",
				slug: "-bad-start",
				name: "n",
			}),
		).rejects.toBeInstanceOf(ValidationError);
		// Must fail client-side — no network call attempted.
		expect(performRegistrationMock).not.toHaveBeenCalled();
	});

	it("accepts a valid slug", async () => {
		performRegistrationMock.mockResolvedValueOnce({
			org_id: "abc",
			client_id: "cid",
		});
		const out = await register({
			apiUrl: "https://rine.network",
			configDir: "/tmp/x",
			email: "a@b.c",
			slug: "my-org",
			name: "My Org",
		});
		expect(out).toEqual({ orgId: "abc", clientId: "cid" });
	});

	it("rejects uppercase slugs", () => {
		expect(validateSlug("My-Org")).toBe(false);
	});
	it("rejects slugs with trailing hyphen", () => {
		expect(validateSlug("foo-")).toBe(false);
	});
	it("rejects single-character slugs", () => {
		expect(validateSlug("a")).toBe(false);
	});
	it("accepts hyphenated lowercase alphanumeric slugs", () => {
		expect(validateSlug("my-org-2")).toBe(true);
	});
});

describe("register() — error mapping", () => {
	beforeEach(() => {
		performRegistrationMock.mockReset();
	});

	const goodOpts = {
		apiUrl: "https://rine.network",
		configDir: "/tmp/x",
		email: "a@b.c",
		slug: "my-org",
		name: "My Org",
	};

	it("maps 'already registered' to ConflictError", async () => {
		performRegistrationMock.mockRejectedValueOnce(
			new Error("Email or slug already registered"),
		);
		await expect(register(goodOpts)).rejects.toBeInstanceOf(ConflictError);
	});

	it("maps 'Conflict' message to ConflictError", async () => {
		performRegistrationMock.mockRejectedValueOnce(
			new Error("Conflict: email or slug already registered"),
		);
		await expect(register(goodOpts)).rejects.toBeInstanceOf(ConflictError);
	});

	it("maps 'Rate limited' to RateLimitError", async () => {
		performRegistrationMock.mockRejectedValueOnce(
			new Error("Rate limited — please wait before retrying"),
		);
		await expect(register(goodOpts)).rejects.toBeInstanceOf(RateLimitError);
	});

	it("maps 'expired' challenge to RineError", async () => {
		performRegistrationMock.mockRejectedValueOnce(
			new Error("Challenge expired — please try again"),
		);
		await expect(register(goodOpts)).rejects.toBeInstanceOf(RineError);
	});

	it("rethrows unknown errors unchanged", async () => {
		const raw = new Error("something else");
		performRegistrationMock.mockRejectedValueOnce(raw);
		await expect(register(goodOpts)).rejects.toBe(raw);
	});
});

describe("validateSlug — re-export smoke", () => {
	it("is importable from the SDK surface", () => {
		expect(typeof validateSlug).toBe("function");
		expect(validateSlug("my-org")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Domain constant objects
// ---------------------------------------------------------------------------

describe("Domain constant objects", () => {
	it("ConversationStatus has all 8 states with expected values", () => {
		expect(ConversationStatus).toEqual({
			Submitted: "submitted",
			Open: "open",
			Paused: "paused",
			InputRequired: "input_required",
			Completed: "completed",
			Rejected: "rejected",
			Canceled: "canceled",
			Failed: "failed",
		});
	});

	it("JoinRequestStatus has all 4 states", () => {
		expect(JoinRequestStatus).toEqual({
			Pending: "pending",
			Approved: "approved",
			Denied: "denied",
			Expired: "expired",
		});
	});

	it("VoteChoice maps Approve/Deny", () => {
		expect(VoteChoice).toEqual({ Approve: "approve", Deny: "deny" });
	});

	it("WebhookJobStatus has all 5 states", () => {
		expect(WebhookJobStatus).toEqual({
			Pending: "pending",
			Processing: "processing",
			Delivered: "delivered",
			Failed: "failed",
			Dead: "dead",
		});
	});

	it("EncryptionVersion uses the on-wire strings", () => {
		expect(EncryptionVersion).toEqual({
			HpkeV1: "hpke-v1",
			SenderKeyV1: "sender-key-v1",
		});
	});
});

// ---------------------------------------------------------------------------
// IdentityResource — org lifecycle + createAgent poll_url + lazy cache
// ---------------------------------------------------------------------------

const { IdentityResource } = await import("./resources/identity.js");

interface Call {
	method: string;
	path: string;
	body?: unknown;
	opts?: { signal?: AbortSignal } | undefined;
}

interface Responder {
	(method: string, path: string): unknown;
}

function makeHttp(configDir: string, responder: Responder): {
	http: SDKHttpClient;
	calls: Call[];
} {
	const calls: Call[] = [];
	const record = (
		method: string,
		p: string,
		body?: unknown,
		opts?: { signal?: AbortSignal },
	): unknown => {
		calls.push({ method, path: p, body, opts });
		return responder(method, p);
	};
	const stub = {
		get configDir() {
			return configDir;
		},
		async get<T>(p: string, opts?: { signal?: AbortSignal }): Promise<T> {
			return record("GET", p, undefined, opts) as T;
		},
		async post<T>(
			p: string,
			body?: unknown,
			opts?: { signal?: AbortSignal },
		): Promise<T> {
			return record("POST", p, body, opts) as T;
		},
		async patch<T>(
			p: string,
			body?: unknown,
			opts?: { signal?: AbortSignal },
		): Promise<T> {
			return record("PATCH", p, body, opts) as T;
		},
		async delete<T>(p: string, opts?: { signal?: AbortSignal }): Promise<T> {
			return record("DELETE", p, undefined, opts) as T;
		},
	} as unknown as SDKHttpClient;
	return { http: stub, calls };
}

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function sampleOrg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: ORG_ID,
		name: "Acme",
		slug: "acme",
		contact_email: null,
		country_code: null,
		trust_tier: 1,
		agent_count: 0,
		created_at: "2026-04-13T12:00:00Z",
		...overrides,
	};
}

function sampleAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: AGENT_ID,
		name: "alice",
		handle: "alice@acme.rine.network",
		human_oversight: true,
		incoming_policy: "accept_all",
		outgoing_policy: "send_all",
		created_at: "2026-04-13T12:00:00Z",
		...overrides,
	};
}

function sampleErasure(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		org_id: ORG_ID,
		erased_at: "2026-04-13T13:00:00Z",
		messages_deleted: 5,
		agents_deleted: 2,
		conversations_deleted: 3,
		groups_deleted: 1,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// createAgent — poll_url persistence
// ---------------------------------------------------------------------------

describe("IdentityResource.createAgent — poll_url persistence", () => {
	let configDir: string;
	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "rine-sdk-lifecycle-"));
		// Seed credentials.json so saveCredentials has a `default` entry to mutate.
		fs.writeFileSync(
			path.join(configDir, "credentials.json"),
			JSON.stringify({ default: { client_id: "cid", client_secret: "sec" } }),
		);
	});
	afterEach(() => {
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	it("writes poll_url to credentials.json when the server returns it", async () => {
		const pollUrl = "https://rine.network/poll/abc123";
		const { http } = makeHttp(configDir, () =>
			sampleAgent({ poll_url: pollUrl }),
		);
		const identity = new IdentityResource(http);

		await identity.createAgent("alice");

		const creds = JSON.parse(
			fs.readFileSync(path.join(configDir, "credentials.json"), "utf-8"),
		) as Record<string, { poll_url?: string }>;
		expect(creds.default?.poll_url).toBe(pollUrl);
	});

	it("does not touch credentials.json when poll_url is absent", async () => {
		const before = fs.readFileSync(
			path.join(configDir, "credentials.json"),
			"utf-8",
		);
		const { http } = makeHttp(configDir, () => sampleAgent());
		const identity = new IdentityResource(http);

		await identity.createAgent("alice");

		const after = fs.readFileSync(
			path.join(configDir, "credentials.json"),
			"utf-8",
		);
		expect(after).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// updateOrg
// ---------------------------------------------------------------------------

describe("IdentityResource.updateOrg", () => {
	it("PATCHes /org with a snake_case body and omits undefined fields", async () => {
		const { http, calls } = makeHttp("/tmp/x", () => sampleOrg({ name: "New" }));
		const identity = new IdentityResource(http);

		await identity.updateOrg({
			name: "New",
			contact_email: "x@y.z",
			country_code: undefined, // intentionally omitted
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ method: "PATCH", path: "/org" });
		expect(calls[0]?.body).toEqual({ name: "New", contact_email: "x@y.z" });
	});

	it("warms the org-ID cache from its response (skips whoami on subsequent calls)", async () => {
		let call = 0;
		const { http, calls } = makeHttp("/tmp/x", (method, p) => {
			call++;
			if (method === "PATCH" && p === "/org") return sampleOrg();
			if (method === "DELETE" && p === `/orgs/${ORG_ID}`) return sampleErasure();
			return null;
		});
		const identity = new IdentityResource(http);

		await identity.updateOrg({ name: "New" });
		await identity.eraseOrg({ confirm: true });

		// 2 calls (PATCH + DELETE) — no GET /org or GET /agents.
		expect(call).toBe(2);
		expect(calls.some((c) => c.method === "GET")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// eraseOrg — confirm guard + route
// ---------------------------------------------------------------------------

describe("IdentityResource.eraseOrg — confirm guard", () => {
	it("throws RineError when confirm is not true", async () => {
		const { http, calls } = makeHttp("/tmp/x", () => sampleErasure());
		const identity = new IdentityResource(http);

		await expect(
			identity.eraseOrg({ confirm: false }),
		).rejects.toBeInstanceOf(RineError);
		// Guard must fire BEFORE any network call — no GET /org, no DELETE.
		expect(calls).toHaveLength(0);
	});

	it("throws with an irreversibility message mentioning confirm=true", async () => {
		const { http } = makeHttp("/tmp/x", () => sampleErasure());
		const identity = new IdentityResource(http);

		await expect(
			identity.eraseOrg({ confirm: false }),
		).rejects.toThrow(/confirm.*true/i);
	});

	it("DELETEs /orgs/{orgId} when confirm=true and returns parsed ErasureResult", async () => {
		const { http, calls } = makeHttp("/tmp/x", (method, p) => {
			if (method === "GET" && p === "/agents") return [];
			if (method === "GET" && p === "/org") return sampleOrg();
			if (method === "DELETE" && p === `/orgs/${ORG_ID}`) return sampleErasure();
			return null;
		});
		const identity = new IdentityResource(http);

		const result = await identity.eraseOrg({ confirm: true });

		expect(result.org_id).toBe(ORG_ID);
		expect(result.messages_deleted).toBe(5);
		expect(result.groups_deleted).toBe(1);
		// DELETE hit the org-scoped path.
		expect(calls.some((c) => c.method === "DELETE" && c.path === `/orgs/${ORG_ID}`))
			.toBe(true);
	});

	it("forwards AbortSignal to the underlying request", async () => {
		const { http, calls } = makeHttp("/tmp/x", (method, p) => {
			if (method === "GET" && p === "/agents") return [];
			if (method === "GET" && p === "/org") return sampleOrg();
			if (method === "DELETE") return sampleErasure();
			return null;
		});
		const identity = new IdentityResource(http);
		const ac = new AbortController();

		await identity.eraseOrg({ confirm: true, signal: ac.signal });

		const deleteCall = calls.find((c) => c.method === "DELETE");
		expect(deleteCall?.opts?.signal).toBe(ac.signal);
	});
});

// ---------------------------------------------------------------------------
// exportOrg
// ---------------------------------------------------------------------------

describe("IdentityResource.exportOrg", () => {
	it("GETs /orgs/{orgId}/export and returns the array as-is", async () => {
		const records = [{ type: "agent" }, { type: "message" }];
		const { http, calls } = makeHttp("/tmp/x", (method, p) => {
			if (method === "GET" && p === "/agents") return [];
			if (method === "GET" && p === "/org") return sampleOrg();
			if (method === "GET" && p === `/orgs/${ORG_ID}/export`) return records;
			return null;
		});
		const identity = new IdentityResource(http);

		const out = await identity.exportOrg();

		expect(out).toEqual(records);
		expect(calls.some((c) => c.path === `/orgs/${ORG_ID}/export`)).toBe(true);
	});

	it("parses NDJSON when the response comes back as a string", async () => {
		const ndjson = '{"type":"agent"}\n{"type":"message"}\n';
		const { http } = makeHttp("/tmp/x", (method, p) => {
			if (method === "GET" && p === "/agents") return [];
			if (method === "GET" && p === "/org") return sampleOrg();
			if (method === "GET" && p === `/orgs/${ORG_ID}/export`) return ndjson;
			return null;
		});
		const identity = new IdentityResource(http);

		const out = await identity.exportOrg();

		expect(out).toEqual([{ type: "agent" }, { type: "message" }]);
	});

	it("wraps a single-object response in an array", async () => {
		const { http } = makeHttp("/tmp/x", (method, p) => {
			if (method === "GET" && p === "/agents") return [];
			if (method === "GET" && p === "/org") return sampleOrg();
			if (method === "GET" && p === `/orgs/${ORG_ID}/export`) return { type: "a" };
			return null;
		});
		const identity = new IdentityResource(http);

		const out = await identity.exportOrg();

		expect(out).toEqual([{ type: "a" }]);
	});
});

// ---------------------------------------------------------------------------
// Lazy org-ID cache
// ---------------------------------------------------------------------------

describe("IdentityResource — lazy org-ID cache", () => {
	it("calls whoami once, then reuses the cached ID across erase/export", async () => {
		let orgCalls = 0;
		const { http } = makeHttp("/tmp/x", (method, p) => {
			if (method === "GET" && p === "/agents") return [];
			if (method === "GET" && p === "/org") {
				orgCalls++;
				return sampleOrg();
			}
			if (method === "DELETE" && p === `/orgs/${ORG_ID}`) return sampleErasure();
			if (method === "GET" && p === `/orgs/${ORG_ID}/export`) return [];
			return null;
		});
		const identity = new IdentityResource(http);

		await identity.exportOrg();
		await identity.eraseOrg({ confirm: true });

		// First exportOrg fetched /org once; second eraseOrg hits the cache.
		expect(orgCalls).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// ErasureResultSchema — groups_deleted default
// ---------------------------------------------------------------------------

describe("ErasureResultSchema", () => {
	it("accepts responses without groups_deleted (legacy server) and defaults to 0", () => {
		const parsed = ErasureResultSchema.parse({
			org_id: ORG_ID,
			erased_at: "2026-04-13T13:00:00Z",
			messages_deleted: 1,
			agents_deleted: 1,
			conversations_deleted: 1,
		});
		expect(parsed.groups_deleted).toBe(0);
	});

	it("preserves groups_deleted when present", () => {
		const parsed = ErasureResultSchema.parse({
			org_id: ORG_ID,
			erased_at: "2026-04-13T13:00:00Z",
			messages_deleted: 1,
			agents_deleted: 1,
			conversations_deleted: 1,
			groups_deleted: 4,
		});
		expect(parsed.groups_deleted).toBe(4);
	});
});
