/**
 * Rendering ONE transcript row: pick the ciphertext, decrypt, decide the text.
 *
 * Split out of `thread.ts`, which now owns only where a transcript comes FROM
 * (its two routes) and the page-level render. This owns what a row becomes, and
 * the two halves share nothing but `ClassifiedEntry` — the split `thread.ts`'s
 * own header cites the file-size budget for, applied to itself.
 *
 * For each row the ciphertext the caller can actually open with its OWN keys is
 * selected first:
 *
 *   - `direction === "sent"`     → `self_encrypted_payload` (sealed to self)
 *   - `direction === "received"` → `encrypted_payload` (sealed to the caller)
 *   - group rows (`group_id` set, `sender-key-v1`/`mls-v1`) → fall through to
 *     the normal group decrypt (the caller self-reads via its key cache).
 *
 * Decryption reuses `decryptEnvelope` (the same helper `inbox()`/`read()` use)
 * by overriding `encrypted_payload` with the selected ciphertext, so no new
 * decrypt path is introduced. An undecryptable row never throws: a `"sent"`
 * row with no self-blob (legacy, pre-self-seal), a row with no
 * server-authenticated sender to check the envelope against, or any
 * `decrypt_error` degrades to a `[unavailable]` placeholder — mirroring
 * `decryptEnvelope`'s non-throw contract.
 *
 * The one exception is a row sealed under a sender key this agent does not
 * hold, the only failure here the reader can do something about. The tiering
 * that decides how it READS is applied by `thread.ts`, because "the first row"
 * is a fact about the caller's row ORDER and these decrypt concurrently; what
 * each row reports here is the explanation it WOULD carry. The sentinel and
 * that policy both come from `@rine-network/core`, so this transcript and the
 * CLI's read identically.
 */

import {
	type HttpClient as CoreHttpClient,
	THREAD_UNAVAILABLE,
	isA2aCleartext,
	isAuthenticityFailure,
	senderKeyExplanation,
	withA2aCleartextNotice,
} from "@rine-network/core";
import type { SDKHttpClient } from "../api/http.js";
import type { MessageRead, ThreadEntry, VerificationStatus } from "../types.js";
import { decryptEnvelope } from "./decrypt.js";

/**
 * A rendered turn plus the refusal it would explain if it turns out to be the
 * first in this render to carry the no-sender-key cause. The tiering cannot be
 * decided per row: the rows decrypt concurrently, so "the first row" is a fact
 * about the caller's row ORDER, not about which decrypt settled first.
 */
export interface ClassifiedEntry {
	readonly entry: ThreadEntry;
	readonly explanation: string | null;
}

export async function toThreadEntry(opts: {
	core: CoreHttpClient;
	http: SDKHttpClient;
	agentId: string;
	row: MessageRead;
}): Promise<ClassifiedEntry> {
	const { core, http, agentId, row } = opts;
	const direction = row.direction ?? "received";

	const { text, verificationStatus, explanation, a2aCleartext } = await renderRow({
		core,
		http,
		agentId,
		row,
		direction,
	});
	return {
		entry: {
			direction,
			senderHandle: row.sender_handle ?? null,
			text,
			verificationStatus,
			type: row.type,
			createdAt: row.created_at,
			a2aCleartext,
		},
		explanation,
	};
}

/**
 * Select the right ciphertext, decrypt, and render to a plaintext string plus
 * the sender-signature verification status.
 *
 * Fail-closed on authenticity: the server is a passthrough and never verifies
 * signatures, so the SDK is the only verification point. `decryptEnvelope`
 * refuses an authenticity failure on every path — `invalid` (the bytes do not
 * match the signature) and `sender-mismatch` (the signature names an agent other
 * than the row's sender) both come back with no plaintext and a `decrypt_error`,
 * matching the Python SDK. The status is checked here as well as the plaintext,
 * so the transcript's own rule that a tampered-with or misattributed turn renders
 * as `[unavailable]` holds on this side of the call too.
 */
async function renderRow(opts: {
	core: CoreHttpClient;
	http: SDKHttpClient;
	agentId: string;
	row: MessageRead;
	direction: "sent" | "received";
}): Promise<{
	text: string;
	verificationStatus: VerificationStatus;
	explanation: string | null;
	a2aCleartext: boolean;
}> {
	const { core, http, agentId, row, direction } = opts;
	const isGroup = row.group_id != null;

	// A `sent` row's sender is the caller. With neither that nor the row's own
	// `from_agent_id` there is nothing to check the envelope's claim of authorship
	// against, so the turn is unverifiable rather than quietly trusted. A cleartext
	// A2A turn has no envelope to check, so a missing sender does not close it.
	const fromAgentId =
		row.from_agent_id ?? (direction === "sent" ? agentId : null);
	if (fromAgentId == null && !isA2aCleartext(row)) {
		return degraded("unverifiable");
	}

	// A sent 1:1 row with no self-blob is a legacy (pre-self-seal) send the
	// caller can never re-open — degrade rather than feed `decryptEnvelope` an
	// empty payload (which would emit a noisier "missing encrypted_payload"
	// error). Group sent rows self-read via the key cache, so skip this guard
	// for them and let the group path run.
	if (direction === "sent" && !isGroup && row.self_encrypted_payload == null) {
		return degraded("unverifiable");
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
		msg: {
			...row,
			encrypted_payload: ciphertext,
			from_agent_id: fromAgentId,
		},
		// Group rows may need a one-shot key-material refresh, same as inbox.
		retrySenderKey: isGroup,
		memo: http.decryptMemo,
		// The self-sealed copy of a sent row is signed for the peer it went to.
		scopeAgentId:
			direction === "sent" ? (row.to_agent_id ?? undefined) : undefined,
	});

	// Fail-closed: a turn whose bytes do not match its signature, and one signed
	// by someone other than the row's sender, are both refused before they get
	// here — the verdict is checked anyway so the transcript never depends on
	// another module to withhold content (mirrors Python).
	if (
		decrypted.decrypt_error != null ||
		decrypted.plaintext == null ||
		isAuthenticityFailure(decrypted.verification_status)
	) {
		// The one closed row with a move to offer, recognised by the typed code the
		// SDK set beside the sentence and never by the sentence's words. Everything
		// else keeps `[unavailable]`, which named neither cause nor remedy and is
		// still the right answer where there is no remedy to name.
		return degraded(
			decrypted.verification_status ?? "unverifiable",
			senderKeyExplanation(decrypted),
		);
	}
	return {
		text: withA2aCleartextNotice(row, renderText(decrypted.plaintext)),
		verificationStatus: decrypted.verification_status ?? "unverifiable",
		explanation: null,
		a2aCleartext: isA2aCleartext(row),
	};
}

/** A row the caller cannot open, with the refusal it may explain (else null). */
function degraded(
	verificationStatus: VerificationStatus,
	explanation: string | null = null,
) {
	return {
		text: THREAD_UNAVAILABLE,
		verificationStatus,
		explanation,
		a2aCleartext: false,
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
