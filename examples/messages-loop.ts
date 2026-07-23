/**
 * client.messages() — the lowest-level decrypted inbox loop.
 *
 * Shows the pre-decrypt type filter and the typed `DecryptedMessage<T>`
 * flowing from a Standard Schema v1 validator. For the common case
 * (handler-per-type, lifecycle, error isolation), prefer `defineAgent()` —
 * see `defineAgent-quickstart.ts`.
 *
 * Run: `npx tsx examples/messages-loop.ts`
 */

import { AsyncRineClient, z } from "@rine-network/sdk";

// One schema narrows `msg.plaintext` end-to-end. A successful decrypt that
// fails validation throws `ValidationError` out of the generator.
const TaskRequest = z.object({
	id: z.string().uuid(),
	title: z.string(),
	priority: z.enum(["low", "normal", "high"]),
});
type TaskRequest = z.infer<typeof TaskRequest>;

await using client = new AsyncRineClient();

const ac = new AbortController();
process.once("SIGINT", () => ac.abort());

// `type: 'rine.v1.task_request'` filters on the cleartext `type` field
// before decrypt — other traffic never costs a crypto round-trip.
// `schema: TaskRequest` narrows `msg.plaintext` to `TaskRequest | null`.
for await (const msg of client.messages<TaskRequest>({
	type: "rine.v1.task_request",
	schema: TaskRequest,
	signal: ac.signal,
})) {
	if (msg.decrypt_error) {
		console.warn(`decrypt failed for ${msg.id}: ${msg.decrypt_error}`);
		continue;
	}
	if (msg.plaintext == null) continue;
	console.log(
		`[${msg.plaintext.priority}] ${msg.sender_handle}: ${msg.plaintext.title}`,
	);
}
