/**
 * Shared decryption helper used by `messages.inbox()`, `messages.read()`,
 * `messages.sendAndWait()`, and `client.messages()`.
 *
 * Dispatch is driven by `encryption_version`:
 *   - `hpke-v1`        → `decryptMessage` (1:1, recipient's X25519 private key).
 *   - `sender-key-v1`  → `decryptGroupMessage` (version byte 0x02). On a
 *                        dispatch failure, optionally retries once after
 *                        `fetchAndIngestPendingSKDistributions`.
 *   - `mls-v1`         → `decryptGroupMessage` (version byte 0x04; auto-routed
 *                        inside core). On failure, optionally retries once
 *                        after `processMlsWelcomes`.
 *   - anything else    → returned as-is with `decrypt_error` populated.
 *
 * Crypto failures (including the post-retry failure on the sender-key path)
 * populate `decrypt_error` and do NOT throw — callers branch on
 * `msg.decrypt_error !== null`. User cancellation (`AbortError`) is always
 * re-thrown so a cancelled `inbox()` rejects cleanly instead of resolving
 * with a page of "failed" items.
 */

import {
	type HttpClient as CoreHttpClient,
	type DecryptResult,
	decryptGroupMessage,
	decryptMessage,
	fetchAndIngestPendingSKDistributions,
	processMlsWelcomes,
	syncMlsGroup,
} from "@rine-network/core";
import type { DecryptedMessage } from "../types.js";

/**
 * Looser input shape accepted by `decryptEnvelope` and its helpers.
 *
 * The `parse(DecryptedMessageSchema, raw)` adapter erases Zod's precise
 * output type through its `z.ZodType<T>` parameter, so the value we pass
 * here is statically typed with a few fields still optional even though
 * the Zod `.default()` chains guarantee them at runtime. Accepting the
 * loose type avoids sprinkling `as` casts at every call site; the two
 * `applyDecrypt*` helpers normalize the output back to the full
 * `DecryptedMessage` shape before returning.
 */
export type ParsedDecryptedMessage = Omit<
	DecryptedMessage,
	"metadata" | "verified" | "verification_status"
> & {
	metadata?: Record<string, unknown>;
	verified?: boolean;
	verification_status?: DecryptedMessage["verification_status"];
};

export interface DecryptEnvelopeOptions {
	readonly core: CoreHttpClient;
	readonly configDir: string;
	readonly agentId: string;
	readonly msg: ParsedDecryptedMessage;
	readonly retrySenderKey?: boolean;
}

export async function decryptEnvelope(
	opts: DecryptEnvelopeOptions,
): Promise<DecryptedMessage> {
	const { core, configDir, agentId, msg, retrySenderKey = false } = opts;

	const encryptedPayload = msg.encrypted_payload;
	if (!encryptedPayload) {
		return applyDecryptError(msg, "missing encrypted_payload");
	}

	try {
		if (msg.encryption_version === "hpke-v1" || msg.encryption_version === "hpke-hybrid-v1") {
			const result = await decryptMessage(
				configDir,
				agentId,
				encryptedPayload,
				core,
			);
			return applyDecryptResult(msg, result);
		}

		// Group decrypt covers both sender-key (`sender-key-v1`, version byte
		// 0x02) and MLS (`mls-v1`, version byte 0x04). `decryptGroupMessage`
		// auto-dispatches on the version byte — the rine group UUID
		// (`msg.group_id`) is the only state key. Only the retry recovery
		// differs: sender-key ingests pending distributions, MLS installs
		// pending Welcomes.
		const isMls = msg.encryption_version === "mls-v1";
		if (msg.encryption_version === "sender-key-v1" || isMls) {
			if (!msg.group_id) {
				return applyDecryptError(msg, "sender-key message missing group_id");
			}
			try {
				const result = await decryptGroupMessage(
					configDir,
					agentId,
					msg.group_id,
					encryptedPayload,
					core,
				);
				return applyDecryptResult(msg, result);
			} catch (firstErr) {
				rethrowIfAbort(firstErr);
				if (!retrySenderKey) {
					return applyDecryptError(
						msg,
						errMessage(firstErr),
						classifyGroupError(firstErr),
					);
				}
				// Retry: refresh missing key material and try once more. If
				// retry also fails, the second error is the one the caller
				// sees — it's the more informative failure mode.
				try {
					if (isMls) {
						await processMlsWelcomes(configDir, agentId, core);
						await syncMlsGroup(configDir, agentId, msg.group_id!, core);
					} else {
						await fetchAndIngestPendingSKDistributions(
							core,
							configDir,
							agentId,
						);
					}
					const retry = await decryptGroupMessage(
						configDir,
						agentId,
						msg.group_id,
						encryptedPayload,
						core,
					);
					return applyDecryptResult(msg, retry);
				} catch (retryErr) {
					rethrowIfAbort(retryErr);
					return applyDecryptError(
						msg,
						errMessage(retryErr),
						classifyGroupError(retryErr),
					);
				}
			}
		}

		// Unknown `encryption_version` surfaces an explicit `decrypt_error`
		// so callers get an observable signal rather than a silently-
		// undecrypted envelope.
		return applyDecryptError(
			msg,
			`unknown encryption_version: ${msg.encryption_version}`,
		);
	} catch (err) {
		rethrowIfAbort(err);
		return applyDecryptError(msg, errMessage(err));
	}
}

