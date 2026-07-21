/**
 * REQ-M04 (TS SDK slice) — x402 payer + payee helpers.
 *
 * The rine-core bridge's NETWORK-touching functions are mocked so no real HTTP
 * or peer keys are needed; the x402 wallet/policy/build primitives stay REAL
 * (a fresh temp configDir carries a real secp256k1 wallet + spend policy), so
 * these tests exercise genuine EIP-3009 signing and genuine policy enforcement.
 * The facilitator is mocked at the global `fetch` layer.
 *
 * R-1 binding: the payer stamps `extensions["rine.quoteMessageId"]` into the
 * signed payload; the payee resolves THAT quote via rine-core's shared
 * `resolvePayeeRequirement` (mocked here at the package boundary — its ref-load +
 * self-decrypt is exhaustively tested in rine-core), then reconciles + settles.
 * The operator `expected` override runs the REAL `reconcilePayment` end-to-end.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OUR_AGENT_ID = randomUUID();
const PAYEE_ID = randomUUID();
const EURC_BASE = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42";

let capturedEncryptPayload: unknown;

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@rine-network/core")>();
	return {
		...actual,
		fetchAgents: vi.fn(async () => [
			{ id: OUR_AGENT_ID, handle: "me@acme.rine.network" },
		]),
		resolveAgent: vi.fn(async () => OUR_AGENT_ID),
		resolveToUuid: vi.fn(async () => PAYEE_ID),
		fetchRecipientKeys: vi.fn(async () => ({ encryption: new Uint8Array(32) })),
		normalizeHandle: vi.fn((h: string) => h),
		// R-1 quote-ref resolution (ref load + self-decrypt + payee-issued proof)
		// lives in rine-core and is unit-tested there; the SDK only needs to wire
		// its result through, so we control the seam here.
		resolvePayeeRequirement: vi.fn(),
		encryptMessage: vi.fn(async (_c, _s, _k, payload: unknown) => {
			capturedEncryptPayload = payload;
			return {
				encrypted_payload: "CIPHERTEXT",
				encryption_version: "hpke-v1",
				sender_signing_kid: `rine:${OUR_AGENT_ID}`,
			};
		}),
	};
});

const core = await import("@rine-network/core");
const { AsyncRineClient } = await import("../client.js");
const { FACILITATOR_PRESET, X402Error, X402_ERROR, X402_QUOTE_REF_KEY } = core;

const resolvePayeeRequirementMock = vi.mocked(core.resolvePayeeRequirement);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HAPPY_POLICY = {
	perTxCap: "1.00",
	dailyCap: "10.00",
	allowedAssets: ["EURC"],
	allowedNetworks: ["eip155:8453"],
	autoPayThreshold: "1.00",
};

function paymentRequired(amount = "100000") {
	return {
		x402Version: 2,
		resource: {
			url: "rine:task",
			description: "translate",
			mimeType: "application/json",
		},
		accepts: [
			{
				scheme: "exact",
				network: "eip155:8453",
				amount,
				asset: EURC_BASE,
				payTo: "0x000000000000000000000000000000000000dEaD",
				maxTimeoutSeconds: 60,
				extra: { name: "EURC", version: "2" },
			},
		],
		extensions: {},
	};
}

/** The payee-authored requirement (accepts[0]) a resolved quote settles against. */
function payeeRequirement(amount = "100000") {
	return paymentRequired(amount).accepts[0] as Record<string, unknown>;
}

/** A resolved-quote struct as rine-core's `resolvePayeeRequirement` returns it. */
function resolvedQuote(
	requirement: Record<string, unknown>,
	quoteMessageId: string | null,
) {
	return {
		requirement,
		match: {
			quoteMessageId,
			amount: requirement.amount,
			asset: requirement.asset,
			network: requirement.network,
		},
	} as unknown as Awaited<ReturnType<typeof core.resolvePayeeRequirement>>;
}

