/**
 * Pull the verbatim x402 V2 object out of a decrypted rine message, reusing
 * rine-core's `parseX402Payload` for the structural validation (no duplicated
 * discrimination/validation logic here). A decrypt-failed envelope or a
 * non-x402 type throws a clear error before any wallet/facilitator work runs.
 */

import {
	type PaymentPayload,
	type PaymentRequired,
	X402_MESSAGE_TYPE,
	parseX402Payload,
} from "@rine-network/core";
import type { DecryptedMessage } from "../types.js";

function plaintextString(msg: DecryptedMessage): string {
	if (msg.decrypt_error) {
		throw new Error(
			`cannot read x402 payload: message ${msg.id} failed to decrypt (${msg.decrypt_error})`,
		);
	}
	const pt = msg.plaintext;
	if (pt == null) {
		throw new Error(
			`cannot read x402 payload: message ${msg.id} has no plaintext`,
		);
	}
	// The decrypt layer auto-parses `application/json` plaintext into an object;
	// re-serialise so the core string-parser sees the canonical form. A raw
	// string plaintext (non-JSON content-type) is passed through untouched.
	return typeof pt === "string" ? pt : JSON.stringify(pt);
}

/** Extract + validate a `PaymentRequired` from a received quote message. */
export function extractPaymentRequired(msg: DecryptedMessage): PaymentRequired {
	if (msg.type !== X402_MESSAGE_TYPE.PAYMENT_REQUIRED) {
		throw new Error(
			`expected a ${X402_MESSAGE_TYPE.PAYMENT_REQUIRED} message, got ${msg.type}`,
		);
	}
	return parseX402Payload(msg.type, plaintextString(msg)) as PaymentRequired;
}

/** Extract + validate a signed `PaymentPayload` from a received payment message. */
export function extractPaymentPayload(msg: DecryptedMessage): PaymentPayload {
	if (msg.type !== X402_MESSAGE_TYPE.PAYMENT) {
		throw new Error(
			`expected a ${X402_MESSAGE_TYPE.PAYMENT} message, got ${msg.type}`,
		);
	}
	return parseX402Payload(msg.type, plaintextString(msg)) as PaymentPayload;
}
