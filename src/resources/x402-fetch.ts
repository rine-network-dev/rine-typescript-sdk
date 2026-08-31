/**
 * x402 HTTP fetch wrapper.
 *
 * Wraps a `fetch` call so a classic HTTP `402 Payment Required` is paid
 * automatically: parse the returned `PaymentRequired` quote, enforce the local
 * spend policy, sign the EIP-3009 authorization with the agent's wallet, and
 * retry the same request with an `X-PAYMENT` header. Reuses the SAME rine-core
 * wallet + policy primitives as the message-plane payer (`selectRequirement` /
 * `buildPaymentPayload` / spend journal) — no separate signing path.
 *
 * This is the HTTP-resource-gate realisation of x402 (Pattern A), distinct from
 * the message-attached flow (`PaymentsResource`, Pattern B). It is deliberately
 * compact; broader concerns (streaming, `upto` scheme, retries) are out of scope
 * for v1.0.
 */

import {
	type Eip3009Signed,
	type PaymentRequired,
	buildPaymentPayload,
	loadPolicy,
	loadWalletKey,
	readDailySpent,
	reserveSpend,
	selectRequirement,
} from "@rine-network/core";

export interface X402FetchOptions {
	/** Config dir holding the agent's wallet key + spend policy. */
	configDir: string;
	/** Agent id whose wallet signs (the `keys/{agentId}/` folder). */
	agentId: string;
	/** Injectable fetch (defaults to global `fetch`) — for tests / custom agents. */
	fetchImpl?: typeof fetch;
}

/**
 * The `X-PAYMENT` header value: base64 of the classic x402 client payment
 * object `{ x402Version, scheme, network, payload }`. The signed EIP-3009
 * authorization is reused verbatim from `buildPaymentPayload`.
 */
function encodePaymentHeader(
	pr: PaymentRequired,
	scheme: string,
	network: string,
	signed: Eip3009Signed,
): string {
	const obj = {
		x402Version: pr.x402Version,
		scheme,
		network,
		payload: signed,
	};
	return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}

/**
 * Build a `fetch`-compatible function that transparently pays x402 402
 * challenges. On a non-402 response the original response is returned unchanged.
 * A policy refusal throws (from `selectRequirement`) — the request is NOT paid.
 */
export function createX402Fetch(
	opts: X402FetchOptions,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
	const doFetch = opts.fetchImpl ?? fetch;
	return async (input, init) => {
		const first = await doFetch(input, init);
		if (first.status !== 402) return first;

		const pr = (await first.clone().json()) as PaymentRequired;
		const policy = loadPolicy(opts.configDir, opts.agentId);
		const dailySpent = readDailySpent(opts.configDir, opts.agentId);
		const requirement = selectRequirement(pr, policy, dailySpent);

		const walletKey = loadWalletKey(opts.configDir, opts.agentId);
		const payload = buildPaymentPayload(pr, requirement, walletKey);
		const header = encodePaymentHeader(
			pr,
			requirement.scheme,
			requirement.network,
			payload.payload,
		);

		const retryHeaders = new Headers(init?.headers);
		retryHeaders.set("X-PAYMENT", header);

		// The signed EIP-3009 authorization is settleable the instant it leaves
		// this process: a malicious or faulty server can call its facilitator's
		// /settle and pull `value` regardless of the HTTP status it returns.
		// Reserve the spend under the cross-process lock BEFORE issuing the paid
		// retry, so the daily cap bounds loss against exactly such a counterparty
		// (gating the debit on a 2xx let a server drain past the cap by always
		// replying non-2xx). The reservation is permanent — no refund path: a
		// transport error that never reached the server over-counts today's spend,
		// it never under-counts. No messageId here (the HTTP plane has no in-thread
		// id), so the double-pay guard does not apply.
		await reserveSpend(opts.configDir, opts.agentId, policy, requirement);
		return doFetch(input, { ...init, headers: retryHeaders });
	};
}
