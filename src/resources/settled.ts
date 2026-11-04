import { type AckRow, isSettledRow } from "@rine-network/core";

/**
 * Whether reading this row is finished, so that marking it delivered loses
 * nothing: it opened, it was never ciphertext, or its author was refused.
 * Every other row (no keys, a sender key not yet arrived, a version this
 * client does not know) may still heal and stays `new`.
 *
 * `opened` is the absence of a `decrypt_error`, which every `decryptEnvelope`
 * arm that did not open the row sets.
 */
export function isSettled(
	msg: AckRow & { decrypt_error?: string | null },
): boolean {
	return isSettledRow(msg, msg.decrypt_error == null);
}
