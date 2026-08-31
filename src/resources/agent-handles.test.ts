/**
 * `AgentHandleCache` — the one `GET /agents` a client ever buys, and what it
 * does when that call fails.
 *
 * The three render cases the map feeds are asserted where they are rendered
 * (`rine-cli`, `rine-mastra`, `rine-eve`). What is asserted here is the part no
 * renderer can see: that the list is fetched once, that a failure degrades to an
 * empty map instead of throwing out of a group read, and that the failure is not
 * remembered.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AsyncRineClient } from "../client.js";
import type { AgentRead } from "../types.js";
import { AgentHandleCache, agentHandleMap } from "./agent-handles.js";

const OPS_ID = randomUUID();
const BILLING_ID = randomUUID();

function agent(id: string, handle: string): AgentRead {
	return {
		id,
		name: handle.split("@")[0],
		handle,
		created_at: new Date().toISOString(),
	} as AgentRead;
}

const AGENTS = [agent(OPS_ID, "ops@acme"), agent(BILLING_ID, "billing@acme")];

describe("agentHandleMap", () => {
	it("indexes handles by lowercased id", () => {
		const map = agentHandleMap(AGENTS);
		expect(map.get(OPS_ID)).toBe("ops@acme");
		expect(map.get(BILLING_ID)).toBe("billing@acme");
	});

	it("resolves an id a server upper-cased", () => {
		const map = agentHandleMap([agent(OPS_ID.toUpperCase(), "ops@acme")]);
		expect(map.get(OPS_ID)).toBe("ops@acme");
	});

	it("has no entry for an id this org does not own", () => {
		// The renderers' case 2: a foreign or unknown id prints as itself, which
		// only works because the map answers `undefined` rather than "".
		expect(agentHandleMap(AGENTS).get(randomUUID())).toBeUndefined();
	});
});

describe("AgentHandleCache", () => {
	it("fetches the agent list once no matter how many renders ask", async () => {
		const list = vi.fn(async () => AGENTS);
		const cache = new AgentHandleCache(list);

		const [a, b] = await Promise.all([cache.get(), cache.get()]);
		await cache.get();

		expect(list).toHaveBeenCalledTimes(1);
		expect(a.get(OPS_ID)).toBe("ops@acme");
		expect(b).toBe(a);
	});

	it("answers an empty map when the fetch fails, instead of throwing", async () => {
		// The group read already succeeded by the time anything asks for handles.
		// A rejection here must cost the decoration, never the answer.
		const cache = new AgentHandleCache(async () => {
			throw new Error("500 from /agents");
		});
		await expect(cache.get()).resolves.toEqual(new Map());
	});

	it("is shared with every derived client, so `withAgent` per call costs nothing", async () => {
		// The constructor opens no network and touches no files, so a bare client
		// is safe here; only `listAgents` is stubbed.
		const client = new AsyncRineClient({});
		const listAgents = vi.fn(async () => AGENTS);
		// biome-ignore lint/suspicious/noExplicitAny: test override of a readonly resource method
		(client.identity as any).listAgents = listAgents;

		// What `rine-mastra` does on every tool execute: derive, then render.
		await client.agentHandles();
		const derived = client.withAgent("ops@acme");
		const map = await derived.withAgent("billing@acme").agentHandles();

		expect(listAgents).toHaveBeenCalledTimes(1);
		expect(map.get(BILLING_ID)).toBe("billing@acme");
		expect(await derived.agentHandles()).toBe(await client.agentHandles());
	});

	it("does not remember a failure — the next render retries", async () => {
		let calls = 0;
		const cache = new AgentHandleCache(async () => {
			calls += 1;
			if (calls === 1) throw new Error("timeout");
			return AGENTS;
		});

		expect((await cache.get()).size).toBe(0);
		expect((await cache.get()).get(OPS_ID)).toBe("ops@acme");
		expect(calls).toBe(2);
	});
});
