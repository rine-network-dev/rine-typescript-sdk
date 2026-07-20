/**
 * Shared context, option/result types, and small helpers for the x402 payer
 * (`x402-payer.ts`) and payee (`x402-payee.ts`) modules. The `PaymentsResource`
 * facade wires these together; splitting the logic keeps each module under the
 * file-size cap while the class stays a thin delegator.
 */

import type {
	FacilitatorConfig,
	PaymentPayload,
	PaymentRequirements,
	SettlementResponse,
	VerifyResponse,
} from "@rine-network/core";
import type { SDKHttpClient } from "../api/http.js";
import type { AsyncRineClient } from "../client.js";
import type {
	AgentHandle,
	AgentUuid,
	DecryptedMessage,
	GroupHandle,
	GroupUuid,
	MessageRead,
} from "../types.js";
import type { MessagesResource } from "./messages.js";
import { extractPaymentPayload } from "./x402-extract.js";

/** Everything the payer/payee helpers need from the client. */
export interface PaymentsContext {
	readonly client: AsyncRineClient;
	readonly http: SDKHttpClient;
	readonly messages: MessagesResource;
}

export type Recipient = AgentHandle | AgentUuid | GroupHandle | GroupUuid;

/** The `rine.v1.x402_receipt` message type (kept local to avoid a stray literal). */
export const RECEIPT_TYPE = "rine.v1.x402_receipt";

export interface PayOptions {
	/** Sign on behalf of this agent (multi-agent orgs). Defaults to the client's agent. */
	agent?: string;
	/** Only pay when the quote is at/below `autoPayThreshold`; else throw. */
	autoPay?: boolean;
	/** Omit the cleartext status marker on the payment message (fully sealed). */
	emitMarker?: boolean;
	/** After sending, wait for the payee's receipt in-thread. Default false. */
	awaitReceipt?: boolean;
	/** Timeout (ms) for `awaitReceipt`. Default 60_000. */
	receiptTimeout?: number;
	/**
	 * Re-pay a quote whose message id is already in today's journal. Bypasses the
	 * ALREADY_PAID guard and debits again (a deliberate second, permanent spend).
	 */
	allowRepay?: boolean;
	signal?: AbortSignal;
}

export interface PayResult {
	/** The sent `rine.v1.x402_payment` envelope. */
	payment: MessageRead;
	/** The requirement selected from the quote's `accepts[]`. */
	requirement: PaymentRequirements;
	/** The signed payload that was sent. */
	paymentPayload: PaymentPayload;
	/** The payee's receipt, if `awaitReceipt` was set and one arrived. */
	receipt?: DecryptedMessage | null;
}

export interface QuoteOptions {
	agent?: string;
	emitMarker?: boolean;
	metadata?: Record<string, unknown>;
	signal?: AbortSignal;
}

export interface FulfillOptions {
	facilitator: FacilitatorConfig;
	agent?: string;
	emitMarker?: boolean;
	signal?: AbortSignal;
}

export interface FulfillResult {
	verification: VerifyResponse;
	settlement: SettlementResponse | null;
	receipt: MessageRead;
}

/** Resolve the acting agent's UUID via the shared sender-resolution path. */
export function resolveAgentId(
	ctx: PaymentsContext,
	agent: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const core = ctx.http.getCoreHttpClient(signal ? { signal } : {});
	return ctx.messages.resolveSenderId(core, agent);
}

/** Merge the x402 marker block onto any caller-supplied cleartext metadata. */
export function mergeMetadata(
	marker: Record<string, unknown> | undefined,
	extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!marker && !extra) return undefined;
	return { ...extra, ...marker };
}

/** Accept either a decrypted `payment` message or a raw `PaymentPayload`. */
export function toPaymentPayload(
	payment: DecryptedMessage | PaymentPayload,
): PaymentPayload {
	return "id" in payment && "type" in payment
		? extractPaymentPayload(payment as DecryptedMessage)
		: (payment as PaymentPayload);
}
