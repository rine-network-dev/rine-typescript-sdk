/**
 * A2A cleartext through the SDK's shared decrypt and thread paths: the one
 * message that was never sealed opens readable, is never verified, and says so
 * wherever its body is shown. Core is real; no key material is involved.
 */

import { A2A_CLEARTEXT_NOTICE } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import type { SDKHttpClient } from "../api/http.js";
import type { MessageRead } from "../types.js";
import { decryptEnvelope } from "./decrypt.js";
import { toThreadEntry } from "./thread-row.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const WIRE_PARTS = "W3sidGV4dCI6ICJwbGFpbiJ9XQ"; // [{"text": "plain"}]

function row(over: Record<string, unknown> = {}): MessageRead {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		conversation_id: "33333333-3333-4333-8333-333333333333",
		from_agent_id: null,
		to_agent_id: AGENT_ID,
		type: "rine.v1.a2a_message",
		encrypted_payload: WIRE_PARTS,
		encryption_version: "none",
		metadata: {},
		created_at: "2026-10-13T12:00:00Z",
		...over,
	} as MessageRead;
}

const open = (msg: MessageRead) =>
	decryptEnvelope({
		core: {} as never,
		configDir: "/tmp",
		agentId: AGENT_ID,
		msg,
	});

describe("decryptEnvelope on A2A cleartext", () => {
	it("test_decrypt_envelope_when_a2a_cleartext_then_opens_marked_and_unverified", async () => {
		const out = await open(row());
		expect(out.plaintext).toEqual([{ text: "plain" }]);
		expect(out.decrypt_error).toBeNull();
		expect(out.verified).toBe(false);
		expect(out.verification_status).toBe("unverifiable");
		expect(out.a2a_cleartext).toBe(true);
		expect(out.a2a_cleartext_notice).toBe(A2A_CLEARTEXT_NOTICE);
	});

	it("test_decrypt_envelope_when_the_server_set_the_sender_then_it_still_opens_unverified", async () => {
		const out = await open(row({ from_agent_id: AGENT_ID }));
		expect(out.plaintext).toEqual([{ text: "plain" }]);
		expect(out.verified).toBe(false);
		expect(out.a2a_cleartext).toBe(true);
	});

	it("test_decrypt_envelope_when_other_type_is_none_then_still_unknown_version", async () => {
		const out = await open(row({ type: "rine.v1.text", from_agent_id: AGENT_ID }));
		expect(out.decrypt_error).toMatch(/unknown encryption_version: none/);
		expect(out.a2a_cleartext).toBeUndefined();
	});
});

describe("thread entry for A2A cleartext", () => {
	const http = { configDir: "/tmp" } as unknown as SDKHttpClient;

	it.each([
		["no sender", null],
		["the server-set sender", "44444444-4444-4444-8444-444444444444"],
	])("test_thread_entry_when_a2a_cleartext_with_%s_then_text_leads_with_notice", async (_name, sender) => {
		const { entry } = await toThreadEntry({
			core: {} as never,
			http,
			agentId: AGENT_ID,
			row: row({ from_agent_id: sender }),
		});
		expect(entry.text.startsWith(`[${A2A_CLEARTEXT_NOTICE}] `)).toBe(true);
		expect(entry.text).toContain("plain");
		expect(entry.verificationStatus).toBe("unverifiable");
		expect(entry.a2aCleartext).toBe(true);
	});

	it("test_thread_entry_when_a2a_cleartext_sent_row_cannot_be_reopened_then_flag_is_false", async () => {
		const { entry } = await toThreadEntry({
			core: {} as never,
			http,
			agentId: AGENT_ID,
			row: row({ direction: "sent" }),
		});
		expect(entry.a2aCleartext).toBe(false);
		expect(entry.text).not.toContain(A2A_CLEARTEXT_NOTICE);
	});
});
