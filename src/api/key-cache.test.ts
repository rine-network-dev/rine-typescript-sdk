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
		getOrRefreshToken: getTokenSpy,
	};
});

import {
	KeyChainError,
	fetchAgentKeys,
	fetchRecipientKeys,
} from "@rine-network/core";
import {
	type CustodyFixture,
	makeCustodyFixture,
	publishedKeys,
	seedAgent,
} from "@rine-network/core/testing";
import { SDKHttpClient } from "./http.js";

const PEER_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

/** A client acting as the fixture's seeded agent, so the key chain verifies. */
function sdkClient(fx: CustodyFixture): SDKHttpClient {
	return new SDKHttpClient({
		apiUrl: "https://api.test",
		configDir: fx.dirs.configDir,
		ownerDir: fx.dirs.ownerDir,
		profile: "agent",
	});
}

describe("SDKHttpClient peer-key cache", () => {
	let fx: CustodyFixture;
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		getTokenSpy.mockClear();
		fx = makeCustodyFixture();
		seedAgent(fx, PEER_ID);
		// The full, verifiable key chain for the fixture-org peer.
		fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify(publishedKeys(PEER_ID)), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchSpy);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		fx.cleanup();
	});

	it("serves a verify from the cache another operation's client filled", async () => {
		const http = sdkClient(fx);

		const first = await fetchAgentKeys(http.getCoreHttpClient(), PEER_ID);
		const second = await fetchAgentKeys(http.getCoreHttpClient(), PEER_ID);

		expect(first.fromCache).toBe(false);
		expect(second.fromCache).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("gives each SDK client its own cache, so one cannot stale another", async () => {
		const a = sdkClient(fx);
		const b = sdkClient(fx);

		await fetchAgentKeys(a.getCoreHttpClient(), PEER_ID);
		const other = await fetchAgentKeys(b.getCoreHttpClient(), PEER_ID);

		expect(other.fromCache).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("still fetches fresh for an outbound seal after a verify filled the cache", async () => {
		const http = sdkClient(fx);

		await fetchAgentKeys(http.getCoreHttpClient(), PEER_ID);
		await fetchRecipientKeys(http.getCoreHttpClient(), PEER_ID);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("keeps a peer pinned to its first org across operations", async () => {
		const http = sdkClient(fx);
		const rehomed = publishedKeys(PEER_ID, 0, new Uint8Array(32).fill(9));
		expect(rehomed.org_id).not.toBe(publishedKeys(PEER_ID).org_id);

		await fetchRecipientKeys(http.getCoreHttpClient(), PEER_ID);
		fetchSpy.mockImplementation(
			async () =>
				new Response(JSON.stringify(rehomed), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);

		await expect(
			fetchRecipientKeys(http.getCoreHttpClient(), PEER_ID),
		).rejects.toThrow(KeyChainError);
	});
});
