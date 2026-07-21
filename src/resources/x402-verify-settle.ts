/**
 * x402 payee standalone primitives — `verify`/`settle` a received
 * `payment` for `settle-after-delivery`, WITHOUT thread context. With no thread to
 * resolve a quote reference, fully operator-authored `opts.expected` terms are the
 * ONLY quote source: absent them these fail closed (`NO_QUOTE`) rather than
 * trusting the payer's echoed `accepted`. Ref-based binding is `fulfill`
 * (`x402-payee.ts`).
 */

import {
	type PaymentPayload,
	type PaymentRequirements,
	type ResolvedPayeeRequirement,
	type SettlementResponse,
	type VerifyResponse,
	X402Error,
	X402_ERROR,
	settlePayment,
	verifyPayment,
} from "@rine-network/core";
import type { DecryptedMessage } from "../types.js";
import {
	type VerifySettleOptions,
	reconcileExpected,
	toPaymentPayload,
} from "./x402-shared.js";

/**
 * Verify a received `payment` (no broadcast). Reconciles against payee-owned
 * `opts.expected` terms and fails closed (`NO_QUOTE`) when absent.
 */
export async function verify(
	payment: DecryptedMessage | PaymentPayload,
	opts: VerifySettleOptions,
): Promise<VerifyResponse> {
	const pp = toPaymentPayload(payment);
	const { requirement } = requireExpected(pp, opts.expected);
	return verifyPayment(pp, requirement, {
		facilitator: opts.facilitator,
		signal: opts.signal,
	});
}

/** Settle a received `payment` via the facilitator (broadcast). See {@link verify}. */
export async function settle(
	payment: DecryptedMessage | PaymentPayload,
	opts: VerifySettleOptions,
): Promise<SettlementResponse> {
	const pp = toPaymentPayload(payment);
	const { requirement } = requireExpected(pp, opts.expected);
	return settlePayment(pp, requirement, {
		facilitator: opts.facilitator,
		signal: opts.signal,
	});
}

/** Reconcile against the operator override, or fail closed when it is absent. */
function requireExpected(
	pp: PaymentPayload,
	expected: PaymentRequirements | undefined,
): ResolvedPayeeRequirement {
	if (!expected) {
		throw new X402Error(
			X402_ERROR.NO_QUOTE,
			"standalone verify/settle requires explicit expected terms (no thread context to resolve a quote reference) — fail closed",
		);
	}
	return reconcileExpected(pp, expected);
}
