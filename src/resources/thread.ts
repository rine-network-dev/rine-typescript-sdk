/**
 * Both-sided conversation thread fetch + decrypt + render.
 *
 * Backs `ConversationScope.thread()`. Kept in its own module so the
 * already-oversized `conversation.ts` stays close to the file-size budget.
 *
 * The thread endpoint (`GET /conversations/{id}/messages`)
 * returns the conversation's messages in both directions, ascending, each a
 * `MessageRead` tagged with `direction` and — for the caller's own rows — the
 * `self_encrypted_payload` blob. For each row we pick the
 * ciphertext the caller can actually open with its OWN keys:
 *
 *   - `direction === "sent"`     → `self_encrypted_payload` (sealed to self)
 *   - `direction === "received"` → `encrypted_payload` (sealed to the caller)
 *   - group rows (`group_id` set, `sender-key-v1`/`mls-v1`) → fall through to
 *     the normal group decrypt (the caller self-reads via its key cache).
 *
 * Decryption reuses `decryptEnvelope` (the same helper `inbox()`/`read()` use)
 * by overriding `encrypted_payload` with the selected ciphertext, so no new
 * decrypt path is introduced. An undecryptable row never throws: a `"sent"`
 * row with no self-blob (legacy, pre-self-seal) or any `decrypt_error` degrades
 * to a `[unavailable]` placeholder — mirroring `decryptEnvelope`'s non-throw
 * contract.
 */

import type { HttpClient as CoreHttpClient } from "@rine-network/core";
import type { SDKHttpClient } from "../api/http.js";
import type { MessageRead, ThreadEntry, VerificationStatus } from "../types.js";
import { ConversationMessagesPageSchema } from "../types.js";
import { decryptEnvelope } from "./decrypt.js";

const UNAVAILABLE = "[unavailable]";

export interface FetchThreadOptions {
	readonly http: SDKHttpClient;
	readonly core: CoreHttpClient;
	readonly agentId: string;
	readonly conversationId: string;
	/** Agent handle to read as (forwarded as the `X-Rine-Agent` override). */
	readonly agent?: string;
	readonly limit?: number;
	readonly signal?: AbortSignal;
}

/**
 * Fetch the both-sided thread, decrypt each row with the caller's own keys,
 * and return an ordered, role-tagged transcript. Never throws on an
 * undecryptable row.
 */
export async function fetchThread(
	opts: FetchThreadOptions,
): Promise<ThreadEntry[]> {
	const { http, core, agentId, conversationId, agent, limit, signal } = opts;

	const raw = await http.get<unknown>(
		`/conversations/${conversationId}/messages`,
		{
			params: { limit },
			...(agent !== undefined
				? { extraHeaders: { "X-Rine-Agent": agent } }
				: {}),
			signal,
			operation: "thread",
		},
	);
	// The endpoint returns `{ messages, truncated }` — the
	// both-sided thread, ascending — NOT a cursor page. Parse that shape
	// directly (`truncated` is currently informational and not surfaced).
	const page = ConversationMessagesPageSchema.parse(raw);

	const entries = await Promise.all(
		page.messages.map((row) => toThreadEntry({ core, http, agentId, row })),
	);
	return entries;
}

async function toThreadEntry(opts: {
	core: CoreHttpClient;
	http: SDKHttpClient;
	agentId: string;
	row: MessageRead;
}): Promise<ThreadEntry> {
	const { core, http, agentId, row } = opts;
	const direction = row.direction ?? "received";

	const { text, verificationStatus } = await renderRow({
		core,
		http,
		agentId,
		row,
		direction,
	});
	return {
		direction,
		senderHandle: row.sender_handle ?? null,
		text,
		verificationStatus,
		type: row.type,
		createdAt: row.created_at,
	};
}

/**
 * Select the right ciphertext, decrypt, and render to a plaintext string plus
 * the sender-signature verification status.
 *
 * Fail-closed on authenticity: the server is a passthrough and never verifies
 * signatures, so the SDK is the only verification point. `decryptEnvelope`
 * (via core `decryptMessage`) does NOT throw on a bad signature — it returns
 * the plaintext tagged `verification_status: "invalid"`. We treat `"invalid"`
 * as undecryptable and degrade to `[unavailable]`, matching the Python SDK
 * (which raises `CryptoError` on `status == "invalid"`), so a forged or
 * tampered turn can never enter the transcript as trusted content.
 */
async function renderRow(opts: {
	core: CoreHttpClient;
	http: SDKHttpClient;
	agentId: string;
	row: MessageRead;
	direction: "sent" | "received";
}): Promise<{ text: string; verificationStatus: VerificationStatus }> {
	const { core, http, agentId, row, direction } = opts;
	const isGroup = row.group_id != null;

	// A sent 1:1 row with no self-blob is a legacy (pre-self-seal) send the
	// caller can never re-open — degrade rather than feed `decryptEnvelope` an
	// empty payload (which would emit a noisier "missing encrypted_payload"
	// error). Group sent rows self-read via the key cache, so skip this guard
	// for them and let the group path run.
	if (direction === "sent" && !isGroup && row.self_encrypted_payload == null) {
		return { text: UNAVAILABLE, verificationStatus: "unverifiable" };
	}

	// For a sent 1:1 row, the caller can only open the self-sealed copy; swap it
	// in. Received rows and group rows decrypt from `encrypted_payload` as usual.
	const ciphertext =
		direction === "sent" && !isGroup
			? (row.self_encrypted_payload as string)
			: row.encrypted_payload;

	const decrypted = await decryptEnvelope({
		core,
		configDir: http.configDir,
		agentId,
		msg: { ...row, encrypted_payload: ciphertext },
		// Group rows may need a one-shot key-material refresh, same as inbox.
		retrySenderKey: isGroup,
		memo: http.decryptMemo,
	});

	// Fail-closed: an invalid sender signature is an authenticity failure, not
	// trusted content — degrade exactly like a decrypt failure (mirrors Python).
	if (
		decrypted.decrypt_error != null ||
		decrypted.plaintext == null ||
		decrypted.verification_status === "invalid"
	) {
		return {
			text: UNAVAILABLE,
			verificationStatus: decrypted.verification_status ?? "unverifiable",
		};
	}
	return {
		text: renderText(decrypted.plaintext),
		verificationStatus: decrypted.verification_status ?? "unverifiable",
	};
}

/**
 * Render decrypted plaintext to the human-readable body string.
 *
 * Connectors wrap the message body as `{ text: "..." }`; surface that string
 * directly so every surface renders the same content. Any other shape (a bare
 * string, or a structured payload) is stringified. This rule is mirrored
 * verbatim by the Python SDK's `thread()` so the transcript reads identically
 * across surfaces.
 */
export function renderText(plaintext: unknown): string {
	if (typeof plaintext === "string") return plaintext;
	if (
		plaintext != null &&
		typeof plaintext === "object" &&
		typeof (plaintext as { text?: unknown }).text === "string"
	) {
		return (plaintext as { text: string }).text;
	}
	return JSON.stringify(plaintext);
}
