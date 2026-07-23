/**
 * x402 payee: quote a price, then settle whatever `rine.v1.x402_payment`
 * arrives against it and send the receipt — both the settle-first
 * (`fulfill`) and settle-after-delivery (`verify` + `settle` + `sendReceipt`)
 * shapes.
 *
 * As the payee you issue the quote, then verify and settle the payment
 * through a facilitator you configure — rine never settles; the facilitator
 * call is plain external HTTP.
 *
 * Run: `npx tsx examples/x402-payee.ts '<pay-to-wallet-address>'`
 */

import type { PaymentRequirements } from "@rine-network/sdk";
import {
	AsyncRineClient,
	FACILITATOR_PRESET,
	X402_MESSAGE_TYPE,
} from "@rine-network/sdk";

const payTo = process.argv[2];
if (!payTo || !payTo.startsWith("0x")) {
	console.error("usage: x402-payee.ts '<0x-payout-wallet-address>'");
	process.exit(1);
}

await using client = new AsyncRineClient();

console.log("-- waiting for a task_request to quote --");
let request = null;
for await (const msg of client.messages({ type: "rine.v1.task_request" })) {
	request = msg;
	break;
}
if (!request) {
	console.error("no task request arrived");
	process.exit(1);
}
console.log(
	`<- ${request.sender_handle}: ${JSON.stringify(request.plaintext)}`,
);

// 1. Quote a price — a reply to the request threads it into the same
// conversation; each entry in `accepts[]` is one rail the payer may choose.
const requirement: PaymentRequirements = {
	scheme: "exact",
	network: "eip155:8453",
	amount: "100000", // 0.10 EURC in atomic units
	asset: "0x60a3E5A08d5C9D26571b3225aca0871e076A9b1",
	payTo,
	maxTimeoutSeconds: 60,
	extra: { name: "EURC", version: "2" },
};
const quote = await client.payments.quote(request, {
	x402Version: 2,
	accepts: [requirement],
	extensions: {},
});
console.log(`-> sent quote ${quote.id}`);

// 2. Wait for the payer's rine.v1.x402_payment in the same conversation.
console.log("-- waiting for the payment --");
let payment = null;
for await (const msg of client.messages({
	type: X402_MESSAGE_TYPE.PAYMENT,
})) {
	if (msg.conversation_id === quote.conversation_id) {
		payment = msg;
		break;
	}
}
if (!payment) {
	console.error("no payment arrived");
	process.exit(1);
}
console.log(`<- received payment ${payment.id}`);

// 3a. Settle-first: bind -> verify -> settle -> send receipt, in one call.
// `fulfill` binds the payment to the ONE quote it references and refuses
// (sending a payment-failed receipt) on a missing/forged reference or terms
// that don't match — it never trusts the payer-echoed `accepted` block.
const outcome = await client.payments.fulfill(payment, {
	facilitator: FACILITATOR_PRESET.payai,
});
console.log(
	`-> settled: ${outcome.settlement?.success ?? false} (receipt ${outcome.receipt.id})`,
);

// 3b. Settle-after-delivery (shown for reference — do not call this on the
// SAME payment `fulfill` already settled above): verify first, deliver the
// work, THEN settle and send the receipt yourself.
//
// const verification = await client.payments.verify(payment, {
//   facilitator: FACILITATOR_PRESET.payai,
//   expected: requirement,
// });
// if (verification.isValid) {
//   // ... deliver the paid-for work here ...
//   const settlement = await client.payments.settle(payment, {
//     facilitator: FACILITATOR_PRESET.payai,
//     expected: requirement,
//   });
//   await client.payments.sendReceipt(payment, settlement);
// }

console.log(`-> done — settled with ${request.sender_handle}`);
