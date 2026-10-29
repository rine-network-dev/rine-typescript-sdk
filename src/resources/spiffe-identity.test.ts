import { SpiffeVerificationError } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SDKHttpClient } from "../api/http.js";
import { ValidationError } from "../errors.js";
import type { AgentUuid } from "../types.js";
import {
	type CustodyFixture,
	makeCustodyFixture,
} from "@rine-network/core/testing";
import { IdentityResource } from "./identity.js";

// ---------------------------------------------------------------------------
// Test helpers — in-memory transport, no network (mirrors identity.test.ts).
// ---------------------------------------------------------------------------

interface PostCall {
	path: string;
	body: unknown;
	opts: { signal?: AbortSignal; operation?: string } | undefined;
}

// Valid UUID v4 shape required by rine-core's `validatePathId` regex.
const AGENT_ID = "11111111-1111-4111-8111-111111111111" as AgentUuid;

// A stand-in ES256 JWT-SVID (compact JWS). Content is opaque to the SDK — the
// server performs the real signature/claims verification, which these tests
// mock. Its only job is to be a non-empty string the SDK forwards verbatim.
const ES256_SVID = "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJ4In0.c2ln";

const CHALLENGE_PATH = `/agents/${AGENT_ID}/verify-svid/challenge`;
const VERIFY_PATH = `/agents/${AGENT_ID}/verify-svid`;

function sampleVerifyResult(overrides: Record<string, unknown> = {}) {
	return {
		agent_id: AGENT_ID,
		spiffe_id: "spiffe://acme.example/workload/alice",
		trust_domain: "acme.example",
		trust_tier: 2,
		verified_at: "2026-07-10T12:00:00Z",
		...overrides,
	};
}

/**
 * Records every POST and answers by path: the challenge endpoint returns a
 * canned `{audience, expires_in}`, the verify endpoint returns the supplied
 * `verifyResponse` (or throws it when it's an Error, to model a server 4xx).
 */
function makeVerifyStub(verifyResponse: unknown): {
	http: SDKHttpClient;
	posts: PostCall[];
} {
	const posts: PostCall[] = [];
	const stub = {
		async post<T>(
			p: string,
			body?: unknown,
			opts?: { signal?: AbortSignal; operation?: string },
		): Promise<T> {
			posts.push({ path: p, body, opts });
			if (p.endsWith("/verify-svid/challenge")) {
				return {
					audience: "spiffe://challenge.rine.network/tok123",
					expires_in: 300,
				} as T;
			}
			if (verifyResponse instanceof Error) throw verifyResponse;
			return verifyResponse as T;
		},
	} as unknown as SDKHttpClient;
	return { http: stub, posts };
}

// ---------------------------------------------------------------------------
// verifyIdentity
// ---------------------------------------------------------------------------

describe("IdentityResource.verifyIdentity", () => {
	it("posts challenge then verify with {svid} in order and returns the typed result (ES256 happy path)", async () => {
		const { http, posts } = makeVerifyStub(sampleVerifyResult());
		const identity = new IdentityResource(http);

		const result = await identity.verifyIdentity(AGENT_ID, {
			svid: ES256_SVID,
		});

		// Exactly two POSTs, in order: challenge → verify.
		expect(posts.map((p) => p.path)).toEqual([CHALLENGE_PATH, VERIFY_PATH]);
		// Challenge body is empty; verify body carries the SVID verbatim.
		expect(posts[0]?.body).toBeUndefined();
		expect(posts[1]?.body).toEqual({ svid: ES256_SVID });
		// Both legs are labelled with the stable telemetry operation.
		expect(posts[0]?.opts?.operation).toBe("verifyIdentity");
		expect(posts[1]?.opts?.operation).toBe("verifyIdentity");
		// Typed result surfaced unchanged.
		expect(result).toMatchObject({
			agent_id: AGENT_ID,
			trust_tier: 2,
			trust_domain: "acme.example",
		});
	});

	it("forwards the caller AbortSignal to both underlying POSTs", async () => {
		const { http, posts } = makeVerifyStub(sampleVerifyResult());
		const identity = new IdentityResource(http);
		const ac = new AbortController();

		await identity.verifyIdentity(AGENT_ID, {
			svid: ES256_SVID,
			signal: ac.signal,
		});

		expect(posts[0]?.opts?.signal).toBe(ac.signal);
		expect(posts[1]?.opts?.signal).toBe(ac.signal);
	});

	it("surfaces a server 4xx (wrong-aud / invalid SVID → 422) as a typed error", async () => {
		// The server returns 422 when the SVID's `aud` does not match the minted
		// challenge audience (or the SVID fails parse/sig). It must propagate as
		// the SDK's typed ValidationError, not be swallowed.
		const { http, posts } = makeVerifyStub(
			new ValidationError("challenge audience mismatch"),
		);
		const identity = new IdentityResource(http);

		await expect(
			identity.verifyIdentity(AGENT_ID, { svid: ES256_SVID }),
		).rejects.toBeInstanceOf(ValidationError);
		// The challenge leg still ran, then the verify leg raised.
		expect(posts.map((p) => p.path)).toEqual([CHALLENGE_PATH, VERIFY_PATH]);
	});

	it("throws SpiffeVerificationError when no SVID and no endpoint (no silent no-op)", async () => {
		// Guard: SPIFFE_ENDPOINT_SOCKET must be absent for the `no-svid` branch.
		const prev = process.env.SPIFFE_ENDPOINT_SOCKET;
		// biome-ignore lint/performance/noDelete: test-scoped env teardown.
		delete process.env.SPIFFE_ENDPOINT_SOCKET;

		const { http, posts } = makeVerifyStub(sampleVerifyResult());
		const identity = new IdentityResource(http);

		try {
			const err = await identity
				.verifyIdentity(AGENT_ID)
				.then(() => null)
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(SpiffeVerificationError);
			expect((err as SpiffeVerificationError).reason).toBe("no-svid");
			// It threw rather than returning — and never posted the verify leg.
			expect(posts.map((p) => p.path)).toEqual([CHALLENGE_PATH]);
		} finally {
			if (prev !== undefined) process.env.SPIFFE_ENDPOINT_SOCKET = prev;
		}
	});
});

