/**
 * x402 payer: pay a message-attached quote, and — separately — pay a classic
 * HTTP `402` challenge transparently.
 *
 * Two independent patterns in one file, both signing with the SAME wallet key
 * and the SAME spend policy:
 *
 *   A. Message-attached (the rine thread flow) — request work from a peer
 *      agent, pay the `rine.v1.x402_payment_required` quote it replies with
 *      via `client.payments.pay()`, then wait for the in-thread receipt.
 *   B. HTTP resource-gate — wrap `fetch` with `createX402Fetch()` so a plain
 *      HTTP `402 Payment Required` response is paid automatically and the
 *      request retried.
 *
 * Run: `npx tsx examples/x402-payer.ts '<peer-handle>' [http-url]`
 */

import { resolveConfigDir } from "@rine-network/core";
import {
	AsyncRineClient,
	X402_MESSAGE_TYPE,
	createX402Fetch,
	isAgentHandle,
} from "@rine-network/sdk";

const peerArg = process.argv[2];
const httpUrl = process.argv[3];
if (!peerArg || !isAgentHandle(peerArg)) {
	console.error("usage: x402-payer.ts '<agent>@<org>.rine.network' [http-url]");
	process.exit(1);
}

await using client = new AsyncRineClient();

// 0. Wallet + spend policy — required once before any signature can be made.
// `createWallet` refuses to clobber an existing key, so a re-run is safe.
try {
	await client.payments.createWallet();
	console.log("-> created wallet");
} catch {
	console.log("-> wallet already exists");
}
await client.payments.setPolicy({
	perTxCap: "5.00",
	dailyCap: "50.00",
	allowedAssets: ["EURC"],
	allowedNetworks: ["eip155:8453"],
	autoPayThreshold: "1.00",
});
console.log(`-> wallet address ${await client.payments.walletAddress()}`);

// --- A. Message-attached: request work, pay the quote, await the receipt ---

const request = await client.send(
	peerArg,
	{ task: "summarize the attached report" },
	{ type: "rine.v1.task_request" },
);
console.log(`-> sent task request ${request.id}`);

console.log("-- waiting for a payment_required quote in reply --");
let quote = null;
for await (const msg of client.messages({
	type: X402_MESSAGE_TYPE.PAYMENT_REQUIRED,
})) {
	if (msg.conversation_id === request.conversation_id) {
		quote = msg;
		break;
	}
}
if (!quote) {
	console.error("no quote arrived");
	process.exit(1);
}
console.log(`<- received quote ${quote.id}`);

// `pay` throws `X402Error` if the policy refuses every requirement in
// `accepts[]`. `awaitReceipt: true` waits (default 60s) for the payee's
// `rine.v1.x402_receipt` in the same conversation.
const result = await client.payments.pay(quote, { awaitReceipt: true });
console.log(
	`-> paid ${result.payment.id} (${result.requirement.amount ?? result.requirement.maxAmountRequired} ${result.requirement.asset})`,
);
if (result.receipt) {
	console.log(`<- receipt ${result.receipt.id}`);
} else {
	console.log("<- no receipt within the timeout");
}

// --- B. HTTP resource-gate: pay a classic 402 challenge transparently ---

if (httpUrl) {
	const who = await client.whoami();
	const agentId = who.agents[0]?.id;
	if (!agentId) {
		console.error("no agent on this credential set — skipping HTTP demo");
	} else {
		const payFetch = createX402Fetch({
			configDir: resolveConfigDir(),
			agentId,
		});
		const res = await payFetch(httpUrl);
		console.log(`-> GET ${httpUrl} -> ${res.status}`);
		console.log(await res.text());
	}
}
