import * as fs from "node:fs";
import * as path from "node:path";
import {
	AgentIdMismatchError,
	agentKeysFromDerived,
	deriveAgent,
	getProfile,
	loadAgentKeys,
} from "@rine-network/core";
import {
	type CustodyFixture,
	makeCustodyFixture,
} from "@rine-network/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AGENT_ID,
	CANONICAL_UUID,
	mainBranch,
	makeHttpStub,
} from "../_identity-stub.js";
import { IdentityResource } from "./identity.js";

// ---------------------------------------------------------------------------
// createAgent
// ---------------------------------------------------------------------------

describe("IdentityResource.createAgent", () => {
	let fx: CustodyFixture;
	let prevSpiffe: string | undefined;

	beforeEach(() => {
		fx = makeCustodyFixture();
		prevSpiffe = process.env.SPIFFE_ENDPOINT_SOCKET;
		// biome-ignore lint/performance/noDelete: test-scoped env teardown.
		delete process.env.SPIFFE_ENDPOINT_SOCKET;
	});
	afterEach(() => {
		fx.cleanup();
		if (prevSpiffe !== undefined) {
			process.env.SPIFFE_ENDPOINT_SOCKET = prevSpiffe;
		}
	});

	it("mints an id, posts the branch key material, and persists the derived leaf keys", async () => {
		const { http, posts } = makeHttpStub(fx);
		const identity = new IdentityResource(http);

		const agent = await identity.createAgent("alice");

		// Single POST /agents with a client-minted canonical UUID.
		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toBe("/agents");
		const body = posts[0]?.body as Record<string, unknown>;
		expect(body.id).toBe(agent.id);
		expect(body.id).toMatch(CANONICAL_UUID);
		expect(body.name).toBe("alice");
		expect(body.branch).toBe("main");

		// The five public JWKs the server stores for the agent.
		expect(body.signing_public_key).toMatchObject({
			kty: "OKP",
			crv: "Ed25519",
		});
		expect(body.encryption_public_key).toMatchObject({
			kty: "OKP",
			crv: "X25519",
		});
		expect(body.mls_signing_public_key).toMatchObject({
			kty: "OKP",
			crv: "Ed25519",
		});
		expect(body.pq_encryption_public_key).toMatchObject({
			kty: "MLKEM",
			alg: "ML-KEM-768",
		});
		expect(body.pq_signing_public_key).toMatchObject({
			kty: "MLDSA",
			alg: "ML-DSA-65",
		});
		// Base64url-encoded 32-byte Ed25519/X25519 public key is 43 chars.
		expect((body.signing_public_key as { x: string }).x).toHaveLength(43);
		expect((body.encryption_public_key as { x: string }).x).toHaveLength(43);
		// ML-KEM-768 public key is 1184 bytes → 1579 base64url chars.
		expect((body.pq_encryption_public_key as { x: string }).x).toHaveLength(
			1579,
		);
		// The branch-signed certificate travels with the key material.
		expect(typeof body.agent_certificate).toBe("string");
		expect((body.agent_certificate as string).length).toBeGreaterThan(0);
		// No retired client-secret sign-in fields may leak into the body.
		expect(Object.keys(body).some((k) => k.startsWith("client_"))).toBe(false);

		// Leaf keys persisted under configDir/keys/{agentId}/ and equal to the
		// generation-0 keys derived from the org custody.
		const expected = agentKeysFromDerived(
			deriveAgent(mainBranch(), agent.id, 0),
		);
		const keys = loadAgentKeys(fx.dirs.configDir, agent.id);
		expect(Buffer.from(keys.signing.privateKey)).toEqual(
			Buffer.from(expected.signing.privateKey),
		);
		expect(Buffer.from(keys.encryption.privateKey)).toEqual(
			Buffer.from(expected.encryption.privateKey),
		);
		expect(Buffer.from(keys.pqEncryption?.privateKey as Uint8Array)).toEqual(
			Buffer.from(expected.pqEncryption?.privateKey as Uint8Array),
		);
		// The persisted public half must match what was posted.
		expect(Buffer.from(keys.signing.publicKey).toString("base64url")).toBe(
			(body.signing_public_key as { x: string }).x,
		);
		expect(Buffer.from(keys.encryption.publicKey).toString("base64url")).toBe(
			(body.encryption_public_key as { x: string }).x,
		);

		expect(agent.id).toMatch(CANONICAL_UUID);
	});

	it("publishes an initial batch of MLS KeyPackages so the agent is MLS-addable (regression: 409 No key packages)", async () => {
		// Without this, a freshly SDK-created agent has no KeyPackages, so any MLS
		// group invite fails 409 — the headline MLS-group feature is unusable.
		// createAgent must mirror rine-core's performAgentCreation and publish a
		// batch best-effort via the core HTTP client (getCoreHttpClient).
		const { http, corePosts } = makeHttpStub(fx);

		const agent = await new IdentityResource(http).createAgent("alice");

		const kpUpload = corePosts.find(
			(c) => c.path === `/agents/${agent.id}/mls/key-packages`,
		);
		expect(kpUpload, "createAgent should upload MLS KeyPackages").toBeDefined();
		const pkgs = (kpUpload?.body as { packages: string[] }).packages;
		expect(Array.isArray(pkgs)).toBe(true);
		expect(pkgs.length).toBeGreaterThan(0);
	});

	it("does not abort agent creation when KeyPackage publish fails (best-effort)", async () => {
		// The publish is best-effort: a core-client failure must never break
		// createAgent (the agent still works on sender-key groups).
		const { http } = makeHttpStub(fx, {
			coreClient: {
				async post() {
					throw new Error("no core client in this environment");
				},
			},
		});

		const agent = await new IdentityResource(http).createAgent("alice");
		expect(agent.id).toMatch(CANONICAL_UUID);
	});

	it("forwards create options to the request body without leaking signal", async () => {
		const { http, posts } = makeHttpStub(fx);
		const identity = new IdentityResource(http);
		const ac = new AbortController();

		await identity.createAgent("bob", {
			human_oversight: false,
			unlisted: true,
			signal: ac.signal,
		});

		// Only the server-accepted fields (`AgentCreate` is `extra="forbid"`)
		// may appear in the wire body. `incoming_policy`/`outgoing_policy` are
		// AgentUpdate territory, not AgentCreate — posting them would 422.
		const body = posts[0]?.body as Record<string, unknown>;
		expect(body.human_oversight).toBe(false);
		expect(body.unlisted).toBe(true);
		expect(body).not.toHaveProperty("incoming_policy");
		expect(body).not.toHaveProperty("outgoing_policy");
		// `signal` belongs on the HTTP opts bag, not in the wire body.
		expect(body).not.toHaveProperty("signal");
		expect(posts[0]?.opts?.signal).toBe(ac.signal);
	});

	it("passes the branch option through to the request body", async () => {
		const { http, posts } = makeHttpStub(fx);

		await new IdentityResource(http).createAgent("alice", {
			branch: "feature",
		});

		const body = posts[0]?.body as Record<string, unknown>;
		expect(body.branch).toBe("feature");
	});

	it("writes the server's poll_url into the runtime agent profile", async () => {
		const pollUrl = "https://api.test/poll/tok123";
		const { http } = makeHttpStub(fx, { pollUrl });

		const agent = await new IdentityResource(http).createAgent("alice");

		const entry = getProfile(fx.dirs.configDir, "default");
		expect(entry?.agent_id).toBe(agent.id);
		expect(entry?.poll_url).toBe(pollUrl);
	});
});
