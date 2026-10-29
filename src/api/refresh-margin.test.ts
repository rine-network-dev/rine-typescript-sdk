/**
 * Per-instance jittered refresh margin.
 *
 * The desync benefit is only real if each SDKHttpClient draws its own margin at
 * construction and threads it into getOrRefreshToken. These tests drive an
 * authenticated request through the public client surface and assert the margin
 * the core token helper receives is (a) per-instance stable and (b) distinct
 * across co-located instances — i.e. two agents started together no longer
 * refresh in lockstep.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the (also-hoisted) vi.mock factory can close over the spies.
// Distinct margins per constructed client, mirroring what independent RNG draws
// would produce, so the assertion below proves desync rather than a shared value.
const { getTokenSpy, marginSpy } = vi.hoisted(() => ({
	getTokenSpy: vi.fn(async () => "stub-token"),
	marginSpy: vi.fn(),
}));

vi.mock("@rine-network/core", async () => {
	const actual =
		await vi.importActual<typeof import("@rine-network/core")>(
			"@rine-network/core",
		);
	return {
		...actual,
		getOrRefreshToken: getTokenSpy,
		jitteredRefreshMargin: marginSpy,
	};
});

import {
	type CustodyFixture,
	makeCustodyFixture,
	seedAgent,
} from "@rine-network/core/testing";
import { SDKHttpClient } from "./http.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

/** refreshMargin passed on the Nth getOrRefreshToken call (4th positional arg). */
function marginOfCall(n: number): number | undefined {
	const args = getTokenSpy.mock.calls[n] as unknown[] | undefined;
	const opts = args?.[3] as { refreshMargin?: number } | undefined;
	return opts?.refreshMargin;
}

describe("SDKHttpClient per-instance refresh margin", () => {
	let fx: CustodyFixture;

	beforeEach(() => {
		getTokenSpy.mockClear();
		marginSpy.mockReset();
		fx = makeCustodyFixture();
		seedAgent(fx, AGENT_ID);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("{}", {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		fx.cleanup();
	});

	function client(): SDKHttpClient {
		return new SDKHttpClient({
			apiUrl: "https://api.test",
			configDir: fx.dirs.configDir,
			ownerDir: fx.dirs.ownerDir,
			profile: "agent",
		});
	}

	it("draws the margin once at construction and reuses it across requests", async () => {
		marginSpy.mockReturnValue(90);
		const http = client();

		await http.get("/agents", { operation: "poll" });
		await http.get("/agents", { operation: "poll" });

		expect(marginSpy).toHaveBeenCalledTimes(1); // drawn once, not per request
		expect(marginOfCall(0)).toBe(90);
		expect(marginOfCall(1)).toBe(90);
	});

	it("gives co-located instances distinct margins so they desynchronize", async () => {
		marginSpy.mockReturnValueOnce(70).mockReturnValueOnce(150);
		const a = client();
		const b = client();

		await a.get("/agents", { operation: "poll" });
		await b.get("/agents", { operation: "poll" });

		expect(marginOfCall(0)).toBe(70);
		expect(marginOfCall(1)).toBe(150);
	});
});
