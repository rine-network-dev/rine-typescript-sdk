/**
 * Per-instance jittered refresh margin (rate-limit-resilience REQ-TS-02, D-4).
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
		loadCredentials: vi.fn(() => ({
			default: { client_id: "c", client_secret: "s" },
		})),
		getOrRefreshToken: getTokenSpy,
		jitteredRefreshMargin: marginSpy,
	};
});

import { SDKHttpClient } from "./http.js";

/** refreshMargin passed on the Nth getOrRefreshToken call (5th positional arg). */
function marginOfCall(n: number): number | undefined {
	const args = getTokenSpy.mock.calls[n] as unknown[] | undefined;
	const opts = args?.[4] as { refreshMargin?: number } | undefined;
	return opts?.refreshMargin;
}

describe("SDKHttpClient per-instance refresh margin (REQ-TS-02)", () => {
	beforeEach(() => {
		getTokenSpy.mockClear();
		marginSpy.mockReset();
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
	});

	it("draws the margin once at construction and reuses it across requests", async () => {
		marginSpy.mockReturnValue(90);
		const http = new SDKHttpClient({ apiUrl: "https://api.test" });

		await http.get("/agents", { operation: "poll" });
		await http.get("/agents", { operation: "poll" });

		expect(marginSpy).toHaveBeenCalledTimes(1); // drawn once, not per request
		expect(marginOfCall(0)).toBe(90);
		expect(marginOfCall(1)).toBe(90);
	});

	it("gives co-located instances distinct margins so they desynchronize", async () => {
		marginSpy.mockReturnValueOnce(70).mockReturnValueOnce(150);
		const a = new SDKHttpClient({ apiUrl: "https://api.test" });
		const b = new SDKHttpClient({ apiUrl: "https://api.test" });

		await a.get("/agents", { operation: "poll" });
		await b.get("/agents", { operation: "poll" });

		expect(marginOfCall(0)).toBe(70);
		expect(marginOfCall(1)).toBe(150);
	});
});