function applyDecryptResult(
	msg: ParsedDecryptedMessage,
	result: DecryptResult,
): DecryptedMessage {
	return {
		...msg,
		metadata: msg.metadata ?? {},
		plaintext: autoParsePlaintext(msg.content_type, result.plaintext),
		verified: result.verified,
		verification_status: result.verificationStatus,
		decrypt_error: null,
	};
}

/**
 * If the payload was JSON (the default content-type), auto-parse the
 * decrypted string into a structured value before handing it to callers.
 *
 * Without this, first-time users see the raw serialized string and
 * mistake it for a double-encoding. Callers that pass a Standard Schema
 * still work: `parseMessagePlaintext` in `utils/schema.ts` accepts both
 * a string (parses it) and an already-parsed value (treats it as
 * structured input).
 *
 * Failure is silent on purpose — if the bytes claim to be JSON but are
 * malformed, the decrypt layer succeeded and we hand back the raw string
 * rather than synthesising a `decrypt_error`. Crypto observability and
 * content-format observability are different concerns.
 */
function autoParsePlaintext(
	contentType: string | null | undefined,
	plaintext: unknown,
): unknown {
	const ct = contentType ?? "application/json";
	if (ct !== "application/json") return plaintext;
	if (typeof plaintext !== "string") return plaintext;
	try {
		return JSON.parse(plaintext);
	} catch {
		return plaintext;
	}
}

function applyDecryptError(
	msg: ParsedDecryptedMessage,
	error: string,
	status: DecryptedMessage["verification_status"] = "unverifiable",
): DecryptedMessage {
	return {
		...msg,
		metadata: msg.metadata ?? {},
		plaintext: undefined,
		verified: false,
		verification_status: status,
		decrypt_error: error,
	};
}

/**
 * Map a sender-key decrypt failure to a `verification_status`.
 *
 * `decryptGroupMessage` throws `"Sender signature verification failed"` when
 * the inner-envelope Ed25519 signature doesn't match the sender's published
 * signing key (see `rine-core/src/crypto/message.ts`). That is the `invalid`
 * case — the recipient successfully derived the message key but cannot trust
 * the author. Every other failure (ratchet state missing, AEAD failure,
 * truncated ciphertext, malformed envelope, etc.) is `unverifiable` because
 * the recipient couldn't even get as far as a signature check.
 *
 * Without this classification every group failure collapses to
 * `unverifiable` and callers lose the ability to distinguish "bad sender"
 * from "missing key material".
 */
function classifyGroupError(
	err: unknown,
): DecryptedMessage["verification_status"] {
	const m = errMessage(err).toLowerCase();
	if (m.includes("signature verification failed")) return "invalid";
	return "unverifiable";
}

/**
 * Re-throw if the error is an `AbortError` from an aborted signal. Decrypt
 * failures populate `decrypt_error`, but user cancellation (via
 * `opts.signal` or the op timer) must bubble out as an AbortError rather
 * than being silently converted to a `decrypt_error` string on an
 * otherwise "successful" page.
 */
function rethrowIfAbort(err: unknown): void {
	if (err instanceof Error && err.name === "AbortError") throw err;
}

function errMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
