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
 * Every decrypt is bound to the row's `from_agent_id` — the sender the server
 * authenticated — so the envelope's own claim of authorship is checked against
 * it. A row that arrives without one carries no such claim to check, and is
 * returned undecrypted as `unverifiable`.
 *
 * An authenticity failure — `invalid` (the bytes do not match the signature) or
 * `sender-mismatch` (the signature names an agent other than the row's sender) —
 * is refused on every path, 1:1 and group alike: `plaintext` is absent and the
 * row carries its verdict plus a `decrypt_error` saying which failure it was.
 * `unverifiable` stays a separate, transient outcome and is not a refusal.
 *
 * Crypto failures (including the post-retry failure on the sender-key path)
 * populate `decrypt_error` and do NOT throw — callers branch on
 * `msg.decrypt_error !== null`. User cancellation (`AbortError`) is always
 * re-thrown so a cancelled `inbox()` rejects cleanly instead of resolving
 * with a page of "failed" items.
 *
 * Successful GROUP decrypts are recorded in the caller-supplied
 * `GroupDecryptMemo` and replayed from it on a repeat call, because the
 * group ratchet consumes the message key it just used. A replay is held against
 * the sender of the row being read now, so the memo can never carry an earlier
 * read's attribution onto a row re-served under a different sender — and it
 * carries no `catch_up` either, because a read answered from the memo applied
 * no commits and advanced no epoch.
 *
 * That memo is one of TWO layers and the shorter-lived one: it lives in this
 * process only and holds nothing on disk. Underneath it, rine-core keeps the
 * newest 256 messages per group — capped at 1 MiB of plaintext, 0600 in a 0700
 * directory under `<configDir>/keys/<agentId>/group_reads/`, deleted when this
 * agent leaves the group ITSELF and by nothing else — which is what answers a
 * second read in a NEW process. Both re-verify the cached envelope against the sender the server
 * names on the current read.
 */

import {
	type HttpClient as CoreHttpClient,
	type DecryptResult,
	ACTING_AGENT_HEADER,
	GroupAuthenticityError,
	agentIdFromKid,
	asSenderKeyUnavailable,
	decryptGroupMessage,
	decryptMessage,
	fetchAndIngestPendingSKDistributions,
	isMlsWelcomeRefusedError,
	isRefusedDecrypt,
	processMlsWelcomes,
	sameAgentId,
	senderKeyNotRecoveredMessage,
	syncMlsGroup,
	unknownSenderKeyId,
} from "@rine-network/core";
import type { DecryptedMessage } from "../types.js";
import { asReplay, type GroupDecryptMemo } from "../utils/decrypt-memo.js";

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
	/**
	 * The row to open. Its `from_agent_id` is the sender the server
	 * authenticated, and is what the envelope's signing key is checked against —
	 * callers that substitute another ciphertext (the thread's self-sealed blob)
	 * must keep it set to that row's sender.
	 */
	readonly msg: ParsedDecryptedMessage;
	readonly retrySenderKey?: boolean;
	/**
	 * Per-client memo of successful group decrypts. Supplied by every SDK
	 * receive surface so a row seen twice (inbox re-poll, read-after-inbox,
	 * thread over a group conversation) still yields plaintext — the group
	 * ratchet itself is single-use. See `utils/decrypt-memo.ts`.
	 */
	readonly memo?: GroupDecryptMemo;
}

