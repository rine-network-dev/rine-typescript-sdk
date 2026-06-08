import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAgentKeys } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SDKHttpClient } from "../api/http.js";
import type { AgentUuid } from "../types.js";
import { IdentityResource } from "./identity.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface PostCall {
	path: string;
	body: unknown;
	opts: { signal?: AbortSignal } | undefined;
}

/**
 * Minimal SDKHttpClient stub that records POST calls and returns a canned
 * response. Only the fields `IdentityResource` actually reads are populated;
 * the rest of the surface is unreachable in this test.
 */
function makeHttpStub(
	configDir: string,
	response: unknown,
): { http: SDKHttpClient; posts: PostCall[] } {
	const posts: PostCall[] = [];
	const stub = {
		get configDir() {
			return configDir;
		},
		async post<T>(
			p: string,
			body?: unknown,
			opts?: { signal?: AbortSignal },
		): Promise<T> {
			posts.push({ path: p, body, opts });
			return response as T;
		},
	} as unknown as SDKHttpClient;
	return { http: stub, posts };
}

function sampleAgentRead(
	agentId: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: agentId,
		name: "alice",
		handle: "alice@acme.rine.network",
		human_oversight: true,
		incoming_policy: "accept_all",
		outgoing_policy: "send_all",
		created_at: "2026-04-11T12:00:00Z",
		...overrides,
	};
}

// Valid UUID v4 shape required by rine-core's `validatePathId` regex.
const AGENT_ID = "11111111-1111-4111-8111-111111111111" as AgentUuid;

// ---------------------------------------------------------------------------
// createAgent
// ---------------------------------------------------------------------------

