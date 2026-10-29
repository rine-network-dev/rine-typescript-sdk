/**
 * Shared context, option/result types, and small helpers for the x402 payer
 * (`x402-payer.ts`) and payee (`x402-payee.ts`) modules. The `PaymentsResource`
 * facade wires these together; splitting the logic keeps each module under the
 * file-size cap while the class stays a thin delegator.
 */

import {
	type FacilitatorConfig,
	type MatchedQuote,
	type PaymentPayload,
	type PaymentRequirements,
	type ResolvedPayeeRequirement,
	type SettlementResponse,
	type VerifyResponse,
	reconcilePayment,
	requireVerifiedSender,
	requirementAmount,
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

export type { MatchedQuote } from "@rine-network/core";

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
	/**
	 * Fully operator-authored expected terms for an OUT-OF-BAND quote (escape
	 * hatch). When supplied they OVERRIDE the payment's quote reference (operator
	 * intent wins, no ref needed); when omitted, `fulfill` binds the payment to the
	 * ONE quote it references (`extensions["rine.quoteMessageId"]`) and fails CLOSED
	 * (`NO_QUOTE`) if the ref is missing/forged — never settling payer-authored terms.
	 */
	expected?: PaymentRequirements;
	signal?: AbortSignal;
}

/**
 * Options for the standalone `verify`/`settle` primitives (settle-after-delivery
 * mode). These have no thread context to resolve a quote ref, so `expected` is the
 * ONLY quote source: without it the payee fails CLOSED (`NO_QUOTE`) rather than
 * trusting the payer's echoed `accepted` block.
 */
export interface VerifySettleOptions {
	facilitator: FacilitatorConfig;
	/** The payee-authored terms the payment must satisfy (its own issued quote). */
	expected?: PaymentRequirements;
	signal?: AbortSignal;
}

export interface FulfillResult {
	verification: VerifyResponse;
	settlement: SettlementResponse | null;
	receipt: MessageRead;
	/**
	 * The quote the settled payment answered: its message id (null for an
	 * operator `expected` override) plus the reconciled amount/asset/network. Null
	 * when the payment was refused before a quote could be resolved (malformed
	 * payload, or an unresolvable ref). The payee integration owns the
	 * good<->quote correspondence — confirm this matches the good you deliver.
	 */
	matchedQuote: MatchedQuote | null;
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

/**
 * The money gate for a received row: throws unless the row is `verified` as
 * signed by its server-authenticated sender. A row that failed to decrypt or is
 * cleartext A2A carries a final refusal, never the retryable one.
 */
export function requireVerifiedRow(message: DecryptedMessage): void {
	requireVerifiedSender(
		{
			verificationStatus: message.verification_status,
			senderKid: message.sender_kid,
			decryptError: message.decrypt_error,
			a2aCleartext: message.a2a_cleartext,
		},
		message.from_agent_id,
		message.id,
	);
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

// --- payee-side reconciliation ----------------------------------------------

/**
 * Resolve a payment against a FULLY operator-authored `expected` requirement — the
 * SDK's override branch, authoritative and needing no quote ref. Reuses
 * rine-core's pure {@link reconcilePayment}; a payment matching the operator's
 * single quote entry (right `payTo`/asset/network/scheme, ≥ amount) yields the
 * payee-owned requirement to settle, else `REQUIREMENT_MISMATCH`. The match carries
 * a null `quoteMessageId` (no in-thread quote was referenced). Callers forward the
 * RETURNED requirement to the facilitator — never `pp.accepted`.
 *
 * Because `expected` is authored end-to-end by the operator, its `extra`
 * (EIP-712 domain) and `maxTimeoutSeconds` are trusted — the CLI/MCP string-flag
 * override is the surface that must re-derive `extra` from the registry instead.
 */
export function reconcileExpected(
	pp: PaymentPayload,
	expected: PaymentRequirements,
): ResolvedPayeeRequirement {
	const requirement = reconcilePayment(pp, [expected]);
	return {
		requirement,
		match: {
			quoteMessageId: null,
			amount: requirementAmount(requirement),
			asset: requirement.asset,
			network: requirement.network,
		},
	};
}
