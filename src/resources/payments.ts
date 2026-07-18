/**
 * PaymentsResource — the `client.payments` facade for x402 payer + payee flows
 * (REQ-M04, TS SDK slice).
 *
 * Payer:  receive a `payment_required` quote → policy check → sign → send the
 *         `payment` in-thread → (optionally) await the receipt.
 * Payee:  issue a `payment_required` quote → on the payer's `payment`, verify
 *         and settle via the configured facilitator → send the `receipt`.
 *
 * The logic lives in `x402-payer.ts` / `x402-payee.ts` as free functions taking
 * a `PaymentsContext`; this class is a thin delegator plus wallet/policy
 * conveniences. All rine sends go through `client.reply()` / `client.send()`
 * (the shared encrypt → POST path), so the exchange stays in one E2EE thread and
 * the undelivered-queue invariant is satisfied server-side. Facilitator
 * verify/settle is plain external HTTP (never rine); the verbatim x402 V2 objects
 * are built/parsed by rine-core and never reshaped here.
 */

import {
	type PaymentPayload,
	type PaymentPolicy,
	type PaymentRequired,
	type SettlementResponse,
	createWallet,
	getWalletAddress,
	loadPolicy,
	savePolicy,
} from "@rine-network/core";
import type { SDKHttpClient } from "../api/http.js";
import type { AsyncRineClient } from "../client.js";
import type { DecryptedMessage, MessageRead } from "../types.js";
import type { FacilitatorConfig, VerifyResponse } from "./x402-facilitator.js";
import {
	fulfill,
	issueQuote,
	sendReceipt,
	settle,
	verify,
} from "./x402-payee.js";
import { awaitReceipt, payQuote } from "./x402-payer.js";
import {
	type FulfillOptions,
	type FulfillResult,
	type PayOptions,
	type PayResult,
	type PaymentsContext,
	type QuoteOptions,
	type Recipient,
	resolveAgentId,
} from "./x402-shared.js";

export type {
	PayOptions,
	PayResult,
	QuoteOptions,
	FulfillOptions,
	FulfillResult,
} from "./x402-shared.js";

export class PaymentsResource {
	private readonly ctx: PaymentsContext;

	constructor(
		client: AsyncRineClient,
		private readonly http: SDKHttpClient,
		messages: PaymentsContext["messages"],
	) {
		this.ctx = { client, http, messages };
	}

	// ---- wallet / policy conveniences (thin over rine-core) ----------------

	/** The EVM wallet address for the acting agent. */
	async walletAddress(opts: { agent?: string; signal?: AbortSignal } = {}) {
		return getWalletAddress(this.http.configDir, await this.agentId(opts));
	}

	/** Create the agent's payment wallet (refuses to clobber an existing key). */
	async createWallet(opts: { agent?: string; signal?: AbortSignal } = {}) {
		return createWallet(this.http.configDir, await this.agentId(opts));
	}

	/** The acting agent's spend policy, or null when none is configured. */
	async getPolicy(opts: { agent?: string; signal?: AbortSignal } = {}) {
		return loadPolicy(this.http.configDir, await this.agentId(opts));
	}

	/** Persist the acting agent's spend policy (validated before write). */
	async setPolicy(
		policy: PaymentPolicy,
		opts: { agent?: string; signal?: AbortSignal } = {},
	) {
		savePolicy(this.http.configDir, await this.agentId(opts), policy);
	}

	// ---- payer -------------------------------------------------------------

	/** Pay a received `payment_required` quote (see {@link payQuote}). */
	pay(quote: DecryptedMessage, opts: PayOptions = {}): Promise<PayResult> {
		return payQuote(this.ctx, quote, opts);
	}

	/** Await the payee's in-thread receipt (see {@link awaitReceipt}). */
	awaitReceipt(
		conversationId: string,
		opts: { agent?: string; timeout?: number; signal?: AbortSignal } = {},
	): Promise<DecryptedMessage | null> {
		return awaitReceipt(this.ctx, conversationId, opts);
	}

	// ---- payee -------------------------------------------------------------

	/** Issue a `payment_required` quote (fresh send or in-thread reply). */
	quote(
		target: Recipient | DecryptedMessage,
		pr: PaymentRequired,
		opts: QuoteOptions = {},
	): Promise<MessageRead> {
		return issueQuote(this.ctx, target, pr, opts);
	}

	/** Verify a received `payment` via the configured facilitator (no broadcast). */
	verify(
		payment: DecryptedMessage | PaymentPayload,
		opts: { facilitator: FacilitatorConfig; signal?: AbortSignal },
	): Promise<VerifyResponse> {
		return verify(payment, opts);
	}

	/** Settle a received `payment` via the configured facilitator (broadcast). */
	settle(
		payment: DecryptedMessage | PaymentPayload,
		opts: { facilitator: FacilitatorConfig; signal?: AbortSignal },
	): Promise<SettlementResponse> {
		return settle(payment, opts);
	}

	/** Verify → settle → send `receipt` in-thread (settle-first). */
	fulfill(
		payment: DecryptedMessage,
		opts: FulfillOptions,
	): Promise<FulfillResult> {
		return fulfill(this.ctx, payment, opts);
	}

	/** Send a `receipt` (settlement result) threaded to the payer's `payment`. */
	sendReceipt(
		payment: DecryptedMessage,
		settlement: SettlementResponse,
		opts: { agent?: string; emitMarker?: boolean; signal?: AbortSignal } = {},
	): Promise<MessageRead> {
		return sendReceipt(this.ctx, payment, settlement, opts);
	}

	// ---- internals ---------------------------------------------------------

	private agentId(opts: {
		agent?: string;
		signal?: AbortSignal;
	}): Promise<string> {
		return resolveAgentId(this.ctx, opts.agent, opts.signal);
	}
}