// ---------------------------------------------------------------------------
// createAgent auto-verify hook
// ---------------------------------------------------------------------------

describe("IdentityResource.createAgent auto-verify hook", () => {
	let fx: CustodyFixture;

	beforeEach(() => {
		fx = makeCustodyFixture();
	});
	afterEach(() => {
		fx.cleanup();
	});

	function agentAnswerStub(verifyResponse: unknown): {
		http: SDKHttpClient;
		posts: PostCall[];
	} {
		const posts: PostCall[] = [];
		const stub = {
			get configDir() {
				return fx.dirs.configDir;
			},
			get ownerDir() {
				return fx.dirs.ownerDir;
			},
			get dirs() {
				return fx.dirs;
			},
			custodyDirs() {
				return fx.dirs;
			},
			get profile() {
				return "default";
			},
			async post<T>(
				p: string,
				body?: unknown,
				opts?: { signal?: AbortSignal; operation?: string },
			): Promise<T> {
				posts.push({ path: p, body, opts });
				if (p === "/agents") {
					return {
						id: (body as { id: string }).id,
						name: "alice",
						handle: "alice@acme.rine.network",
						human_oversight: true,
						incoming_policy: "accept_all",
						outgoing_policy: "send_all",
						created_at: "2026-07-10T12:00:00Z",
					} as T;
				}
				if (p.endsWith("/verify-svid/challenge")) {
					return {
						audience: "spiffe://challenge.rine.network/tok123",
						expires_in: 300,
					} as T;
				}
				if (verifyResponse instanceof Error) throw verifyResponse;
				return verifyResponse as T;
			},
			// A core client that cannot post → the MLS publish is best-effort and
			// its catch swallows the TypeError, mirroring identity.test.ts.
			getCoreHttpClient() {
				return {} as never;
			},
		} as unknown as SDKHttpClient;
		return { http: stub, posts };
	}

	it("auto-runs verification when a svid is supplied and attaches the identity result", async () => {
		const { http, posts } = agentAnswerStub(sampleVerifyResult());
		const identity = new IdentityResource(http);

		const agent = await identity.createAgent("alice", { svid: ES256_SVID });

		const mintedId = (posts[0]?.body as { id: string }).id;
		expect(agent.id).toBe(mintedId);
		expect(agent.identity).toMatchObject({ trust_tier: 2 });
		expect(agent.identityError).toBeUndefined();
		// The create → challenge → verify legs all fired.
		expect(posts.map((p) => p.path)).toEqual([
			"/agents",
			`/agents/${mintedId}/verify-svid/challenge`,
			`/agents/${mintedId}/verify-svid`,
		]);
	});

	it("still returns the created agent with identityError set when verification fails", async () => {
		// verifyIdentity:true forces the hook; with no svid and no endpoint the
		// core orchestrator throws SpiffeVerificationError. Creation must stand.
		const prev = process.env.SPIFFE_ENDPOINT_SOCKET;
		// biome-ignore lint/performance/noDelete: test-scoped env teardown.
		delete process.env.SPIFFE_ENDPOINT_SOCKET;
		const { http, posts } = agentAnswerStub(sampleVerifyResult());
		const identity = new IdentityResource(http);

		try {
			const agent = await identity.createAgent("alice", {
				verifyIdentity: true,
			});
			expect(agent.id).toBe((posts[0]?.body as { id: string }).id);
			expect(agent.identity).toBeUndefined();
			expect(agent.identityError).toMatch(/JWT-SVID/);
		} finally {
			if (prev !== undefined) process.env.SPIFFE_ENDPOINT_SOCKET = prev;
		}
	});

	it("does not verify when no trigger is present", async () => {
		const prev = process.env.SPIFFE_ENDPOINT_SOCKET;
		// biome-ignore lint/performance/noDelete: test-scoped env teardown.
		delete process.env.SPIFFE_ENDPOINT_SOCKET;
		const { http, posts } = agentAnswerStub(sampleVerifyResult());
		const identity = new IdentityResource(http);

		try {
			const agent = await identity.createAgent("alice");
			expect(agent.identity).toBeUndefined();
			expect(agent.identityError).toBeUndefined();
			// Only the create POST — no challenge/verify legs.
			expect(posts.map((p) => p.path)).toEqual(["/agents"]);
		} finally {
			if (prev !== undefined) process.env.SPIFFE_ENDPOINT_SOCKET = prev;
		}
	});
});
