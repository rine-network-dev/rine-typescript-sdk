/**
 * x402 payee helpers: issue a `payment_required` quote, verify + settle
 * a received `payment` via the facilitator (plain external HTTP, never rine), and
 * send the `receipt`. `fulfill` is settle-first; `verify`/`settle`/`sendReceipt`
 * compose for `settle-after-delivery`.
 *
 * `fulfill` never settles the payer-echoed `accepted`. It binds the payment
 * to the ONE quote it references (`extensions["rine.quoteMessageId"]`, proven
 * payee-issued by rine-core's shared `resolvePayeeRequirement`) or to operator
 * `expected` terms; a missing/forged ref with no override fails CLOSED (`NO_QUOTE`).
 */

import {
	type PaymentPayload,
	type PaymentRequired,
	type ResolvedPayeeRequirement,
	type SettlementResponse,
	X402Error,
	X402_CONTENT_TYPE,
	X402_ERROR,
	buildPaymentRequiredMessage,
	buildReceiptMessage,
	refusalReceiptBody,
	resolvePayeeRequirement,
	settleToReceipt,
} from "@rine-network/core";
import type { DecryptedMessage, MessageRead, MessageUuid } from "../types.js";
import { extractPaymentPayload } from "./x402-extract.js";
import {
	type FulfillOptions,
	type FulfillResult,
	type MatchedQuote,
	type PaymentsContext,
	type QuoteOptions,
	type Recipient,
	mergeMetadata,
	reconcileExpected,
	requireVerifiedRow,
	resolveAgentId,
} from "./x402-shared.js";

/**
 * Issue a `payment_required` quote. A received-message `target` threads as a reply
 * (quoting a `task_request`); a recipient handle/UUID opens a fresh conversation.
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

/**
 * Settle-first flow: bind → verify → settle → send `receipt` in-thread.
 * `opts.expected` wins, else the ONE quote the payment references is loaded and
 * reconciled. A missing/forged ref with no override, no matching terms (wrong
 * `payTo`/asset/network/scheme or underpayment), or a malformed payload all
 * REFUSE with a `success:false` receipt — the payer `accepted` block is never
 * forwarded. {@link FulfillResult.matchedQuote} names the reconciled quote so the
 * caller can bind it to the good it delivers. A payment whose sender is not
 * `verified` is refused the same way, before anything is parsed or settled. A
 * sender whose key could not be read (`SENDER_UNVERIFIABLE`) is the exception:
 * it throws, like a facilitator outage, with no receipt and the thread left
 * open, so the same payment can be fulfilled once the lookup works.
 */
export async function fulfill(
	ctx: PaymentsContext,
	payment: DecryptedMessage,
	opts: FulfillOptions,
): Promise<FulfillResult> {
	let pp: PaymentPayload;
	try {
		requireVerifiedRow(payment);
		pp = extractPaymentPayload(payment);
	} catch (err) {
		if (err instanceof X402Error && err.code === X402_ERROR.SENDER_UNVERIFIABLE)
			throw err;
		return refuse(ctx, payment, opts, reason(err), "", "", null);
	}

	let resolved: ResolvedPayeeRequirement;
	try {
		resolved = opts.expected
			? reconcileExpected(pp, opts.expected)
			: await resolveReferenced(ctx, payment, pp, opts);
	} catch (err) {
		return refuse(
			ctx,
			payment,
			opts,
			reason(err),
			pp.accepted.network,
			pp.payload.authorization.from,
			null,
		);
	}

	const outcome = await settleToReceipt(
		pp,
		resolved,
		opts.facilitator,
		opts.signal,
	);
	const receipt = await sendReceipt(ctx, payment, outcome.receiptBody, {
		agent: opts.agent,
		emitMarker: opts.emitMarker,
		signal: opts.signal,
	});
	return {
		// The REAL facilitator `/verify` response threaded through `settleToReceipt`
		// — `payer` and any provider-specific fields survive to the caller instead of
		// a synthesised `{ isValid }` stand-in.
		verification: outcome.verification,
		settlement: outcome.status === "verification-failed" ? null : outcome.receiptBody,
		receipt,
		matchedQuote: outcome.matchedQuote,
	};
}

/**
 * Resolve the payee-owned requirement from the payment's quote reference:
 * resolve the payee agent + core HTTP client, then delegate to rine-core's shared
 * {@link resolvePayeeRequirement} with no override (`expected: {}`) — it loads the
 * referenced quote, proves it payee-issued + same-conversation, reconciles, and
 * raises `NO_QUOTE` for any missing/forged ref.
 */
function resolveReferenced(
	ctx: PaymentsContext,
	payment: DecryptedMessage,
	pp: PaymentPayload,
	opts: FulfillOptions,
): Promise<ResolvedPayeeRequirement> {
	const client = ctx.http.getCoreHttpClient(
		opts.signal ? { signal: opts.signal } : {},
	);
	return resolveAgentId(ctx, opts.agent, opts.signal).then((payeeAgentId) =>
		resolvePayeeRequirement({
			payment: pp,
			expected: {},
			client,
			configDir: ctx.http.configDir,
			payeeAgentId,
			conversationId: payment.conversation_id,
		}),
	);
}

/** The typed x402 refusal code to surface on a receipt; rethrow anything else. */
function reason(err: unknown): string {
	if (err instanceof X402Error) return err.code;
	throw err;
}

/** Thread a graceful `payment-failed` receipt and return a settled-nothing result. */
function refuse(
	ctx: PaymentsContext,
	payment: DecryptedMessage,
	opts: FulfillOptions,
	errorReason: string,
	network: string,
	payer: string,
	match: MatchedQuote | null,
): Promise<FulfillResult> {
	return sendReceipt(
		ctx,
		payment,
		refusalReceiptBody(network, payer, errorReason),
		{ agent: opts.agent, emitMarker: opts.emitMarker, signal: opts.signal },
	).then((receipt) => ({
		verification: { isValid: false, invalidReason: errorReason },
		settlement: null,
		receipt,
		matchedQuote: match,
	}));
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
