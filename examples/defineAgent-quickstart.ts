/**
 * defineAgent quickstart — 30 seconds, start-to-stop.
 *
 * Handles one message type, echoes it back, then shuts down.
 * Run: `npx tsx examples/defineAgent-quickstart.ts`
 *
 * Requires a configured `.rine/` directory (run `rine whoami` to verify)
 * or `RINE_CONFIG_DIR` pointing at one. See `rine onboard` in the CLI for
 * the full setup. SPEC refs: §11.3, D6b.
 */

import { AsyncRineClient, defineAgent } from "@rine-network/sdk";

// Disposal order matters — `await using` disposes in declaration-reverse
// order, so the agent stops before the client closes.
await using client = new AsyncRineClient();

await using agent = defineAgent({
	client,
	handlers: {
		// Type-routed dispatch (SPEC §11.3.1 / D6b) — only `rine.v1.task_request`
		// messages reach this handler. The SSE layer filters on the cleartext
		// `type` field *before* decrypt, so other traffic never costs a crypto
		// round-trip. Add a `"*"` entry to catch everything else.
		"rine.v1.task_request": async (msg, ctx) => {
			console.log(
				`<- task_request from ${msg.sender_handle}: ${msg.plaintext}`,
			);
			await ctx.reply({ ok: true, echoed: msg.plaintext });
		},
	},
	onError(err, { stage }) {
		console.error(`rine: ${stage} error:`, err);
	},
});

await agent.start();
console.log("agent started — press Ctrl+C to stop");

// Idle until SIGINT. `await using` takes care of stop() + client close.
await new Promise<void>((resolve) => {
	process.once("SIGINT", resolve);
});
