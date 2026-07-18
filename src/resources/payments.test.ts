/**
 * REQ-M04 (TS SDK slice) — x402 payer + payee helpers.
 *
 * The rine-core bridge's NETWORK-touching functions are mocked so no real HTTP
 * or peer keys are needed; the x402 wallet/policy/build primitives stay REAL
 * (a fresh temp configDir carries a real secp256k1 wallet + spend policy), so
 * these tests exercise genuine EIP-3009 signing and genuine policy enforcement.
 * The facilitator is mocked at the global `fetch` layer.
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
const { FACILITATOR_PRESET } = await import("./x402-facilitator.js");

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
	function paymentMessage() {
		return {
			id: randomUUID(),
			conversation_id: randomUUID(),
			from_agent_id: OUR_AGENT_ID,
			to_agent_id: PAYEE_ID,
			type: "rine.v1.x402_payment",
			content_type: "application/json",
			plaintext: {
				x402Version: 2,
				accepted: paymentRequired().accepts[0],
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
				extensions: {},
			},
			metadata: {},
			decrypt_error: null,
		} as unknown as import("../types.js").DecryptedMessage;
	}

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
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ isValid: true, payer: "0x1111" }), {
					status: 200,
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = makeClient(quoteMessage());

		const res = await client.payments.verify(paymentMessage(), {
			facilitator: FACILITATOR_PRESET.payai,
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

	it("test_fulfill_when_valid_settles_and_sends_completed_receipt", async () => {
		const settlement = {
			success: true,
			transaction: "0xabc",
			network: "eip155:8453",
			payer: "0x1111",
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ isValid: true }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(settlement), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		const payment = paymentMessage();
		const client = makeClient(payment);
		const result = await client.payments.fulfill(payment, {
			facilitator: FACILITATOR_PRESET.payai,
		});

		expect(result.settlement?.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// Receipt sent in-thread with the completed marker.
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body.type).toBe("rine.v1.x402_receipt");
		expect(markerStatus(posts[0]?.body)).toBe("payment-completed");
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

	it("test_fulfill_when_invalid_skips_settle_and_sends_failed_receipt", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						isValid: false,
						invalidReason: "insufficient_funds",
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const payment = paymentMessage();
		const client = makeClient(payment);
		const result = await client.payments.fulfill(payment, {
			facilitator: FACILITATOR_PRESET.payai,
		});

		expect(result.settlement).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1); // verify only, no settle
		expect(capturedEncryptPayload).toMatchObject({
			success: false,
			errorReason: "insufficient_funds",
		});
		expect(markerStatus(posts[0]?.body)).toBe("payment-failed");
	});
});
