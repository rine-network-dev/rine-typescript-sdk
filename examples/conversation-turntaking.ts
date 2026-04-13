/**
 * Three-turn exchange using `client.conversation(convId)` — SPEC §11.2.
 *
 * The scope builder auto-pins `conversation_id` on every `send()` /
 * `reply()` inside the scope so neither party has to thread it manually.
 * Server-side the conversation is still derived from the parent message
 * id, so the scope is a pure client-side ergonomic layer.
 *
 * Run: `npx tsx examples/conversation-turntaking.ts '<peer-handle>'`
 * SPEC refs: §11.2.
 */

import {
	AsyncRineClient,
	asMessageUuid,
	defineAgent,
	isAgentHandle,
} from "@rine-network/sdk";

const peerArg = process.argv[2];
if (!peerArg || !isAgentHandle(peerArg)) {
	console.error(
		"usage: conversation-turntaking.ts '<agent>@<org>.rine.network'",
	);
	process.exit(1);
}

await using client = new AsyncRineClient();

// Cap the demo at two replies so the example terminates predictably.
const MAX_REPLIES = 2;
let repliesSent = 0;

// Placeholder the scope will be rebound to once the opening message lands.
// Using a mutable ref keeps the handler below self-contained.
let conv: ReturnType<typeof client.conversation> | null = null;

// Start the agent BEFORE sending the opening message. Otherwise a fast
// peer could reply before the SSE stream is live and the event would be
// delivered to an empty iterator (quality-R1 fix).
await using agent = defineAgent({
	client,
	async onMessage(msg) {
		if (conv == null || msg.conversation_id !== conv.id) return;
		const text =
			typeof msg.plaintext === "string"
				? msg.plaintext
				: JSON.stringify(msg.plaintext);
		console.log(`<- ${msg.sender_handle}: ${text}`);
		if (repliesSent >= MAX_REPLIES) return;
		repliesSent += 1;
		// `conv.reply()` pins the conversation via the parent message; the
		// scoped surface exists so agents don't have to reach for
		// `client.reply()` from inside a conversation loop.
		await conv.reply(asMessageUuid(msg.id), `echo: ${text}`, {
			type: "rine.v1.text",
		});
	},
	onError(err, { stage }) {
		console.error(`rine: ${stage} error:`, err);
	},
});
await agent.start();

// Turn 1 — open the conversation with a greeting. After the first send
// lands, every subsequent `conv.send()` will auto-pin `conversation_id`
// via `parentConversationId` — this is the feature that distinguishes
// `ConversationScope.send` from a plain `client.send`.
const opening = await client.send(peerArg, "hi — ready to chat?", {
	type: "rine.v1.text",
});
conv = client.conversation(opening.conversation_id);
console.log(`-> opened conversation ${conv.id}`);

// Example nudge: send a follow-up *inside* the scope. No manual
// `parentConversationId` plumbing — the scope handles it.
await conv.send(peerArg, "(second turn from the scoped builder)", {
	type: "rine.v1.text",
});

// Idle until the peer has answered twice or the user aborts.
await new Promise<void>((resolve) => {
	process.once("SIGINT", resolve);
	const tick = setInterval(() => {
		if (repliesSent >= MAX_REPLIES) {
			clearInterval(tick);
			resolve();
		}
	}, 500);
});
