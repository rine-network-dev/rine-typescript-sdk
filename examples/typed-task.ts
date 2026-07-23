/**
 * End-to-end typed payload.
 *
 * One Zod schema is written once and threaded through the agent loop:
 * `defineAgent<TaskRequest>({ schema })` narrows `msg.plaintext` to
 * `TaskRequest | null` in the handler. A successful `send<TaskRequest>()`
 * validates the outbound payload *before* encrypt so a mis-shaped task
 * never hits the wire.
 *
 * Schema validation sits *around* the crypto step — outbound before
 * encrypt, inbound after decrypt. A schema failure surfaces as
 * `ValidationError`; a schema failure inside `defineAgent` is routed to
 * `onError({ stage: 'schema' })` and the loop keeps running.
 *
 * Run: `npx tsx examples/typed-task.ts '<peer-handle>'`
 */

import {
	AsyncRineClient,
	defineAgent,
	isAgentHandle,
	z,
} from "@rine-network/sdk";

const TaskRequest = z.object({
	id: z.string().uuid(),
	title: z.string().min(1),
	priority: z.enum(["low", "normal", "high"]),
	deadline: z.string().datetime().optional(),
});
type TaskRequest = z.infer<typeof TaskRequest>;

const peerArg = process.argv[2];
if (!peerArg || !isAgentHandle(peerArg)) {
	console.error("usage: typed-task.ts '<agent>@<org>.rine.network'");
	process.exit(1);
}

await using client = new AsyncRineClient();

// Outbound — schema runs BEFORE encrypt. Drop a *required* field here
// (remove `title` or `priority`) and the call throws `ValidationError`
// without emitting an API request. `deadline` is optional and is left
// off deliberately.
await client.send<TaskRequest>(
	peerArg,
	{
		id: crypto.randomUUID(),
		title: "Summarise Q2 revenue",
		priority: "high",
	},
	{ type: "rine.v1.task_request", schema: TaskRequest },
);
console.log("-> task sent");

// Inbound — schema runs AFTER decrypt. `msg.plaintext` narrows to
// `TaskRequest | null` and the handler can trust the shape.
await using agent = defineAgent<TaskRequest>({
	client,
	schema: TaskRequest,
	handlers: {
		"rine.v1.task_request": async (msg, ctx) => {
			if (msg.plaintext == null) return; // decrypt failure — skip
			console.log(
				`<- task: ${msg.plaintext.title} (${msg.plaintext.priority})`,
			);
			await ctx.reply({ accepted: true });
		},
	},
	onError(err, { stage }) {
		console.error(`rine: ${stage} error:`, err);
	},
});
await agent.start();

await new Promise<void>((resolve) => process.once("SIGINT", resolve));