describe("IdentityResource.createAgent", () => {
	let configDir: string;

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "rine-sdk-identity-"));
	});
	afterEach(() => {
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	it("generates keypairs, posts public JWKs, and persists private keys", async () => {
		const { http, posts } = makeHttpStub(configDir, sampleAgentRead(AGENT_ID));
		const identity = new IdentityResource(http);

		const agent = await identity.createAgent("alice");

		// Single POST /agents with JWK-encoded public keys in the body.
		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toBe("/agents");
		const body = posts[0]?.body as Record<string, unknown>;
		expect(body.name).toBe("alice");
		expect(body.signing_public_key).toMatchObject({
			kty: "OKP",
			crv: "Ed25519",
		});
		expect(body.encryption_public_key).toMatchObject({
			kty: "OKP",
			crv: "X25519",
		});
		// Base64url-encoded 32-byte Ed25519/X25519 public key is 43 chars.
		const sigJwk = body.signing_public_key as { x: string };
		const encJwk = body.encryption_public_key as { x: string };
		expect(sigJwk.x).toHaveLength(43);
		expect(encJwk.x).toHaveLength(43);
		// Private key material must never appear in the posted body (no `d` field).
		expect(sigJwk).not.toHaveProperty("d");
		expect(encJwk).not.toHaveProperty("d");

		// Private keys persisted under configDir/keys/{agentId}/ with correct contents.
		const keys = loadAgentKeys(configDir, AGENT_ID);
		expect(keys.signing.privateKey).toHaveLength(32);
		expect(keys.encryption.privateKey).toHaveLength(32);
		// The persisted public half must match what was posted.
		const loadedSigPubB64 = Buffer.from(keys.signing.publicKey).toString(
			"base64url",
		);
		const loadedEncPubB64 = Buffer.from(keys.encryption.publicKey).toString(
			"base64url",
		);
		expect(loadedSigPubB64).toBe(sigJwk.x);
		expect(loadedEncPubB64).toBe(encJwk.x);

		expect(agent.id).toBe(AGENT_ID);
	});

	it("uploads the post-quantum encryption public key as an ML-KEM JWK", async () => {
		// H1 regression: createAgent omitted pq_encryption_public_key entirely,
		// so the server never learned the agent's ML-KEM key and could not
		// advertise it to senders — silently disabling hpke-hybrid-v1.
		const { http, posts } = makeHttpStub(configDir, sampleAgentRead(AGENT_ID));
		const identity = new IdentityResource(http);

		await identity.createAgent("alice");

		const body = posts[0]?.body as Record<string, unknown>;
		expect(body).toHaveProperty("pq_encryption_public_key");
		const pqJwk = body.pq_encryption_public_key as {
			kty: string;
			alg: string;
			x: string;
			d?: string;
		};
		expect(pqJwk).toMatchObject({ kty: "MLKEM", alg: "ML-KEM-768" });
		// ML-KEM-768 public key is 1184 bytes → 1579 base64url chars.
		expect(pqJwk.x).toHaveLength(1579);
		// The persisted private half must never appear in the wire body.
		expect(pqJwk).not.toHaveProperty("d");

		// The posted PQ public key must match the persisted PQ private keypair's
		// public half, proving it is the real generated key, not a placeholder.
		const keys = loadAgentKeys(configDir, AGENT_ID);
		expect(keys.pqEncryption).toBeDefined();
		const loadedPqPubB64 = Buffer.from(
			keys.pqEncryption?.publicKey as Uint8Array,
		).toString("base64url");
		expect(loadedPqPubB64).toBe(pqJwk.x);
	});

	it("forwards create options to the request body without leaking signal", async () => {
		const { http, posts } = makeHttpStub(configDir, sampleAgentRead(AGENT_ID));
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

	it("refuses to persist keys when configDir is empty (CWD footgun)", async () => {
		const { http, posts } = makeHttpStub("", sampleAgentRead(AGENT_ID));
		const identity = new IdentityResource(http);

		await expect(identity.createAgent("dave")).rejects.toThrow(
			/requires a non-empty SDK configDir/,
		);
		// Guard must run before the POST so no server-side agent is orphaned.
		expect(posts).toHaveLength(0);
	});

	it("does not save keys when the POST rejects", async () => {
		const posts: PostCall[] = [];
		const http = {
			get configDir() {
				return configDir;
			},
			async post() {
				posts.push({
					path: "/agents",
					body: undefined,
					opts: undefined,
				});
				throw new Error("network down");
			},
		} as unknown as SDKHttpClient;
		const identity = new IdentityResource(http);

		await expect(identity.createAgent("carol")).rejects.toThrow("network down");

		// No keys directory created since we never reached saveAgentKeys.
		expect(fs.existsSync(path.join(configDir, "keys"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// rotateKeys
// ---------------------------------------------------------------------------

describe("IdentityResource.rotateKeys", () => {
	let configDir: string;

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "rine-sdk-identity-"));
	});
	afterEach(() => {
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	it("posts fresh public JWKs to /agents/{id}/keys and overwrites on-disk keys", async () => {
		const { http, posts } = makeHttpStub(configDir, sampleAgentRead(AGENT_ID));
		const identity = new IdentityResource(http);

		// Seed a pre-existing keypair for the agent by calling createAgent first
		// so the subsequent rotate has something to overwrite.
		await identity.createAgent("alice");
		const originalKeys = loadAgentKeys(configDir, AGENT_ID);
		posts.length = 0;

		// Stub a second response for the rotate call.
		const rotated = await identity.rotateKeys(AGENT_ID);

		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toBe(`/agents/${AGENT_ID}/keys`);
		const body = posts[0]?.body as Record<string, unknown>;
		expect(body.signing_public_key).toMatchObject({
			kty: "OKP",
			crv: "Ed25519",
		});
		expect(body.encryption_public_key).toMatchObject({
			kty: "OKP",
			crv: "X25519",
		});

		const newKeys = loadAgentKeys(configDir, AGENT_ID);
		// Rotation must actually produce fresh key material.
		expect(Buffer.from(newKeys.signing.privateKey)).not.toEqual(
			Buffer.from(originalKeys.signing.privateKey),
		);
		expect(Buffer.from(newKeys.encryption.privateKey)).not.toEqual(
			Buffer.from(originalKeys.encryption.privateKey),
		);
		expect(rotated.id).toBe(AGENT_ID);
	});

	it("uploads a fresh ML-KEM public key on rotation", async () => {
		// H1 regression: rotateKeys also omitted pq_encryption_public_key, so a
		// post-rotation agent silently lost its ability to receive hpke-hybrid-v1.
		const { http, posts } = makeHttpStub(configDir, sampleAgentRead(AGENT_ID));
		const identity = new IdentityResource(http);

		await identity.createAgent("alice");
		const originalKeys = loadAgentKeys(configDir, AGENT_ID);
		posts.length = 0;

		await identity.rotateKeys(AGENT_ID);

		expect(posts[0]?.path).toBe(`/agents/${AGENT_ID}/keys`);
		const body = posts[0]?.body as Record<string, unknown>;
		expect(body).toHaveProperty("pq_encryption_public_key");
		const pqJwk = body.pq_encryption_public_key as {
			kty: string;
			alg: string;
			x: string;
			d?: string;
		};
		expect(pqJwk).toMatchObject({ kty: "MLKEM", alg: "ML-KEM-768" });
		expect(pqJwk.x).toHaveLength(1579);
		expect(pqJwk).not.toHaveProperty("d");

		// Rotation must mint a brand-new ML-KEM keypair, and the uploaded public
		// key must match the new on-disk PQ private key — not the pre-rotation one.
		const newKeys = loadAgentKeys(configDir, AGENT_ID);
		expect(Buffer.from(newKeys.pqEncryption?.privateKey as Uint8Array)).not.toEqual(
			Buffer.from(originalKeys.pqEncryption?.privateKey as Uint8Array),
		);
		const newPqPubB64 = Buffer.from(
			newKeys.pqEncryption?.publicKey as Uint8Array,
		).toString("base64url");
		expect(newPqPubB64).toBe(pqJwk.x);
	});

	it("forwards the caller's AbortSignal to the underlying POST", async () => {
		const { http, posts } = makeHttpStub(configDir, sampleAgentRead(AGENT_ID));
		const identity = new IdentityResource(http);
		const ac = new AbortController();

		await identity.rotateKeys(AGENT_ID, { signal: ac.signal });

		expect(posts[0]?.opts?.signal).toBe(ac.signal);
	});

	it("leaves existing on-disk keys intact when the POST rejects", async () => {
		// Seed the on-disk keys with a first createAgent call.
		const seed = makeHttpStub(configDir, sampleAgentRead(AGENT_ID));
		await new IdentityResource(seed.http).createAgent("alice");
		const originalKeys = loadAgentKeys(configDir, AGENT_ID);

		// Now swap in an HTTP stub whose POST always rejects.
		const failingHttp = {
			get configDir() {
				return configDir;
			},
			async post() {
				throw new Error("network down");
			},
		} as unknown as SDKHttpClient;
		const identity = new IdentityResource(failingHttp);

		await expect(identity.rotateKeys(AGENT_ID)).rejects.toThrow("network down");

		// Keys on disk must still be the originals — rotate never reached saveAgentKeys.
		const afterKeys = loadAgentKeys(configDir, AGENT_ID);
		expect(Buffer.from(afterKeys.signing.privateKey)).toEqual(
			Buffer.from(originalKeys.signing.privateKey),
		);
		expect(Buffer.from(afterKeys.encryption.privateKey)).toEqual(
			Buffer.from(originalKeys.encryption.privateKey),
		);
	});

	it("refuses to rotate when configDir is empty (CWD footgun)", async () => {
		const { http, posts } = makeHttpStub("", sampleAgentRead(AGENT_ID));
		const identity = new IdentityResource(http);

		await expect(identity.rotateKeys(AGENT_ID)).rejects.toThrow(
			/requires a non-empty SDK configDir/,
		);
		expect(posts).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// addPostQuantumKey
// ---------------------------------------------------------------------------

describe("IdentityResource.addPostQuantumKey", () => {
	let configDir: string;

	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "rine-sdk-identity-"));
	});
	afterEach(() => {
		fs.rmSync(configDir, { recursive: true, force: true });
	});

	it("generates PQ key, posts with existing signing+encryption, and persists PQ on disk", async () => {
		const { http, posts } = makeHttpStub(configDir, sampleAgentRead(AGENT_ID));
		const identity = new IdentityResource(http);

		await identity.createAgent("alice");
		const originalKeys = loadAgentKeys(configDir, AGENT_ID);
		posts.length = 0;

		const pqKeyFile = path.join(configDir, "keys", AGENT_ID, "pq_encryption.key");
		fs.unlinkSync(pqKeyFile);

		const agent = await identity.addPostQuantumKey(AGENT_ID);

		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toBe(`/agents/${AGENT_ID}/keys`);
		const body = posts[0]?.body as Record<string, unknown>;
		expect(body).toHaveProperty("pq_encryption_public_key");
		const pqJwk = body.pq_encryption_public_key as { kty: string; alg: string; x: string };
		expect(pqJwk).toMatchObject({ kty: "MLKEM", alg: "ML-KEM-768" });
		expect(pqJwk.x).toHaveLength(1579);

		const sigJwk = body.signing_public_key as { x: string };
		expect(sigJwk.x).toBe(Buffer.from(originalKeys.signing.publicKey).toString("base64url"));

		const newKeys = loadAgentKeys(configDir, AGENT_ID);
		expect(newKeys.pqEncryption).toBeDefined();
		expect(Buffer.from(newKeys.signing.privateKey)).toEqual(Buffer.from(originalKeys.signing.privateKey));
		expect(Buffer.from(newKeys.encryption.privateKey)).toEqual(Buffer.from(originalKeys.encryption.privateKey));
		expect(agent.id).toBe(AGENT_ID);
	});

	it("throws RineError when PQ key already exists", async () => {
		const { http } = makeHttpStub(configDir, sampleAgentRead(AGENT_ID));
		const identity = new IdentityResource(http);
		await identity.createAgent("alice");

		await expect(identity.addPostQuantumKey(AGENT_ID)).rejects.toThrow(
			/already has a post-quantum key/,
		);
	});

	it("does not save PQ key when POST rejects", async () => {
		const seed = makeHttpStub(configDir, sampleAgentRead(AGENT_ID));
		await new IdentityResource(seed.http).createAgent("alice");

		const pqKeyFile = path.join(configDir, "keys", AGENT_ID, "pq_encryption.key");
		fs.unlinkSync(pqKeyFile);

		const failingHttp = {
			get configDir() { return configDir; },
			async post() { throw new Error("network down"); },
		} as unknown as SDKHttpClient;
		const identity = new IdentityResource(failingHttp);

		await expect(identity.addPostQuantumKey(AGENT_ID)).rejects.toThrow("network down");
		expect(fs.existsSync(pqKeyFile)).toBe(false);
	});

	it("refuses when configDir is empty", async () => {
		const { http, posts } = makeHttpStub("", sampleAgentRead(AGENT_ID));
		const identity = new IdentityResource(http);

		await expect(identity.addPostQuantumKey(AGENT_ID)).rejects.toThrow(
			/requires a non-empty SDK configDir/,
		);
		expect(posts).toHaveLength(0);
	});

	it("forwards the caller AbortSignal", async () => {
		const { http, posts } = makeHttpStub(configDir, sampleAgentRead(AGENT_ID));
		const identity = new IdentityResource(http);
		await identity.createAgent("alice");
		posts.length = 0;

		const pqKeyFile = path.join(configDir, "keys", AGENT_ID, "pq_encryption.key");
		fs.unlinkSync(pqKeyFile);

		const ac = new AbortController();
		await identity.addPostQuantumKey(AGENT_ID, { signal: ac.signal });

		expect(posts[0]?.opts?.signal).toBe(ac.signal);
	});
});
