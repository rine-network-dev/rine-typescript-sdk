/**
 * x402 payer helpers (payer side): pay a received `payment_required`
 * quote and (optionally) await the in-thread receipt. Policy is enforced at
 * signing (deny-by-default), the EIP-3009 authorization is signed with the
 * agent's wallet, and the `payment` is sent as an in-thread reply so the
 * exchange stays in one E2EE conversation.
 */

import {
	X402Error,
	X402_CONTENT_TYPE,
	X402_ERROR,
	buildPaymentMessage,
	buildPaymentPayload,
	isAutoPayable,
	loadPolicy,
	loadWalletKey,
	readDailySpent,
	reserveSpend,
	selectRequirement,
} from "@rine-network/core";
import type { DecryptedMessage, MessageUuid } from "../types.js";
import { anySignal, timeoutSignal } from "../utils/abort.js";
import { extractPaymentRequired } from "./x402-extract.js";
import {
	type PayOptions,
	type PayResult,
	type PaymentsContext,
	RECEIPT_TYPE,
	resolveAgentId,
} from "./x402-shared.js";

/**
 * Pay a received quote. All local work — requirement selection, auto-pay gate,
 * EIP-3009 signing, message build — happens first; `reserveSpend` then debits the
 * daily journal under the cross-process lock as the LAST act before the reply is
 * sent. A policy refusal (or an `ALREADY_PAID` re-pay without
 * `allowRepay`) throws {@link X402Error} and NO message is sent. The reservation
 * is fail-closed: once debited it stands even if the send then fails.
 */
export async function payQuote(
	ctx: PaymentsContext,
	quote: DecryptedMessage,
	opts: PayOptions = {},
): Promise<PayResult> {
	const pr = extractPaymentRequired(quote);
	const configDir = ctx.http.configDir;
	const agentId = await resolveAgentId(ctx, opts.agent, opts.signal);

	const policy = loadPolicy(configDir, agentId);
	const dailySpent = readDailySpent(configDir, agentId);
	const requirement = selectRequirement(pr, policy, dailySpent);

	if (opts.autoPay && policy && !isAutoPayable(policy, requirement)) {
		throw new X402Error(
			X402_ERROR.PER_TX_CAP_EXCEEDED,
			`Quote exceeds autoPayThreshold (${policy.autoPayThreshold}); manual confirmation required`,
		);
	}

	const walletKey = loadWalletKey(configDir, agentId);
	// stamp the answered quote's message id into the SIGNED payload so the
	// payee binds this payment to the ONE quote it authored (never a pooled union).
	const paymentPayload = buildPaymentPayload(pr, requirement, walletKey, {
		quoteMessageId: quote.id,
	});
	const built = buildPaymentMessage(paymentPayload, {
		emitMarker: opts.emitMarker,
	});

	// Last local act before transmit: reserve the spend under the lock (re-runs the
	// full policy against the fresh daily total, refuses a same-quote re-pay).
	await reserveSpend(configDir, agentId, policy, requirement, {
		messageId: quote.id,
		force: opts.allowRepay,
	});

	const payment = await ctx.client.reply(
		quote.id as MessageUuid,
		built.payload,
		{
			type: built.type,
			contentType: X402_CONTENT_TYPE,
			metadata: built.metadata,
			agent: opts.agent,
			signal: opts.signal,
		},
	);

	const result: PayResult = { payment, requirement, paymentPayload };
	if (opts.awaitReceipt) {
		result.receipt = await awaitReceipt(ctx, quote.conversation_id, {
			agent: opts.agent,
			timeout: opts.receiptTimeout,
			signal: opts.signal,
		});
	}
	return result;
}

/**
 * Wait for the payee's `receipt` in a conversation. Streams the agent's inbox
 * filtered to the conversation + receipt type, resolving on the first receipt
 * or null on timeout. Thread-aware; bounded by `timeout` (ms, default 60s).
 */
export async function awaitReceipt(
	ctx: PaymentsContext,
	conversationId: string,
	opts: { agent?: string; timeout?: number; signal?: AbortSignal } = {},
): Promise<DecryptedMessage | null> {
	const timeout = timeoutSignal(opts.timeout ?? 60_000);
	const signal = opts.signal
		? anySignal(opts.signal, timeout.signal)
		: timeout.signal;
	try {
		for await (const msg of ctx.client.messages({
			type: RECEIPT_TYPE,
			agent: opts.agent,
			signal,
		})) {
			if (msg.conversation_id === conversationId) return msg;
		}
	} catch (err) {
		// A timeout aborts the stream — swallow it and return null (no receipt
		// yet). A user-supplied abort or any other error propagates.
		if (!(err instanceof Error && err.name === "AbortError")) throw err;
	} finally {
		timeout.clear();
	}
	return null;
}
