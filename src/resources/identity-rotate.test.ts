import * as fs from "node:fs";
import {
	agentKeysFromDerived,
	deriveAgent,
	loadAgentKeys,
	mlsStoreRoot,
} from "@rine-network/core";
import {
	type CustodyFixture,
	makeCustodyFixture,
	publishedKeys,
	seedAgent,
} from "@rine-network/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AGENT_ID,
	type CorePost,
	mainBranch,
	makeHttpStub,
} from "../_identity-stub.js";
import { IdentityResource } from "./identity.js";

// ---------------------------------------------------------------------------
// rotateKeys
// ---------------------------------------------------------------------------

describe("IdentityResource.rotateKeys", () => {
	let fx: CustodyFixture;

	beforeEach(() => {
		fx = makeCustodyFixture();
	});
	afterEach(() => {
		fx.cleanup();
	});

	it("reads the current generation, posts generation-1 keys, and overwrites on-disk keys", async () => {
		seedAgent(fx, AGENT_ID);
		const { http, posts, gets } = makeHttpStub(fx, {
			keysResponse: publishedKeys(AGENT_ID),
		});
		const identity = new IdentityResource(http);

		const rotated = await identity.rotateKeys(AGENT_ID);

		// GET the current key chain, then POST the next generation.
		expect(gets.map((g) => g.path)).toEqual([`/agents/${AGENT_ID}/keys`]);
		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toBe(`/agents/${AGENT_ID}/keys`);
		const body = posts[0]?.body as Record<string, unknown>;
		expect(body.key_gen).toBe(1);
		// Same key-material field names as createAgent.
		expect(body.branch).toBe("main");
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
		expect(typeof body.agent_certificate).toBe("string");
		// Rotation never re-sends the identity fields.
		expect(body).not.toHaveProperty("id");
		expect(body).not.toHaveProperty("name");

		// On-disk leaf keys are now the generation-1 ones.
		const gen1 = agentKeysFromDerived(deriveAgent(mainBranch(), AGENT_ID, 1));
		const gen0 = agentKeysFromDerived(deriveAgent(mainBranch(), AGENT_ID, 0));
		const onDisk = loadAgentKeys(fx.dirs.configDir, AGENT_ID);
		expect(Buffer.from(onDisk.signing.privateKey)).toEqual(
			Buffer.from(gen1.signing.privateKey),
		);
		expect(Buffer.from(onDisk.encryption.privateKey)).toEqual(
			Buffer.from(gen1.encryption.privateKey),
		);
		expect(Buffer.from(onDisk.signing.privateKey)).not.toEqual(
			Buffer.from(gen0.signing.privateKey),
		);
		// The posted public half matches the new on-disk key.
		expect(Buffer.from(onDisk.signing.publicKey).toString("base64url")).toBe(
			(body.signing_public_key as { x: string }).x,
		);
		expect(rotated.id).toBe(AGENT_ID);
		// This host holds no MLS state for the agent, so there is nothing to move.
		expect(rotated).toMatchObject({
			key_packages: "not_held",
			group_seats: [],
		});
	});

	it("settles the rotation as the rotated agent when this host holds its MLS state", async () => {
		seedAgent(fx, AGENT_ID);
		fs.mkdirSync(mlsStoreRoot(fx.dirs.configDir, AGENT_ID), {
			recursive: true,
		});
		const coreGets: string[] = [];
		const corePosts: CorePost[] = [];
		const coreClient = {
			async get(path: string) {
				coreGets.push(path);
				// The rotated agent's current chain: the settlement checks the key on
				// disk against it before it drains or sweeps anything.
				if (path === "/agents/keys") {
					return { keys: { [AGENT_ID]: publishedKeys(AGENT_ID, 1) } };
				}
				if (path === "/groups") return { items: [] };
				return { packages: [], agent_id: AGENT_ID };
			},
			async post(path: string, body: unknown) {
				corePosts.push({ path, body });
				return { stored: (body as { packages: unknown[] }).packages.length };
			},
		};
		const { http } = makeHttpStub(fx, {
			keysResponse: publishedKeys(AGENT_ID),
			coreClient,
		});
		const identity = new IdentityResource(http);

		const rotated = await identity.rotateKeys(AGENT_ID);

		// The key packages were drained and republished through the SDK's own core
		// client, for the rotated agent: the first half of the settlement ran.
		expect(rotated.key_packages).toBe("republished");
		expect(coreGets).toContain(`/agents/${AGENT_ID}/mls/key-packages`);
		expect(corePosts[0]?.path).toBe(`/agents/${AGENT_ID}/mls/key-packages`);
		expect(
			(corePosts[0]?.body as { packages: string[] }).packages.length,
		).toBeGreaterThan(0);
		// The agent is in no group, so the seat half has nothing to move. A seat
		// actually moving is pinned against the real core in rine-core's rotation
		// tests.
		expect(rotated.group_seats).toEqual([]);
	});

	it("refuses to drain or publish when this host holds an earlier key generation than the published one", async () => {
		seedAgent(fx, AGENT_ID);
		fs.mkdirSync(mlsStoreRoot(fx.dirs.configDir, AGENT_ID), {
			recursive: true,
		});
		const corePosts: CorePost[] = [];
		const coreGets: string[] = [];
		const coreClient = {
			async get(path: string) {
				coreGets.push(path);
				if (path === "/agents/keys") {
					return { keys: { [AGENT_ID]: publishedKeys(AGENT_ID, 2) } };
				}
				return { items: [] };
			},
			async post(path: string, body: unknown) {
				corePosts.push({ path, body });
				return { stored: 0 };
			},
		};
		const { http } = makeHttpStub(fx, {
			keysResponse: publishedKeys(AGENT_ID),
			coreClient,
		});

		const rotated = await new IdentityResource(http).rotateKeys(AGENT_ID);

		expect(rotated.key_packages).toBe("key_not_current");
		expect(rotated.group_seats).toMatchObject([
			{ group_id: null, status: "failed", reason: "key_not_current" },
		]);
		expect(corePosts).toEqual([]);
		expect(coreGets).not.toContain(`/agents/${AGENT_ID}/mls/key-packages`);
	});

	it("forwards the caller's AbortSignal to the GET and the POST", async () => {
		seedAgent(fx, AGENT_ID);
		const { http, posts, gets } = makeHttpStub(fx, {
			keysResponse: publishedKeys(AGENT_ID),
		});
		const identity = new IdentityResource(http);
		const ac = new AbortController();

		await identity.rotateKeys(AGENT_ID, { signal: ac.signal });

		expect(gets[0]?.opts?.signal).toBe(ac.signal);
		expect(posts[0]?.opts?.signal).toBe(ac.signal);
	});
});
