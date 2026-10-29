/**
 * The client-start escrow sweep.
 *
 * Files a previous process left behind (a leave or a recovery ends the process
 * that wrote them) must be cleared on the client's first request, once, without
 * the request waiting on it. The sweep itself is core's; this pins that the
 * client calls it with its own config dir, once per instance, and survives it
 * failing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sweepSpy } = vi.hoisted(() => ({ sweepSpy: vi.fn() }));

vi.mock("@rine-network/core", async () => {
	const actual =
		await vi.importActual<typeof import("@rine-network/core")>(
			"@rine-network/core",
		);
	return { ...actual, startupEscrowSweep: sweepSpy };
});

import {
	type CustodyFixture,
	makeCustodyFixture,
	seedAgent,
} from "@rine-network/core/testing";
import { SDKHttpClient } from "./http.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

describe("SDKHttpClient start-up escrow sweep", () => {
	let fx: CustodyFixture;

	beforeEach(() => {
		sweepSpy.mockReset();
		sweepSpy.mockResolvedValue(undefined);
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

	it("test_first_request_when_the_client_starts_then_it_sweeps_its_config_dir_once", async () => {
		const http = client();
		expect(sweepSpy).not.toHaveBeenCalled();

		await http.get("/agents", { operation: "poll" });
		await http.get("/agents", { operation: "poll" });

		expect(sweepSpy).toHaveBeenCalledTimes(1);
		expect(sweepSpy.mock.calls[0]?.[1]).toBe(fx.dirs.configDir);
	});

	it("test_first_request_when_the_principal_is_an_agent_then_the_sweep_is_scoped_to_that_agent", async () => {
		await client().get("/agents", { operation: "poll" });

		expect(sweepSpy.mock.calls[0]?.[2]).toBe(AGENT_ID);
	});

	it("test_first_request_when_the_sweep_rejects_then_the_request_still_succeeds", async () => {
		sweepSpy.mockRejectedValue(new Error("sweep failed"));

		await expect(
			client().get("/agents", { operation: "poll" }),
		).resolves.toEqual({});
	});

	it("test_first_request_when_the_sweep_never_settles_then_the_request_does_not_wait", async () => {
		sweepSpy.mockReturnValue(new Promise(() => {}));

		await expect(
			client().get("/agents", { operation: "poll" }),
		).resolves.toEqual({});
	});
});
