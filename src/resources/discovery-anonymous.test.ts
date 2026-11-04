/**
 * Directory discovery needs no credentials.
 *
 * `/directory/agents`, `/directory/agents/{id}`, `/directory/groups` and
 * `/agents/{id}/card` have no auth dependency on the server, and the Python
 * SDK reads them anonymously. These drive a real `AsyncRineClient` over an
 * empty config directory with only `fetch` stubbed, so the assertion covers the
 * wire: no `Authorization` header and no call to the token endpoint. A stub of
 * the http layer could not see a Bearer header being added below it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncRineClient } from "../client.js";
import type { AgentUuid } from "../types.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-01-01T00:00:00Z";

type SeenRequest = { url: string; headers: Headers };

const BODIES: Record<string, unknown> = {
	"/directory/agents": {
		items: [{ id: AGENT_ID, name: "Alice", handle: "alice@acme" }],
		total: 1,
		next_cursor: null,
	},
	[`/directory/agents/${AGENT_ID}`]: {
		id: AGENT_ID,
		name: "Alice",
		handle: "alice@acme",
		created_at: NOW,
	},
	"/directory/groups": {
		items: [{ id: GROUP_ID, name: "Parts", handle: "#parts@acme" }],
		total: 1,
		next_cursor: null,
	},
	[`/agents/${AGENT_ID}/card`]: {
		id: AGENT_ID,
		agent_id: AGENT_ID,
		name: "Alice",
		created_at: NOW,
	},
};

let configDir: string;
let requests: SeenRequest[];

beforeEach(() => {
	configDir = mkdtempSync(join(tmpdir(), "rine-sdk-anon-"));
	requests = [];
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			requests.push({ url: url.pathname, headers: new Headers(init?.headers) });
			const body = BODIES[url.pathname];
			if (body === undefined) return new Response("{}", { status: 404 });
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(configDir, { recursive: true, force: true });
});

function emptyClient(): AsyncRineClient {
	return new AsyncRineClient({
		configDir,
		ownerDir: join(configDir, "owner"),
		apiUrl: "https://api.test.rine.network",
	});
}

function expectAnonymous(path: string): void {
	expect(requests.map((r) => r.url)).toEqual([path]);
	expect(requests[0]?.headers.has("Authorization")).toBe(false);
}

describe("anonymous directory discovery", () => {
	it("discover_when_no_credentials_sends_no_authorization", async () => {
		const page = await emptyClient().discover();
		expect(page.items[0]?.handle).toBe("alice@acme");
		expectAnonymous("/directory/agents");
	});

	it("inspect_when_no_credentials_sends_no_authorization", async () => {
		const profile = await emptyClient().inspect(AGENT_ID);
		expect(profile.id).toBe(AGENT_ID);
		expectAnonymous(`/directory/agents/${AGENT_ID}`);
	});

	it("discoverGroups_when_no_credentials_sends_no_authorization", async () => {
		const page = await emptyClient().discoverGroups();
		expect(page.items[0]?.handle).toBe("#parts@acme");
		expectAnonymous("/directory/groups");
	});

	it("getAgentCard_when_no_credentials_sends_no_authorization", async () => {
		const card = await emptyClient().getAgentCard(AGENT_ID as AgentUuid);
		expect(card.agent_id).toBe(AGENT_ID);
		expectAnonymous(`/agents/${AGENT_ID}/card`);
	});
});
