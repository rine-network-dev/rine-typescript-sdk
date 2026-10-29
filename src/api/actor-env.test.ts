/**
 * A structural guard: **the SDK reads no environment for the acting agent.**
 *
 * `rine-mastra` builds a bare `AsyncRineClient` whenever its operator passed no
 * `agent` (`rine-mastra/src/client.ts`), and mastra's actor is
 * operator-fixed — chosen at construction, never from anything model- or
 * ambient-visible. An `RINE_AGENT` read anywhere inside this package would
 * silently become that client's actor. It was written once and reverted in
 * full; these tests fail if it comes back.
 *
 * `agentHeader` is not transport-only either: it is the identity a send is
 * attributed and signed as (`resources/messages.ts` `defaultAgentHint`), the
 * self-handle `conversation(msg)` derives its peer from, and the value
 * `withOptions` carries into every derived client. So "no env" is a correctness
 * property of four surfaces, not a style preference.
 *
 * Rung 3 of the ladder still exists — it lives in `rine-core`'s `actorFromEnv()`
 * and each *surface* (CLI, MCP, eve) calls it and passes the result in here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Auth is a transport concern the wire test has to get past: the authenticated
// path loads credentials off disk and mints a token. Stub both, and nothing
// else — `normalizeActor` and `ACTING_AGENT_HEADER` must be the real ones.
vi.mock("@rine-network/core", async () => {
	const actual =
		await vi.importActual<typeof import("@rine-network/core")>(
			"@rine-network/core",
		);
	return {
		...actual,
		getOrRefreshToken: vi.fn(async () => "stub-token"),
	};
});

import { AsyncRineClient } from "../client.js";
import { SDKHttpClient } from "./http.js";

/** The wire name, spelled literally on purpose. Importing the constant here
 * would assert it against itself and pass just as happily if it were renamed
 * to `X-Wrong`. */
const HEADER = "X-Rine-Agent";
const ENV_KEY = "RINE_AGENT";
const API_URL = "https://api.test.rine.network";

interface FetchCall {
	url: string;
	init: RequestInit;
}

/** Record every outbound request and answer each with an empty 200. */
function installFetchStub(): FetchCall[] {
	const calls: FetchCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
			calls.push({ url: String(input), init });
			return new Response(JSON.stringify({ items: [], total: 0 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

/** The acting-agent header actually sent, case-insensitively. */
function sentActorHeader(call: FetchCall | undefined): string | undefined {
	const headers = (call?.init.headers ?? {}) as Record<string, string>;
	const hit = Object.entries(headers).find(
		([k]) => k.toLowerCase() === HEADER.toLowerCase(),
	);
	return hit?.[1];
}

let prevEnv: string | undefined;

beforeEach(() => {
	prevEnv = process.env[ENV_KEY];
	process.env[ENV_KEY] = "kofi";
});

afterEach(() => {
	if (prevEnv === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = prevEnv;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("the SDK never inherits an ambient acting agent", () => {
	it("builds no agent header from RINE_AGENT when no agent was passed", () => {
		const http = new SDKHttpClient({ configDir: "/tmp/none", apiUrl: API_URL });
		expect(http.agentHeader).toBeUndefined();
	});

	it("sends no acting-agent header on the wire from a bare client", async () => {
		const calls = installFetchStub();
		const client = new AsyncRineClient({
			configDir: "/tmp/none",
			apiUrl: API_URL,
		});

		await client.identity.listAgents();

		expect(calls).toHaveLength(1);
		expect(sentActorHeader(calls[0])).toBeUndefined();
	});

	it("sends the constructor's agent on the wire — the falsifier for the test above", async () => {
		const calls = installFetchStub();
		const client = new AsyncRineClient({
			configDir: "/tmp/none",
			apiUrl: API_URL,
			agent: "bob",
		});

		await client.identity.listAgents();

		expect(sentActorHeader(calls[0])).toBe("bob");
	});

	it("keeps a derived client header-less — withOptions must not pick the env up either", () => {
		const http = new SDKHttpClient({ configDir: "/tmp/none", apiUrl: API_URL });
		const client = new AsyncRineClient({
			configDir: "/tmp/none",
			apiUrl: API_URL,
		}).withTimeout(1234);

		// `withTimeout` round-trips through `withOptions`, which reads the old
		// client's `agentHeader` — an env rung anywhere on that path would show up
		// here as a header on a client nobody named an agent for.
		expect(http.agentHeader).toBeUndefined();
		expect(client).toBeInstanceOf(AsyncRineClient);
	});
});

describe("the refusal offers only levers this surface has", () => {
	// The other half of "the SDK reads no environment": a refusal that told an
	// SDK caller to `set RINE_AGENT` would send them to a lever that does
	// nothing here — they export it, re-run, and read the identical refusal.
	// `RINE_AGENT` is exported throughout this file, which is what makes the
	// refusal itself the assertion rather than the resolution.
	function orgOfTwo(): unknown[] {
		return [
			{ id: "k-1", name: "kofi", handle: "kofi@acme.rine.network" },
			{ id: "b-1", name: "bob", handle: "bob@acme.rine.network" },
		];
	}

	it("names the SDK's own option, and no environment variable", async () => {
		const client = new AsyncRineClient({
			configDir: "/tmp/none",
			apiUrl: API_URL,
		});

		// A pre-fetched list, so the refusal is reached without a round trip.
		const refused = (
			// biome-ignore lint/suspicious/noExplicitAny: reaching a private resource
			(client as any).messagingResource as {
				resolveSenderId: (
					core: unknown,
					explicit: string | undefined,
					agents: unknown[],
				) => Promise<string>;
			}
		).resolveSenderId({}, undefined, orgOfTwo());

		await expect(refused).rejects.toThrow("This org has more than one agent");
		await expect(refused).rejects.toThrow("Name one of them with agent.");
		await expect(refused).rejects.not.toThrow(ENV_KEY);
	});
});

describe("the constructor's agent is normalised once", () => {
	it("trims a padded agent before it reaches the header", () => {
		const http = new SDKHttpClient({ agent: "  bob  ", apiUrl: API_URL });
		expect(http.agentHeader).toEqual({ [HEADER]: "bob" });
	});

	it("treats a whitespace-only agent as no agent at all", () => {
		const http = new SDKHttpClient({ agent: "   ", apiUrl: API_URL });
		expect(http.agentHeader).toBeUndefined();
	});

	it("refuses a non-string agent instead of stringifying it", () => {
		expect(
			() =>
				new SDKHttpClient({
					// A JS caller can reach this; `String({})` would hunt for an agent
					// named "[object Object]" and either find nobody or find somebody.
					agent: {} as unknown as string,
					apiUrl: API_URL,
				}),
		).toThrow(/must be a name, handle or UUID \(got object\)/);
	});
});