export async function decryptEnvelope(
	opts: DecryptEnvelopeOptions,
): Promise<DecryptedMessage> {
	const { core, configDir, agentId, msg, memo, retrySenderKey = false } = opts;

	const encryptedPayload = msg.encrypted_payload;
	if (!encryptedPayload) {
		return applyDecryptError(msg, "missing encrypted_payload");
	}

	// The envelope is never accepted as its own witness: without the server's
	// account of who sent the row there is nothing to check its signing key
	// against, so the row stays closed instead of being trusted.
	const fromAgentId = msg.from_agent_id;
	if (!fromAgentId) {
		return applyDecryptError(msg, "missing from_agent_id");
	}

	try {
		if (
			msg.encryption_version === "hpke-v1" ||
			msg.encryption_version === "hpke-hybrid-v1"
		) {
			const result = await decryptMessage(
				configDir,
				agentId,
				encryptedPayload,
				core,
				fromAgentId,
			);
			// A 1:1 authenticity failure is refused in the same shape a group one is:
			// the decrypt withholds the text, and the row comes back closed, carrying
			// the verdict and a reason instead of readable content.
			if (isRefusedDecrypt(result)) {
				return applyDecryptError(
					msg,
					authenticityReason(result.verificationStatus),
					result.verificationStatus,
				);
			}
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
			// A group ratchet step is single-use, so a row already opened by
			// this client is replayed from the memo instead of re-derived. The memo
			// answers what the bytes said, never who sent them: whom a row is
			// attributed to is decided per read, so the replay is held against the
			// sender the server names on the row being read NOW. Without this, a row
			// re-served under a different sender would come back carrying the first
			// read's verdict.
			const memoized = memo?.get(agentId, msg.id);
			if (memoized) {
				return signedByRowSender(memoized.senderKid, fromAgentId)
					? applyDecryptResult(msg, memoized)
					: applyDecryptError(
							msg,
							authenticityReason("sender-mismatch"),
							"sender-mismatch",
						);
			}

			let result: DecryptResult;
			try {
				result = await decryptGroupMessage(
					configDir,
					agentId,
					msg.group_id,
					encryptedPayload,
					core,
					fromAgentId,
				);
			} catch (firstErr) {
				rethrowIfAbort(firstErr);
				// A refusal is a verdict, not a missing-key miss: no amount of fresh
				// key material makes the envelope's signer the row's sender, and
				// retrying would report the misattribution as whatever the second
				// attempt happens to fail with. Refuse here, as core's own MLS
				// recovery does on `isRecoverableMlsRead`.
				if (firstErr instanceof GroupAuthenticityError) {
					return applyDecryptError(
						msg,
						firstErr.message,
						firstErr.verificationStatus,
					);
				}
				if (!retrySenderKey) {
					// With the recovery switched off, core's raw control string —
					// `unknown sender key id: <id>` — would otherwise reach a reader as
					// this row's reason. It is a library internal, and worse it is a
					// half-truth: this read never went looking for the distribution
					// that carries the key, so it does not know whether one is waiting.
					// Say exactly that, and deliberately set NO `decrypt_error_code`:
					// the code is the earned verdict, and no verdict was earned here.
					const missingId = unknownSenderKeyId(firstErr);
					return applyDecryptError(
						msg,
						missingId === null
							? errMessage(firstErr)
							: senderKeyNotRecoveredMessage(missingId),
						classifyGroupError(firstErr),
					);
				}
				// Retry: refresh missing key material and try once more. If
				// retry also fails, the second error is the one the caller
				// sees — it's the more informative failure mode.
				try {
					if (isMls) {
						// 🔴 Scoped to THIS row's group. The pass works the whole pending
						// queue, so unscoped it raises whichever refusal the server's own
						// welcomes response listed first — and a refusal for some
						// unrelated group then aborted the recovery of a row that had
						// nothing to do with it, before `syncMlsGroup` ever ran. Same
						// defect and same fix as `rine-core`'s read path; this
						// is its twin one package over.
						await processMlsWelcomes(configDir, agentId, core, {
							forGroup: msg.group_id,
						});
						// The acting-agent header is what makes `GET
						// /groups/{id}/mls/handshakes` answer for a multi-agent org:
						// the route resolves its actor through `get_acting_agent`,
						// which answers 422 "Multiple active agents" without it. This
						// client resolves the agent per call (`resolveSenderId`) rather
						// than pinning it on the client, so `core`'s default headers
						// carry nothing unless the caller constructed the client with
						// `agent` — the recovery has to name the reader itself.
						await syncMlsGroup(configDir, agentId, msg.group_id!, core, {
							[ACTING_AGENT_HEADER]: agentId,
						});
					} else {
						// The group id is what lets a re-admitted member take key
						// material again: the retirement a leave wrote is spent inside
						// this scan, and only for the group named here.
						await fetchAndIngestPendingSKDistributions(
							core,
							configDir,
							agentId,
							undefined,
							msg.group_id,
						);
					}
					result = await decryptGroupMessage(
						configDir,
						agentId,
						msg.group_id,
						encryptedPayload,
						core,
						fromAgentId,
					);
				} catch (retryErr) {
					rethrowIfAbort(retryErr);
					// A refused Welcome is a verdict about a GROUP's state, not about
					// this row: `processMlsWelcomes` works the whole pending batch, so
					// the refusal can name a group this message has nothing to do with.
					// Reported verbatim it reads as this row's own decrypt failure, so
					// say what it is first and keep the refusal's own words after it.
					// Classified by rine-core's exported code check, never by message
					// text — this is the first consumer of that export.
					if (isMlsWelcomeRefusedError(retryErr)) {
						return applyDecryptError(
							msg,
							`Recovery for this message could not run: a pending MLS welcome was refused. ${errMessage(retryErr)}`,
							"unverifiable",
						);
					}
					// The recovery above has had its turn, so a still-missing sender
					// key is this row's final answer rather than a stage of one. What
					// core throws there is the control string that drove the retry —
					// translate it here, at the surface where the reader is, into the
					// sentence that says what happened and what to do instead.
					//
					// This is the one arm that earns `decrypt_error_code`: the code
					// travels beside the sentence so a surface can decide HOW to say it
					// (in full, or as the bounded marker on a repeat) without matching
					// on prose that is free to be re-worded.
					const unavailable = asSenderKeyUnavailable(retryErr, msg.group_id);
					return applyDecryptError(
						msg,
						unavailable?.message ?? errMessage(retryErr),
						classifyGroupError(retryErr),
						unavailable?.code,
					);
				}
			}
			// Stored as a replay: a later read answered from the memo applied no
			// commits, so it must not report this read's catch-up as its own.
			memo?.set(agentId, msg.id, asReplay(result));
			return applyDecryptResult(msg, result);
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
		// The signing key the envelope named, as verification read it. On a
		// verified message it belongs to `from_agent_id`, so callers that want the
		// cryptographic identity behind a turn have it here.
		sender_kid: result.senderKid,
		decrypt_error: null,
		decrypt_error_code: null,
		// Present only when the sender rotated past this client's cached key, so
		// consumers can surface the rotation instead of silently accepting it.
		...(result.keyChanged
			? {
					key_changed: {
						agent_id: result.keyChanged.agentId,
						previous_fingerprint: result.keyChanged.previousFingerprint,
						current_fingerprint: result.keyChanged.currentFingerprint,
					},
				}
			: {}),
		// Present only when this read actually synced the group, so its absence
		// says nothing was done rather than nothing was pending. Chiefly it is how
		// a reader learns it was evicted by a commit this very read applied — the
		// row still opens, and the next send is the thing that will not.
		...(result.catchUp ? { catch_up: result.catchUp } : {}),
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

/**
 * `code` is set only where this SDK reached a named verdict about the failure
 * (today: the sender key that was still missing after the recovery ran). Every
 * other failure leaves it null, so a consumer reads "no code" as "no claim
 * about the cause" rather than as a default one.
 */
function applyDecryptError(
	msg: ParsedDecryptedMessage,
	error: string,
	status: DecryptedMessage["verification_status"] = "unverifiable",
	code?: string,
): DecryptedMessage {
	return {
		...msg,
		metadata: msg.metadata ?? {},
		plaintext: undefined,
		verified: false,
		verification_status: status,
		sender_kid: null,
		decrypt_error: error,
		decrypt_error_code: code ?? null,
	};
}

/**
 * Map a group decrypt failure to a `verification_status`.
 *
 * `decryptGroupMessage` refuses an inauthentic group message by throwing a
 * `GroupAuthenticityError` that carries the verdict it reached — the signature
 * not checking out against the sender's published signing key is the `invalid`
 * case, a signature naming an agent other than the row's sender is
 * `sender-mismatch`. Every other failure (ratchet state missing, AEAD failure,
 * truncated ciphertext, malformed envelope, etc.) is `unverifiable` because the
 * recipient couldn't even get as far as a signature check.
 *
 * Without this classification every group failure collapses to
 * `unverifiable` and callers lose the ability to distinguish "bad sender"
 * from "missing key material".
 */
function classifyGroupError(
	err: unknown,
): DecryptedMessage["verification_status"] {
	return err instanceof GroupAuthenticityError
		? err.verificationStatus
		: "unverifiable";
}

/**
 * The reason a refused row reports as its `decrypt_error`, in the same words the
 * group paths throw and the Python SDK raises, so one vocabulary describes a
 * refusal wherever it happens. Reached only for an authenticity verdict: the 1:1
 * path reports one on its result instead of throwing, so the text is supplied
 * here rather than read off an error.
 */
function authenticityReason(
	status: DecryptedMessage["verification_status"],
): string {
	return status === "sender-mismatch"
		? "Envelope sender does not match the message sender"
		: "Sender signature verification failed";
}

/**
 * Whether an envelope's key id names the row's server-authenticated sender.
 *
 * The binding comparison on its own, for the one path that cannot re-derive a
 * verdict: a group decrypt replayed from the memo, whose single-use ratchet key
 * the first read already spent. The comparison is core's own `sameAgentId`, the
 * one verification itself uses, so a caller that carried the id through a surface
 * which changed its case is not refused for that alone — and a change to the rule
 * cannot leave this path behind. A key id that cannot be read names nobody.
 */
function signedByRowSender(senderKid: string, fromAgentId: string): boolean {
	try {
		return sameAgentId(agentIdFromKid(senderKid), fromAgentId);
	} catch {
		return false;
	}
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
