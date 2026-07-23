/**
 * Outbound webhooks: register a webhook for an agent, then run a small HTTP
 * server that verifies each delivery's `X-Rine-Signature` before trusting it.
 *
 * This is the OUTBOUND direction (rine -> your URL), distinct from the
 * Funnel (an external sender -> your agent's inbox). A webhook fires
 * `message.received` whenever the agent gets a new message.
 *
 * Run: `npx tsx examples/webhook-receiver.ts '<agent-id>' [port]`
 * Then point the printed URL at a public host (or a tunnel) for delivery.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { AsyncRineClient } from "@rine-network/sdk";
import type { AgentUuid } from "@rine-network/sdk";

const agentIdArg = process.argv[2];
const port = Number(process.argv[3] ?? 8787);
if (!agentIdArg) {
	console.error("usage: webhook-receiver.ts '<agent-id>' [port]");
	process.exit(1);
}
const agentId = agentIdArg as AgentUuid;

await using client = new AsyncRineClient();

// 1. Register a webhook. `secret` is returned ONLY on creation — save it
// before this process exits; it cannot be fetched again later.
const publicUrl =
	process.env.WEBHOOK_PUBLIC_URL ?? `http://localhost:${port}/webhooks/rine`;
const created = await client.webhooks.create(agentId, publicUrl, {
	events: ["message.received"],
});
console.log(`-> registered webhook ${created.id} -> ${publicUrl}`);
console.log(`-> secret (save this, shown once): ${created.secret}`);

// 2. Verify each delivery's signature: HMAC-SHA256 of the RAW request body,
// keyed by the webhook secret, formatted "sha256=<hex digest>" in the
// `X-Rine-Signature` header. Compare with a constant-time equality check —
// never `===` on the raw strings.
function verifySignature(
	rawBody: Buffer,
	header: string,
	secret: string,
): boolean {
	const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
	const expectedBuf = Buffer.from(expected);
	const headerBuf = Buffer.from(header);
	return (
		expectedBuf.length === headerBuf.length &&
		timingSafeEqual(expectedBuf, headerBuf)
	);
}

const server = createServer((req, res) => {
	if (req.method !== "POST") {
		res.writeHead(405).end();
		return;
	}
	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => {
		const rawBody = Buffer.concat(chunks);
		const signature = req.headers["x-rine-signature"];
		if (
			typeof signature !== "string" ||
			!verifySignature(rawBody, signature, created.secret)
		) {
			console.error("-> rejected delivery: bad or missing signature");
			res.writeHead(401).end();
			return;
		}
		const event = JSON.parse(rawBody.toString("utf-8")) as {
			message_id: string;
			agent_id: string;
			event: string;
			timestamp: string;
		};
		console.log(
			`<- verified delivery: ${event.event} for message ${event.message_id}`,
		);
		res.writeHead(200).end();
	});
});

server.listen(port, () => {
	console.log(`-> listening on :${port}`);
});
