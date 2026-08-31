/**
 * Schema-level regressions for `src/types.ts`.
 *
 * Each section pins a wire shape the server has been observed to emit
 * that previously failed to parse. Unit scope only — no transport, no
 * crypto, just `.parse()` round-trips.
 */

import { describe, expect, it } from "vitest";
import {
	AgentReadSchema,
	DecryptedMessageSchema,
	GroupMemberSchema,
	GroupReadSchema,
	MessageType,
} from "./types.js";

// ---------------------------------------------------------------------------
// MessageType.Webhook — Funnel webhook constant
// ---------------------------------------------------------------------------

describe("MessageType.Webhook", () => {
	it("maps to the canonical Funnel webhook type string", () => {
		expect(MessageType.Webhook).toBe("rine.v1.webhook");
	});
});

// ---------------------------------------------------------------------------
// AgentReadSchema.warnings
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
// DecryptedMessageSchema.plaintext
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

// ---------------------------------------------------------------------------
// GroupReadSchema.conversation_id
// ---------------------------------------------------------------------------
//
// `z.object` strips every key it is not told about, so this schema is the only
// thing standing between the server's `conversation_id` and an SDK caller —
// and between it and `rine-eve`/`rine-mastra`, which infer their `GroupRead`
// from here. Delete the field from the schema and nothing throws: the value
// just silently stops arriving, everywhere at once. That is what these tests
// exist to catch.

describe("GroupReadSchema.conversation_id", () => {
	const baseGroup = {
		id: "33333333-3333-4333-8333-333333333333",
		name: "dev",
		handle: "#dev@acme.rine.network",
		created_at: "2026-04-11T12:00:00Z",
	};
	const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";

	it("keeps the id the server sent, rather than stripping it", () => {
		const parsed = GroupReadSchema.parse({
			...baseGroup,
			conversation_id: CONVERSATION_ID,
		});
		expect(parsed.conversation_id).toBe(CONVERSATION_ID);
	});

	it("keeps an explicit null — nothing has been said in the group yet", () => {
		const parsed = GroupReadSchema.parse({
			...baseGroup,
			conversation_id: null,
		});
		expect(parsed.conversation_id).toBeNull();
	});

	it("defaults an absent key to null, so an older server still parses", () => {
		const parsed = GroupReadSchema.parse(baseGroup);
		// Null, never undefined: a surface renders one absence sentence, and a
		// server that predates the field does not throw the whole page away.
		expect(parsed.conversation_id).toBeNull();
	});

	it("refuses a value that is not a uuid", () => {
		expect(() =>
			GroupReadSchema.parse({ ...baseGroup, conversation_id: "not-a-uuid" }),
		).toThrow();
	});
});

// ---------------------------------------------------------------------------
// GroupReadSchema.member_agent_ids / GroupMemberSchema.is_own_org
// ---------------------------------------------------------------------------
//
// Same stripping hazard as `conversation_id`, and the same blast radius: these
// two schemas are what `rine-eve` and `rine-mastra` infer their `GroupRead` and
// `GroupMember` from, so a field missing here stops arriving on three surfaces
// at once, silently, with nothing thrown.
//
// What the two fields answer is one question the org-scoped group list could
// never answer before: `GET /groups` lists every group ANY agent of the org is
// in, so a row on it was not proof the acting agent may act in that group.
// `member_agent_ids` names which of the caller's own agents are seated in the
// group; `is_own_org` marks which roster rows are the caller's own.

const BASE_GROUP = {
	id: "33333333-3333-4333-8333-333333333333",
	name: "dev",
	handle: "#dev@acme.rine.network",
	created_at: "2026-04-11T12:00:00Z",
};

describe("GroupReadSchema.member_agent_ids", () => {
	const AGENT_A = "44444444-4444-4444-4444-444444444444";
	const AGENT_B = "55555555-5555-4555-8555-555555555555";

	it("keeps every id the server sent, in the order it sent them", () => {
		const parsed = GroupReadSchema.parse({
			...BASE_GROUP,
			member_agent_ids: [AGENT_A, AGENT_B],
		});
		expect(parsed.member_agent_ids).toEqual([AGENT_A, AGENT_B]);
	});

	it("keeps an explicit empty array — no agent of this org is seated", () => {
		// The empty array is a FACT about the group, not a missing value. A
		// caller reading it knows a send into that group would be refused,
		// which is the whole point of the field.
		const parsed = GroupReadSchema.parse({
			...BASE_GROUP,
			member_agent_ids: [],
		});
		expect(parsed.member_agent_ids).toEqual([]);
	});

	it("defaults an absent key to an empty array, so an older server parses", () => {
		const parsed = GroupReadSchema.parse(BASE_GROUP);
		// An array, never undefined: every renderer maps over it unconditionally
		// and a server that predates the field must not throw the page away.
		expect(parsed.member_agent_ids).toEqual([]);
	});

	it("refuses an entry that is not a uuid", () => {
		// The values are what a caller hands back as `X-Rine-Agent`, so a
		// non-uuid here is a value that cannot work at the far end.
		expect(() =>
			GroupReadSchema.parse({
				...BASE_GROUP,
				member_agent_ids: ["not-a-uuid"],
			}),
		).toThrow();
	});
});

describe("GroupMemberSchema.is_own_org", () => {
	const baseMember = {
		group_id: BASE_GROUP.id,
		agent_id: "44444444-4444-4444-4444-444444444444",
		joined_at: "2026-04-11T12:00:00Z",
	};

	it("keeps a true the server sent", () => {
		const parsed = GroupMemberSchema.parse({
			...baseMember,
			is_own_org: true,
		});
		expect(parsed.is_own_org).toBe(true);
	});

	it("keeps a false the server sent — another org holds this seat", () => {
		const parsed = GroupMemberSchema.parse({
			...baseMember,
			is_own_org: false,
		});
		expect(parsed.is_own_org).toBe(false);
	});

	it("defaults an absent key to false, marking nothing rather than everything", () => {
		// The safe direction: an older server that omits the key leaves every
		// row unmarked. Defaulting to `true` would claim seats the caller's org
		// does not hold.
		const parsed = GroupMemberSchema.parse(baseMember);
		expect(parsed.is_own_org).toBe(false);
	});
});
