/**
 * x402 HTTP fetch wrapper. A `402` challenge is parsed, policy-checked,
 * signed, and retried with an `X-PAYMENT` header; a policy refusal throws and no
 * retry is made. Wallet + policy are real (temp configDir); the HTTP server is a
 * mocked `fetch`.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWallet, readDailySpent, savePolicy } from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createX402Fetch } from "./x402-fetch.js";

const AGENT_ID = randomUUID();
const EURC_BASE = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42";

const POLICY = {
	perTxCap: "1.00",
	dailyCap: "10.00",
	allowedAssets: ["EURC"],
	allowedNetworks: ["eip155:8453"],
	autoPayThreshold: "1.00",
};

function quoteBody() {
	return {
		x402Version: 2,
		accepts: [
			{
				scheme: "exact",
				network: "eip155:8453",
				amount: "100000",
				asset: EURC_BASE,
				payTo: "0x000000000000000000000000000000000000dEaD",
				maxTimeoutSeconds: 60,
				extra: { name: "EURC", version: "2" },
			},
		],
		extensions: {},
	};
}

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "rine-x402fetch-"));
	createWallet(tmp, AGENT_ID);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("createX402Fetch", () => {
	it("test_fetch_when_402_pays_and_retries_with_x_payment_header", async () => {
		savePolicy(tmp, AGENT_ID, POLICY);
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(quoteBody()), { status: 402 }),
			)
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));

		const x402fetch = createX402Fetch({
			configDir: tmp,
			agentId: AGENT_ID,
			fetchImpl,
		});
		const res = await x402fetch("https://api.example/data");

		expect(res.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const retryInit = fetchImpl.mock.calls[1]?.[1] as RequestInit;
		const header = new Headers(retryInit.headers).get("X-PAYMENT") ?? "";
		expect(header).toBeTruthy();
		const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
		expect(decoded.scheme).toBe("exact");
		expect(decoded.network).toBe("eip155:8453");
		expect(decoded.payload.signature).toMatch(/^0x[0-9a-f]{130}$/i);
		// Spend reserved under the lock once the settleable authorization is sent.
		expect(readDailySpent(tmp, AGENT_ID)).toBe(100000n);
	});

	it("test_fetch_when_paid_retry_returns_non_2xx_still_debits_daily_spend", async () => {
		// A malicious/faulty server can settle the X-PAYMENT authorization while
		// returning a non-2xx. The daily cap must still account for it, else the
		// server could drain past the cap by always replying non-2xx.
		savePolicy(tmp, AGENT_ID, POLICY);
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(quoteBody()), { status: 402 }),
			)
			.mockResolvedValueOnce(new Response("boom", { status: 500 }));

		const x402fetch = createX402Fetch({
			configDir: tmp,
			agentId: AGENT_ID,
			fetchImpl,
		});
		const res = await x402fetch("https://api.example/data");

		expect(res.status).toBe(500);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(readDailySpent(tmp, AGENT_ID)).toBe(100000n);
	});

	it("test_fetch_when_no_402_returns_response_untouched", async () => {
		const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
		const x402fetch = createX402Fetch({
			configDir: tmp,
			agentId: AGENT_ID,
			fetchImpl,
		});
		const res = await x402fetch("https://api.example/free");
		expect(res.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("test_fetch_when_policy_denies_throws_and_does_not_retry", async () => {
		// No policy → deny-by-default; the 402 is never paid.
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify(quoteBody()), { status: 402 }),
		);
		const x402fetch = createX402Fetch({
			configDir: tmp,
			agentId: AGENT_ID,
			fetchImpl,
		});

		await expect(x402fetch("https://api.example/data")).rejects.toMatchObject({
			name: "X402Error",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(readDailySpent(tmp, AGENT_ID)).toBe(0n);
	});
});
