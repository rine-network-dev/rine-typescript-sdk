/**
 * `updateAgent` does not offer a rename, and carries `unlisted` to the server.
 *
 * The server answers 409 for a rename once an agent has a handle, and every org
 * registered today does, so a `name` in the patch could only ever fail. The
 * compile-time half is the `@ts-expect-error` below: `tsc` fails with "Unused
 * '@ts-expect-error' directive" the moment `name` returns to `UpdateAgentPatch`.
 */

import { describe, expect, it, vi } from "vitest";
import type { SDKHttpClient } from "../api/http.js";
import type { AgentUuid } from "../types.js";
import { IdentityResource } from "./identity.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as AgentUuid;

describe("IdentityResource.updateAgent", () => {
	it("updateAgent_when_name_is_in_the_patch_is_a_type_error", () => {
		const identity = new IdentityResource({} as SDKHttpClient);
		const calls = [
			// @ts-expect-error name is not patchable
			() => identity.updateAgent(AGENT_ID, { name: "renamed" }),
			() => identity.updateAgent(AGENT_ID, { human_oversight: false }),
		];
		// The directive is the assertion; this keeps the calls from being elided.
		expect(calls).toHaveLength(2);
	});

	it("updateAgent_when_unlisted_is_patched_sends_it_in_the_body", async () => {
		const patch = vi.fn(async () => ({
			id: AGENT_ID,
			name: "bot",
			handle: "bot@acme.rine.network",
			created_at: "2026-11-01T00:00:00Z",
			unlisted: true,
		}));
		const identity = new IdentityResource({ patch } as unknown as SDKHttpClient);

		const agent = await identity.updateAgent(AGENT_ID, { unlisted: true });

		expect(patch).toHaveBeenCalledWith(
			`/agents/${AGENT_ID}`,
			{ unlisted: true },
			{ operation: "updateAgent" },
		);
		expect(agent.unlisted).toBe(true);
	});
});
