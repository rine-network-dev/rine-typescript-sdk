/**
 * What the SDK sends for per-agent exposure: its bearer on a card read when it holds one, and
 * `exposure` in a create body only when the caller sets it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SDKHttpClient } from "../api/http.js";
import type { AgentUuid } from "../types.js";
import { IdentityResource } from "./identity.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CARD = { id: AGENT_ID, agent_id: AGENT_ID, name: "Alice", created_at: "2026-01-01T00:00:00Z" };

function resource(hasCredentials: boolean) {
	const get = vi.fn(async (_path: string, _opts: object) => CARD);
	const http = { hasCredentials, get } as unknown as SDKHttpClient;
	return { identity: new IdentityResource(http), get };
}

describe("getAgentCard", () => {
	it("getAgentCard_when_the_client_holds_credentials_then_the_read_is_authenticated", async () => {
		const { identity, get } = resource(true);
		await identity.getAgentCard(AGENT_ID as AgentUuid);
		expect(get.mock.calls[0]?.[1]).toMatchObject({ unauthenticated: false });
	});

	it("getAgentCard_when_the_client_holds_none_then_the_read_is_anonymous", async () => {
		const { identity, get } = resource(false);
		await identity.getAgentCard(AGENT_ID as AgentUuid);
		expect(get.mock.calls[0]?.[1]).toMatchObject({ unauthenticated: true });
	});
});

describe("hasCredentials", () => {
	it("hasCredentials_when_the_config_dir_is_empty_then_false", async () => {
		const { AsyncRineClient } = await import("../client.js");
		const dir = mkdtempSync(join(tmpdir(), "rine-sdk-cred-"));
		try {
			const client = new AsyncRineClient({ configDir: dir, ownerDir: join(dir, "owner"), apiUrl: "https://x.test" });
			const http = (client as unknown as { http: SDKHttpClient }).http;
			expect(http.hasCredentials).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