function quoteMessage(pr = paymentRequired()) {
	return {
		id: randomUUID(),
		conversation_id: randomUUID(),
		from_agent_id: PAYEE_ID,
		to_agent_id: OUR_AGENT_ID,
		type: "rine.v1.x402_payment_required",
		content_type: "application/json",
		plaintext: pr,
		metadata: {},
		decrypt_error: null,
	} as unknown as import("../types.js").DecryptedMessage;
}

const REPLY_RESPONSE = {
	id: randomUUID(),
	conversation_id: randomUUID(),
	from_agent_id: OUR_AGENT_ID,
	to_agent_id: PAYEE_ID,
	type: "rine.v1.x402_payment",
	encrypted_payload: "CIPHERTEXT",
	encryption_version: "hpke-v1",
	created_at: "2026-07-17T00:00:00.000Z",
	metadata: {},
};

let tmp: string;
let posts: Array<{ path: string; body: Record<string, unknown> }>;

function markerStatus(body: Record<string, unknown> | undefined): string {
	const md = (body?.metadata ?? {}) as Record<string, { status?: string }>;
	return md["rine.x402"]?.status ?? "";
}

function makeClient(originalFor: ReturnType<typeof quoteMessage>) {
	const client = new AsyncRineClient({
		configDir: tmp,
		agent: "me@acme.rine.network",
	});
	posts = [];
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.post = vi.fn(
		async (path: string, body: Record<string, unknown>) => {
			posts.push({ path, body });
			return { ...REPLY_RESPONSE, type: body.type };
		},
	);
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.get = vi.fn(async () => ({}));
	// core.get is used by reply() to fetch the original message.
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).http.getCoreHttpClient = () => ({
		get: async (path: string) => {
			if (path.startsWith("/messages/")) {
				return {
					id: originalFor.id,
					conversation_id: originalFor.conversation_id,
					from_agent_id: PAYEE_ID,
					to_agent_id: OUR_AGENT_ID,
					type: originalFor.type,
					encrypted_payload: "CIPHERTEXT",
					encryption_version: "hpke-v1",
					created_at: "2026-07-17T00:00:00.000Z",
					metadata: {},
				};
			}
			return {};
		},
		post: async () => ({}),
	});
	return client;
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "rine-x402-"));
	core.createWallet(tmp, OUR_AGENT_ID);
	capturedEncryptPayload = undefined;
	resolvePayeeRequirementMock.mockReset();
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Payer
// ---------------------------------------------------------------------------

