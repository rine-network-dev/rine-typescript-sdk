/**
 * Opens the one row that was never sealed: an A2A message an external client
 * posted in cleartext. There is nothing to decrypt and nothing a signature could
 * vouch for, so the row comes back readable, `unverifiable`, and carrying the
 * typed flag and the sentence every surface shows beside its body.
 */

import {
	A2A_CLEARTEXT_NOTICE,
	a2aCleartextPayload,
} from "@rine-network/core";
import type { DecryptedMessage } from "../types.js";
import type { ParsedDecryptedMessage } from "./decrypt.js";

export function openA2aCleartext(
	msg: ParsedDecryptedMessage,
): DecryptedMessage {
	return {
		...msg,
		metadata: msg.metadata ?? {},
		plaintext: a2aCleartextPayload(msg),
		verified: false,
		verification_status: "unverifiable",
		sender_kid: null,
		decrypt_error: null,
		decrypt_error_code: null,
		a2a_cleartext: true,
		a2a_cleartext_notice: A2A_CLEARTEXT_NOTICE,
	};
}
