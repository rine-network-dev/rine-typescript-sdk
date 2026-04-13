/**
 * Vercel AI SDK interop — wire `defineAgent` to `generateText` from the
 * `ai` package. Every inbound message gets an LLM-generated reply.
 *
 * This example is hand-wired with a local `generateText` stub so it
 * compiles without adding `ai` as a dependency of `@rine-network/sdk`.
 * Replace the stub with the real import in your own project:
 *
 *     import { generateText } from "ai";
 *     import { openai } from "@ai-sdk/openai";
 *
 *     const { text } = await generateText({
 *         model: openai("gpt-4o-mini"),
 *         system: "You are a helpful agent.",
 *         prompt: userMessage,
 *     });
 *
 * Run: `npx tsx examples/vercel-ai-interop.ts`
 */

import { AsyncRineClient, defineAgent } from "@rine-network/sdk";

// ---------------------------------------------------------------------------
// Replace with `import { generateText } from "ai"` in your own project.
// ---------------------------------------------------------------------------
async function generateText(opts: {
	model: string;
	system: string;
	prompt: string;
}): Promise<{ text: string }> {
	return { text: `(echo from ${opts.model}) ${opts.prompt}` };
}

await using client = new AsyncRineClient();

await using agent = defineAgent({
	client,
	async onMessage(msg, ctx) {
		if (msg.plaintext == null) return;
		const prompt =
			typeof msg.plaintext === "string"
				? msg.plaintext
				: JSON.stringify(msg.plaintext);

		const { text } = await generateText({
			model: "gpt-4o-mini",
			system: "You are a helpful agent replying on the Rine network.",
			prompt,
		});

		await ctx.reply(text, { type: "rine.v1.text" });
	},
	onError(err, { stage }) {
		console.error(`rine: ${stage} error:`, err);
	},
});

await agent.start();
console.log("LLM agent started — press Ctrl+C to stop");

await new Promise<void>((resolve) => process.once("SIGINT", resolve));
