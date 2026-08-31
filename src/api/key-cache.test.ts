/**
 * Shared peer-key cache across the SDK's crypto-path clients.
 *
 * The SDK builds a fresh rine-core HttpClient per crypto operation, so a cache
 * owned by that client would never see a second read. These tests drive the
 * public `getCoreHttpClient()` seam and assert (a) an inbound verify pays for a
 * peer's keys once across operations, and (b) an outbound seal still fetches
 * fresh, so a peer's rotation cannot be hidden from a send.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the (also-hoisted) vi.mock factory can close over the spy.
const { getTokenSpy } = vi.hoisted(() => ({
	getTokenSpy: vi.fn(async () => "stub-token"),
}));

vi.mock("@rine-network/core", async () => {
	const actual =
		await vi.importActual<typeof import("@rine-network/core")>(
			"@rine-network/core",
		);
	return {
		...actual,
		loadCredentials: vi.fn(() => ({
			default: { client_id: "c", client_secret: "s" },
		})),
		getOrRefreshToken: getTokenSpy,
	};
});

import {
	fetchAgentKeys,
	fetchRecipientKeys,
	generateAgentKeys,
	signingPublicKeyToJWK,
	toBase64Url,
} from "@rine-network/core";
import { SDKHttpClient } from "./http.js";

const PEER_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

/** A well-formed GET /agents/{id}/keys body for a real generated keypair. */
const PEER_KEYS = generateAgentKeys();
const KEYS_BODY = JSON.stringify({
	agent_id: PEER_ID,
	signing_public_key: signingPublicKeyToJWK(PEER_KEYS.signing.publicKey),
	encryption_public_key: {
		kty: "OKP",
		crv: "X25519",
		x: toBase64Url(PEER_KEYS.encryption.publicKey),
	},
});

function sdkClient(): SDKHttpClient {
	return new SDKHttpClient({
		apiUrl: "https://api.test",
		configDir: "/nonexistent",
	});
}

describe("SDKHttpClient peer-key cache", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		getTokenSpy.mockClear();
		fetchSpy = vi.fn(
			async () =>
				new Response(KEYS_BODY, {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchSpy);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("serves a verify from the cache another operation's client filled", async () => {
		const http = sdkClient();

		const first = await fetchAgentKeys(http.getCoreHttpClient(), PEER_ID);
		const second = await fetchAgentKeys(http.getCoreHttpClient(), PEER_ID);

		expect(first.fromCache).toBe(false);
		expect(second.fromCache).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("gives each SDK client its own cache, so one cannot stale another", async () => {
		const a = sdkClient();
		const b = sdkClient();

		await fetchAgentKeys(a.getCoreHttpClient(), PEER_ID);
		const other = await fetchAgentKeys(b.getCoreHttpClient(), PEER_ID);

		expect(other.fromCache).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("still fetches fresh for an outbound seal after a verify filled the cache", async () => {
		const http = sdkClient();

		await fetchAgentKeys(http.getCoreHttpClient(), PEER_ID);
		await fetchRecipientKeys(http.getCoreHttpClient(), PEER_ID);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});