describe("PaymentsResource payer", () => {
	it("test_pay_when_policy_allows_signs_and_sends_payment_in_thread", async () => {
		core.savePolicy(tmp, OUR_AGENT_ID, HAPPY_POLICY);
		const quote = quoteMessage();
		const client = makeClient(quote);

		const result = await client.payments.pay(quote);

		// Sent as an in-thread reply of the payment type, carrying the marker.
		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toBe(`/messages/${quote.id}/reply`);
		expect(posts[0]?.body.type).toBe("rine.v1.x402_payment");
		expect(markerStatus(posts[0]?.body)).toBe("payment-submitted");

		// The verbatim PaymentPayload was handed to the encrypt layer unchanged.
		const encrypted = capturedEncryptPayload as {
			accepted: { asset: string };
			payload: { signature: string; authorization: { from: string } };
		};
		expect(encrypted.accepted.asset).toBe(EURC_BASE);

		// Real EIP-3009 signature (65 bytes) that recovers to the real wallet.
		const sig = result.paymentPayload.payload.signature;
		expect(sig).toMatch(/^0x[0-9a-f]{130}$/i);
		expect(encrypted.payload.authorization.from).toBe(
			core.getWalletAddress(tmp, OUR_AGENT_ID),
		);

		// Spend was recorded (0.10 EURC = 100000 canonical micro-units).
		expect(core.readDailySpent(tmp, OUR_AGENT_ID)).toBe(100000n);
	});

	it("test_pay_stamps_answered_quote_ref_into_signed_payload", async () => {
		core.savePolicy(tmp, OUR_AGENT_ID, HAPPY_POLICY);
		const quote = quoteMessage();
		const client = makeClient(quote);

		const result = await client.payments.pay(quote);

		// R-1: the answered quote's message id rides inside the SIGNED, E2EE payload
		// so the payee can bind this payment to the ONE quote it authored.
		const stamped = (
			result.paymentPayload.extensions as Record<string, unknown>
		)[X402_QUOTE_REF_KEY];
		expect(stamped).toBe(quote.id);
		const encrypted = capturedEncryptPayload as {
			extensions: Record<string, unknown>;
		};
		expect(encrypted.extensions[X402_QUOTE_REF_KEY]).toBe(quote.id);
	});

	it("test_pay_when_no_policy_denies_by_default_and_sends_nothing", async () => {
		// No savePolicy → deny-by-default.
		const quote = quoteMessage();
		const client = makeClient(quote);

		await expect(client.payments.pay(quote)).rejects.toMatchObject({
			name: "X402Error",
			code: "no-acceptable-requirement",
		});
		expect(posts).toHaveLength(0);
		expect(core.readDailySpent(tmp, OUR_AGENT_ID)).toBe(0n);
	});

	it("test_pay_when_amount_exceeds_per_tx_cap_refuses_and_no_spend", async () => {
		core.savePolicy(tmp, OUR_AGENT_ID, { ...HAPPY_POLICY, perTxCap: "0.01" });
		const quote = quoteMessage(); // 0.10 EURC > 0.01 cap
		const client = makeClient(quote);

		await expect(client.payments.pay(quote)).rejects.toMatchObject({
			name: "X402Error",
		});
		expect(posts).toHaveLength(0);
		expect(core.readDailySpent(tmp, OUR_AGENT_ID)).toBe(0n);
	});

	it("test_pay_same_quote_twice_is_already_paid_unless_allowRepay", async () => {
		core.savePolicy(tmp, OUR_AGENT_ID, HAPPY_POLICY);
		const quote = quoteMessage(); // stable id — the S6 double-pay guard keys on it
		const client = makeClient(quote);

		await client.payments.pay(quote);
		expect(core.readDailySpent(tmp, OUR_AGENT_ID)).toBe(100000n);

		// Re-paying the same quote id is refused and does NOT debit again.
		await expect(client.payments.pay(quote)).rejects.toMatchObject({
			name: "X402Error",
			code: "already-paid",
		});
		expect(core.readDailySpent(tmp, OUR_AGENT_ID)).toBe(100000n);

		// allowRepay forces a second, deliberate, permanent debit.
		await client.payments.pay(quote, { allowRepay: true });
		expect(core.readDailySpent(tmp, OUR_AGENT_ID)).toBe(200000n);
	});

	it("test_pay_when_autoPay_and_over_threshold_refuses", async () => {
		core.savePolicy(tmp, OUR_AGENT_ID, {
			...HAPPY_POLICY,
			autoPayThreshold: "0.05",
		});
		const quote = quoteMessage(); // 0.10 EURC > 0.05 autoPay threshold
		const client = makeClient(quote);

		await expect(
			client.payments.pay(quote, { autoPay: true }),
		).rejects.toMatchObject({ name: "X402Error" });
		expect(posts).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Payee
// ---------------------------------------------------------------------------

describe("PaymentsResource payee", () => {
	// The payer's echoed `accepted` block — overridable so a hostile payer can
	// diverge it from the payee's quote (F-1 attack vectors).
	function paymentMessage(
		accepted: Record<string, unknown> = payeeRequirement(),
	) {
		return {
			id: randomUUID(),
			conversation_id: randomUUID(),
			from_agent_id: OUR_AGENT_ID,
			to_agent_id: PAYEE_ID,
			type: "rine.v1.x402_payment",
			content_type: "application/json",
			plaintext: {
				x402Version: 2,
				accepted,
				payload: {
					signature: `0x${"11".repeat(65)}`,
					authorization: {
						from: "0x1111111111111111111111111111111111111111",
						to: "0x000000000000000000000000000000000000dEaD",
						value: "100000",
						validAfter: "1",
						validBefore: "9999999999",
						nonce: `0x${"22".repeat(32)}`,
					},
				},
				extensions: { [X402_QUOTE_REF_KEY]: "quote-abc" },
			},
			metadata: {},
			decrypt_error: null,
		} as unknown as import("../types.js").DecryptedMessage;
	}

	/** Stub the facilitator verify (+settle) responses at the fetch layer. */
	function stubFacilitator(...bodies: Record<string, unknown>[]) {
		const fetchMock = vi.fn();
		for (const body of bodies) {
			fetchMock.mockResolvedValueOnce(
				new Response(JSON.stringify(body), { status: 200 }),
			);
		}
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	const SETTLEMENT = {
		success: true,
		transaction: "0xabc",
		network: "eip155:8453",
		payer: "0x1111",
	};

	it("test_quote_to_recipient_sends_payment_required_with_marker", async () => {
		const client = makeClient(quoteMessage());
		const pr = paymentRequired();

		await client.payments.quote("bob@acme.rine.network" as never, pr as never);

		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toBe("/messages");
		expect(posts[0]?.body.type).toBe("rine.v1.x402_payment_required");
		expect(markerStatus(posts[0]?.body)).toBe("payment-required");
		// Verbatim quote object handed to encrypt.
		expect(capturedEncryptPayload).toEqual(pr);
	});

	it("test_verify_posts_standard_facilitator_body_to_verify_endpoint", async () => {
		const fetchMock = stubFacilitator({ isValid: true, payer: "0x1111" });
		const client = makeClient(quoteMessage());

		// `expected` supplies the payee-owned terms the standalone verify reconciles
		// against (no thread context on this primitive).
		const res = await client.payments.verify(paymentMessage(), {
			facilitator: FACILITATOR_PRESET.payai,
			expected: payeeRequirement() as never,
		});

		expect(res.isValid).toBe(true);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://facilitator.payai.network/verify");
		const body = JSON.parse(init.body as string);
		expect(body.x402Version).toBe(2);
		expect(body.paymentRequirements.asset).toBe(EURC_BASE);
		expect(body.paymentPayload.payload.signature).toMatch(/^0x/);
	});

	// -----------------------------------------------------------------------
	// R-1 — payee binds to the ONE referenced quote, never the payer's `accepted`
	// -----------------------------------------------------------------------

	it("test_fulfill_ref_bind_settles_and_surfaces_matched_quote", async () => {
		resolvePayeeRequirementMock.mockResolvedValue(
			resolvedQuote(payeeRequirement(), "quote-abc"),
		);
		const fetchMock = stubFacilitator({ isValid: true }, SETTLEMENT);
		const payment = paymentMessage();
		const client = makeClient(payment);

		const result = await client.payments.fulfill(payment, {
			facilitator: FACILITATOR_PRESET.payai,
		});

		expect(result.settlement?.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// The payment was bound to the referenced quote in THIS conversation.
		expect(resolvePayeeRequirementMock).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: payment.conversation_id }),
		);
		// The facilitator saw the PAYEE-owned requirement, never pp.accepted.
		const verifyBody = JSON.parse(
			(fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
		);
		expect(verifyBody.paymentRequirements.payTo).toBe(
			"0x000000000000000000000000000000000000dEaD",
		);
		// The matched quote is surfaced for good<->quote binding.
		expect(result.matchedQuote).toEqual({
			quoteMessageId: "quote-abc",
			amount: "100000",
			asset: EURC_BASE,
			network: "eip155:8453",
		});
		expect(posts[0]?.body.type).toBe("rine.v1.x402_receipt");
		expect(markerStatus(posts[0]?.body)).toBe("payment-completed");
	});

	it("test_fulfill_threads_real_facilitator_verify_response_fields", async () => {
		// The facilitator's `/verify` reply carries `payer` plus provider-specific
		// fields; fulfill must thread that REAL response through — not synthesise a
		// bare `{ isValid: true }` that drops everything the facilitator returned.
		resolvePayeeRequirementMock.mockResolvedValue(
			resolvedQuote(payeeRequirement(), "quote-abc"),
		);
		stubFacilitator(
			{
				isValid: true,
				payer: "0x1111111111111111111111111111111111111111",
				riskScore: 7,
			},
			SETTLEMENT,
		);
		const payment = paymentMessage();
		const client = makeClient(payment);

		const result = await client.payments.fulfill(payment, {
			facilitator: FACILITATOR_PRESET.payai,
		});

		expect(result.verification.isValid).toBe(true);
		// `payer` and the provider-specific `riskScore` survive to the caller.
		expect(result.verification.payer).toBe(
			"0x1111111111111111111111111111111111111111",
		);
		expect(result.verification.riskScore).toBe(7);
		expect(result.settlement?.success).toBe(true);
	});

	it("test_fulfill_when_invalid_skips_settle_and_still_surfaces_quote", async () => {
		resolvePayeeRequirementMock.mockResolvedValue(
			resolvedQuote(payeeRequirement(), "quote-abc"),
		);
		const fetchMock = stubFacilitator({
			isValid: false,
			invalidReason: "insufficient_funds",
			payer: "0x1111111111111111111111111111111111111111",
		});
		const payment = paymentMessage();
		const client = makeClient(payment);

		const result = await client.payments.fulfill(payment, {
			facilitator: FACILITATOR_PRESET.payai,
		});

		expect(result.settlement).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1); // verify only, no settle
		expect(result.verification.invalidReason).toBe("insufficient_funds");
		// The REAL verify response is threaded on the failure branch too, so `payer`
		// survives instead of being dropped by a synthesised `{ isValid: false }`.
		expect(result.verification.payer).toBe(
			"0x1111111111111111111111111111111111111111",
		);
		// A quote WAS resolved, so its provenance still rides through.
		expect(result.matchedQuote?.quoteMessageId).toBe("quote-abc");
		expect(capturedEncryptPayload).toMatchObject({
			success: false,
			errorReason: "insufficient_funds",
		});
		expect(markerStatus(posts[0]?.body)).toBe("payment-failed");
	});

	it("test_fulfill_refuses_missing_or_forged_ref_fail_closed", async () => {
		// rine-core raises NO_QUOTE for a missing/forged/cross-conversation ref.
		resolvePayeeRequirementMock.mockRejectedValue(
			new X402Error(X402_ERROR.NO_QUOTE, "no payee-issued quote reference"),
		);
		const fetchMock = stubFacilitator();
		const payment = paymentMessage();
		const client = makeClient(payment);

		const result = await client.payments.fulfill(payment, {
			facilitator: FACILITATOR_PRESET.payai,
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.settlement).toBeNull();
		expect(result.verification.invalidReason).toBe("no-quote");
		expect(result.matchedQuote).toBeNull();
		expect(markerStatus(posts[0]?.body)).toBe("payment-failed");
	});

	it("test_fulfill_refuses_cross_quote_underpayment", async () => {
		// The referenced quote wants more than the payer authorized → mismatch.
		resolvePayeeRequirementMock.mockRejectedValue(
			new X402Error(
				X402_ERROR.REQUIREMENT_MISMATCH,
				"payment underpays the referenced quote",
			),
		);
		const fetchMock = stubFacilitator();
		const payment = paymentMessage();
		const client = makeClient(payment);

		const result = await client.payments.fulfill(payment, {
			facilitator: FACILITATOR_PRESET.payai,
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.verification.invalidReason).toBe("requirement-mismatch");
		expect(result.matchedQuote).toBeNull();
		expect(markerStatus(posts[0]?.body)).toBe("payment-failed");
	});

	it("test_fulfill_via_expected_override_settles_without_ref", async () => {
		const fetchMock = stubFacilitator({ isValid: true }, SETTLEMENT);
		const payment = paymentMessage();
		const client = makeClient(payment);

		// The operator override is authoritative — the REAL reconcilePayment runs
		// against it; the ref path (resolvePayeeRequirement) is never consulted.
		const result = await client.payments.fulfill(payment, {
			facilitator: FACILITATOR_PRESET.payai,
			expected: payeeRequirement() as never,
		});

		expect(result.settlement?.success).toBe(true);
		expect(resolvePayeeRequirementMock).not.toHaveBeenCalled();
		// An override carries no quote message id, but does report its terms.
		expect(result.matchedQuote).toEqual({
			quoteMessageId: null,
			amount: "100000",
			asset: EURC_BASE,
			network: "eip155:8453",
		});
		expect(markerStatus(posts[0]?.body)).toBe("payment-completed");
	});

	it("test_fulfill_override_mismatch_refuses_via_real_reconcile", async () => {
		const fetchMock = stubFacilitator();
		// Payer's `accepted` pays a DIFFERENT payTo than the operator's expected
		// terms — the real reconciler refuses before any facilitator call.
		const payment = paymentMessage({
			...payeeRequirement(),
			payTo: "0x000000000000000000000000000000000000BEEF",
		});
		const client = makeClient(payment);

		const result = await client.payments.fulfill(payment, {
			facilitator: FACILITATOR_PRESET.payai,
			expected: payeeRequirement() as never,
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.verification.invalidReason).toBe("requirement-mismatch");
		expect(result.matchedQuote).toBeNull();
		expect(markerStatus(posts[0]?.body)).toBe("payment-failed");
	});

	it("test_fulfill_refuses_malformed_payload_with_typed_failure", async () => {
		const fetchMock = stubFacilitator();
		// A structurally malformed payment (no `authorization`) — F-4.
		const payment = {
			id: randomUUID(),
			conversation_id: randomUUID(),
			type: "rine.v1.x402_payment",
			content_type: "application/json",
			plaintext: { x402Version: 2, payload: {} },
			metadata: {},
			decrypt_error: null,
		} as unknown as import("../types.js").DecryptedMessage;
		const client = makeClient(payment);

		const result = await client.payments.fulfill(payment, {
			facilitator: FACILITATOR_PRESET.payai,
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.settlement).toBeNull();
		expect(result.verification.invalidReason).toBe("malformed-payload");
		expect(result.matchedQuote).toBeNull();
		expect(markerStatus(posts[0]?.body)).toBe("payment-failed");
	});

	it("test_verify_without_expected_fails_closed", async () => {
		const fetchMock = stubFacilitator();
		const client = makeClient(quoteMessage());

		await expect(
			client.payments.verify(paymentMessage(), {
				facilitator: FACILITATOR_PRESET.payai,
			}),
		).rejects.toMatchObject({ name: "X402Error", code: "no-quote" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("test_awaitReceipt_returns_the_matching_in_thread_receipt", async () => {
		const client = makeClient(quoteMessage());
		const convId = randomUUID();
		const receipt = {
			id: randomUUID(),
			conversation_id: convId,
			type: "rine.v1.x402_receipt",
			plaintext: { success: true, transaction: "0xabc" },
			decrypt_error: null,
		};
		// biome-ignore lint/suspicious/noExplicitAny: stub the SSE-backed iterator
		(client as any).messages = () =>
			(async function* () {
				yield { ...receipt, conversation_id: randomUUID() }; // other thread
				yield receipt; // ours
			})();

		const got = await client.payments.awaitReceipt(convId, { timeout: 1000 });
		expect(got?.conversation_id).toBe(convId);
	});

	it("test_awaitReceipt_returns_null_when_no_receipt_arrives", async () => {
		const client = makeClient(quoteMessage());
		// biome-ignore lint/suspicious/noExplicitAny: stub the SSE-backed iterator
		(client as any).messages = () => (async function* () {})();
		const got = await client.payments.awaitReceipt(randomUUID(), {
			timeout: 50,
		});
		expect(got).toBeNull();
	});
});
