/**
 * x402 payee helpers (REQ-M04, payee side): issue a `payment_required` quote,
 * verify + settle a received `payment` via the configured facilitator, and send
 * the `receipt`. Facilitator verify/settle is plain external HTTP (never rine).
 * The `fulfill` convenience is settle-first; the `verify`/`settle`/`sendReceipt`
 * primitives compose for the `settle-after-delivery` mode.
 */

import {
	type PaymentPayload,
	type PaymentRequired,
	type SettlementResponse,
	X402_CONTENT_TYPE,
	buildPaymentRequiredMessage,
	buildReceiptMessage,
} from "@rine-network/core";
import type { DecryptedMessage, MessageRead, MessageUuid } from "../types.js";
import { extractPaymentPayload } from "./x402-extract.js";
import {
	type FacilitatorConfig,
	type VerifyResponse,
	settlePayment,
	verifyPayment,
} from "./x402-facilitator.js";
import {
	type FulfillOptions,
	type FulfillResult,
	type PaymentsContext,
	type QuoteOptions,
	type Recipient,
	mergeMetadata,
	toPaymentPayload,
} from "./x402-shared.js";

/**
 * Issue a `payment_required` quote. When `target` is a received message the
 * quote threads as a reply (quoting a `task_request`, the common case); a
 * recipient handle/UUID opens a fresh conversation.
 */
export function issueQuote(
	ctx: PaymentsContext,
	target: Recipient | DecryptedMessage,
	pr: PaymentRequired,
	opts: QuoteOptions = {},
): Promise<MessageRead> {
	const built = buildPaymentRequiredMessage(pr, {
		emitMarker: opts.emitMarker,
	});
	const metadata = mergeMetadata(built.metadata, opts.metadata);
	if (typeof target === "string") {
		return ctx.client.send(target, built.payload, {
			type: built.type,
			contentType: X402_CONTENT_TYPE,
			metadata,
			agent: opts.agent,
			signal: opts.signal,
		});
	}
	return ctx.client.reply(target.id as MessageUuid, built.payload, {
		type: built.type,
		contentType: X402_CONTENT_TYPE,
		metadata,
		agent: opts.agent,
		signal: opts.signal,
	});
}

/** Verify a received `payment` via the facilitator (no broadcast). */
export function verify(
	payment: DecryptedMessage | PaymentPayload,
	opts: { facilitator: FacilitatorConfig; signal?: AbortSignal },
): Promise<VerifyResponse> {
	return verifyPayment(toPaymentPayload(payment), opts);
}

/** Settle a received `payment` via the facilitator (broadcast). */
export function settle(
	payment: DecryptedMessage | PaymentPayload,
	opts: { facilitator: FacilitatorConfig; signal?: AbortSignal },
): Promise<SettlementResponse> {
	return settlePayment(toPaymentPayload(payment), opts);
}

/**
 * Full settle-first flow: verify → settle → send `receipt` in-thread. On a
 * failed verification, settlement is skipped and a `success:false` receipt is
 * sent so the payer's thread reaches a terminal `payment-failed` state.
 */
export async function fulfill(
	ctx: PaymentsContext,
	payment: DecryptedMessage,
	opts: FulfillOptions,
): Promise<FulfillResult> {
	const pp = extractPaymentPayload(payment);
	const verification = await verifyPayment(pp, {
		facilitator: opts.facilitator,
		signal: opts.signal,
	});

	let settlement: SettlementResponse | null = null;
	let receiptBody: SettlementResponse;
	if (verification.isValid) {
		settlement = await settlePayment(pp, {
			facilitator: opts.facilitator,
			signal: opts.signal,
		});
		receiptBody = settlement;
	} else {
		receiptBody = {
			success: false,
			transaction: "",
			network: pp.accepted.network,
			payer: pp.payload.authorization.from,
			errorReason: verification.invalidReason ?? "verification_failed",
		};
	}

	const receipt = await sendReceipt(ctx, payment, receiptBody, {
		agent: opts.agent,
		emitMarker: opts.emitMarker,
		signal: opts.signal,
	});
	return { verification, settlement, receipt };
}

/** Send a `receipt` (settlement result) threaded to the payer's `payment`. */
export function sendReceipt(
	ctx: PaymentsContext,
	payment: DecryptedMessage,
	settlement: SettlementResponse,
	opts: { agent?: string; emitMarker?: boolean; signal?: AbortSignal } = {},
): Promise<MessageRead> {
	const built = buildReceiptMessage(settlement, {
		emitMarker: opts.emitMarker,
	});
	return ctx.client.reply(payment.id as MessageUuid, built.payload, {
		type: built.type,
		contentType: X402_CONTENT_TYPE,
		metadata: built.metadata,
		agent: opts.agent,
		signal: opts.signal,
	});
}
