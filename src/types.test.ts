/**
 * Schema-level regressions for `src/types.ts`.
 *
 * Each section pins a wire shape the server has been observed to emit
 * that previously failed to parse. Unit scope only — no transport, no
 * crypto, just `.parse()` round-trips.
 */

import { describe, expect, it } from "vitest";
import { AgentReadSchema, DecryptedMessageSchema, MessageType } from "./types.js";

// ---------------------------------------------------------------------------
// MessageType.Webhook — Funnel webhook constant
// ---------------------------------------------------------------------------

describe("MessageType.Webhook", () => {
	it("maps to the canonical Funnel webhook type string", () => {
		expect(MessageType.Webhook).toBe("rine.v1.webhook");
	});
});

// ---------------------------------------------------------------------------
// AgentReadSchema.warnings — REQ-01 (sdk-handoff-fixes)
// ---------------------------------------------------------------------------

describe("AgentReadSchema.warnings", () => {
	const baseAgent = {
		id: "11111111-1111-4111-8111-111111111111",
		name: "alice",
		handle: "alice@acme.rine.network",
		human_oversight: true,
		incoming_policy: "accept_all",
		outgoing_policy: "send_all",
		created_at: "2026-04-11T12:00:00Z",
	};

	it("accepts warnings: null (server emits this verbatim)", () => {
		const parsed = AgentReadSchema.parse({ ...baseAgent, warnings: null });
		expect(parsed.warnings).toBeNull();
	});

	it("accepts warnings: undefined (field absent)", () => {
		const parsed = AgentReadSchema.parse(baseAgent);
		expect(parsed.warnings).toBeUndefined();
	});

	it("accepts warnings: string[] (non-empty)", () => {
		const parsed = AgentReadSchema.parse({
			...baseAgent,
			warnings: ["trust-tier-low"],
		});
		expect(parsed.warnings).toEqual(["trust-tier-low"]);
	});

	it("accepts warnings: [] (empty array)", () => {
		const parsed = AgentReadSchema.parse({ ...baseAgent, warnings: [] });
		expect(parsed.warnings).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// DecryptedMessageSchema.plaintext — REQ-05 (sdk-handoff-fixes)
// ---------------------------------------------------------------------------
//
// The plaintext field is now typed as `z.unknown().nullable().optional()`
// so the post-decrypt JSON auto-parse in `decrypt.ts::applyDecryptResult`
// can assign structured values (object, array, etc.) alongside the
// legacy string form.

describe("DecryptedMessageSchema.plaintext", () => {
	const baseMsg = {
		id: "22222222-2222-4222-8222-222222222222",
		conversation_id: "33333333-3333-4333-8333-333333333333",
		from_agent_id: "44444444-4444-4444-8444-444444444444",
		to_agent_id: "55555555-5555-4555-8555-555555555555",
		type: "rine.v1.task_request",
		encrypted_payload: "base64-opaque",
		encryption_version: "hpke-v1",
		created_at: "2026-04-11T12:00:00Z",
	};

	it("accepts plaintext as a raw string", () => {
		const parsed = DecryptedMessageSchema.parse({
			...baseMsg,
			plaintext: "raw text",
		});
		expect(parsed.plaintext).toBe("raw text");
	});

	it("accepts plaintext as a parsed object", () => {
		const parsed = DecryptedMessageSchema.parse({
			...baseMsg,
			plaintext: { text: "hi" },
		});
		expect(parsed.plaintext).toEqual({ text: "hi" });
	});

	it("accepts plaintext: null (decrypt failure path)", () => {
		const parsed = DecryptedMessageSchema.parse({
			...baseMsg,
			plaintext: null,
		});
		expect(parsed.plaintext).toBeNull();
	});
});
