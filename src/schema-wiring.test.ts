/**
 * Regression tests for Step 19 — Standard Schema v1 wiring across the SDK.
 *
 * Covers the four public API slots that consume a user-supplied schema:
 *
 *   1. `client.send<T>` / `client.reply<T>`  — outbound, runs *before* encrypt
 *   2. `client.read<T>`                      — inbound, runs *after* decrypt
 *   3. `client.messages<T>`                  — inbound, per yielded message
 *   4. `client.sendAndWait<Req, Rep>`        — outbound + reply narrowing
 *
 * Plus the agentic layer:
 *
 *   5. `defineAgent<T>({ schema })`                           — per-message
 *   6. `ConversationScope.{send,messages,history}<T>`         — same plumbing
 *
 * All tests use hand-rolled Standard Schema v1 objects so the test run
 * has no hidden runtime dependency on Zod/Valibot/ArkType. The same
 * `~standard.validate` contract every real validator implements is
 * exercised via a minimal pass-through / rejecting factory.
 *
 * Mocking strategy: construct a real `AsyncRineClient` (network-free
 * constructor) and stub the transport/decrypt boundary only. Each test
 * asserts on (a) the schema hook firing at the right moment, (b) the
 * right-shaped value flowing through, and (c) failures routing through
 * the documented path (throw vs. onError vs. skip).
 */

import { randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is auto-hoisted by Vitest above regular imports so the mock is
// in place by the time `./client.js` (SUT) loads — this is the same pattern
// `messages.test.ts` uses. `vi.doMock` after the SUT is already imported is
// a structural no-op in Vitest's ESM mode; tests that need the mock to bite
// must use top-level `vi.mock` instead.
vi.mock("./resources/decrypt.js", () => ({
	decryptEnvelope: vi.fn(
		async (opts: {
			// biome-ignore lint/suspicious/noExplicitAny: test shim
			msg: any;
		}) => {
			// Preserve any pre-baked plaintext on the envelope; tests that want
			// to assert on the post-decrypt plaintext set it on the stubbed
			// stream payload directly.
			const plaintext = opts.msg.plaintext ?? "__no_plaintext__";
			return {
				...opts.msg,
				metadata: opts.msg.metadata ?? {},
				plaintext,
				verified: true,
				verification_status: "verified" as const,
				decrypt_error: null,
			};
		},
	),
}));

import { defineAgent } from "./agent.js";
import {
	AsyncRineClient,
	type ReplyOptions,
	type SendOptions,
} from "./client.js";
import { SchemaValidationError } from "./errors.js";
import type { AgentHandle, DecryptedMessage, MessageUuid } from "./types.js";
import { CursorPage } from "./utils/cursor-page.js";

// ---------------------------------------------------------------------------
// Minimal Standard Schema v1 factories
// ---------------------------------------------------------------------------

interface Task {
	query: string;
	maxResults: number;
}

function passThroughSchema<T>(): StandardSchemaV1<unknown, T> {
	return {
		"~standard": {
			version: 1,
			vendor: "rine-test",
			validate: (value) => ({ value: value as T }),
		},
	};
}

function rejectingSchema(
	message = "bad shape",
): StandardSchemaV1<unknown, Task> {
	return {
		"~standard": {
			version: 1,
			vendor: "rine-test",
			validate: () => ({ issues: [{ message, path: ["query"] }] }),
		},
	};
}

function taskSchemaWithGuard(): StandardSchemaV1<unknown, Task> {
	return {
		"~standard": {
			version: 1,
			vendor: "rine-test",
			validate: (value) => {
				if (
					typeof value === "object" &&
					value !== null &&
					typeof (value as Task).query === "string" &&
					typeof (value as Task).maxResults === "number"
				) {
					return { value: value as Task };
				}
				return {
					issues: [{ message: "not a Task", path: [] }],
				};
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDecrypted(
	over: Partial<DecryptedMessage> & { plaintext?: unknown },
): DecryptedMessage {
	return {
		id: randomUUID(),
		conversation_id: randomUUID(),
		from_agent_id: randomUUID(),
		to_agent_id: randomUUID(),
		type: "rine.v1.task_request",
		encrypted_payload: "ciphertext",
		encryption_version: "hpke-v1",
		metadata: {},
		created_at: "2026-04-11T00:00:00.000Z",
		verified: true,
		verification_status: "verified",
		decrypt_error: null,
		...over,
	} as DecryptedMessage;
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// send<T> — outbound schema validates before encrypt
// ---------------------------------------------------------------------------

describe("client.send<T>({ schema })", () => {
	it("runs the schema validator before the transport send", async () => {
		const client = new AsyncRineClient({});
		let validatorCalled = false;
		const schema: StandardSchemaV1<unknown, Task> = {
			"~standard": {
				version: 1,
				vendor: "rine-test",
				validate: (value) => {
					validatorCalled = true;
					return { value: value as Task };
				},
			},
		};

		// Stub the private resource send path — we're testing the client-layer
		// schema wiring, not HTTP.
		const transportSpy = vi
			// biome-ignore lint/suspicious/noExplicitAny: test reaches into private resource
			.spyOn((client as any).messagingResource, "send")
			.mockResolvedValue({ id: "m1" } as never);

		await client.send<Task>(
			"bot@acme.rine.network" as AgentHandle,
			{ query: "weather", maxResults: 5 },
			{ schema },
		);

		expect(validatorCalled).toBe(true);
		expect(transportSpy).toHaveBeenCalledTimes(1);
		// Schema is stripped before the resource is called; validated payload
		// flows through untouched.
		const [, payload, resourceOpts] = transportSpy.mock.calls[0] as [
			unknown,
			Task,
			SendOptions<Task>,
		];
		expect(payload).toEqual({ query: "weather", maxResults: 5 });
		expect(resourceOpts.schema).toBeUndefined();
	});

	it("rejects with SchemaValidationError and never calls the transport on a bad payload", async () => {
		const client = new AsyncRineClient({});
		const transportSpy = vi
			// biome-ignore lint/suspicious/noExplicitAny: test reaches into private resource
			.spyOn((client as any).messagingResource, "send")
			.mockResolvedValue({ id: "m1" } as never);

		await expect(
			client.send<Task>(
				"bot@acme.rine.network" as AgentHandle,
				{ query: 42, maxResults: "nope" } as unknown as Task,
				{ schema: rejectingSchema("bad query") },
			),
		).rejects.toBeInstanceOf(SchemaValidationError);
		// Validation runs at the client layer *before* the resource is
		// called — the transport must not be invoked.
		expect(transportSpy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// reply<T> — outbound schema validates before encrypt
// ---------------------------------------------------------------------------

describe("client.reply<T>({ schema })", () => {
	it("validates at the client layer and strips the schema before calling the resource", async () => {
		const client = new AsyncRineClient({});
		let validatorCalls = 0;
		const schema: StandardSchemaV1<unknown, Task> = {
			"~standard": {
				version: 1,
				vendor: "rine-test",
				validate: (value) => {
					validatorCalls += 1;
					return { value: value as Task };
				},
			},
		};
		const replySpy = vi
			// biome-ignore lint/suspicious/noExplicitAny: test reaches into private resource
			.spyOn((client as any).messagingResource, "reply")
			.mockResolvedValue({ id: "m2" } as never);

		await client.reply<Task>(
			"00000000-0000-0000-0000-000000000001" as MessageUuid,
			{ query: "ack", maxResults: 1 },
			{ schema },
		);

		expect(validatorCalls).toBe(1);
		expect(replySpy).toHaveBeenCalledTimes(1);
		const [, payload, opts] = replySpy.mock.calls[0] as [
			unknown,
			Task,
			ReplyOptions<Task>,
		];
		// Validated payload is passed through; schema itself is stripped.
		expect(payload).toEqual({ query: "ack", maxResults: 1 });
		expect(opts.schema).toBeUndefined();
	});

	it("rejects with SchemaValidationError and never calls the resource on a bad payload", async () => {
		const client = new AsyncRineClient({});
		const replySpy = vi
			// biome-ignore lint/suspicious/noExplicitAny: test reaches into private resource
			.spyOn((client as any).messagingResource, "reply")
			.mockResolvedValue({ id: "m2" } as never);

		await expect(
			client.reply<Task>(
				"00000000-0000-0000-0000-000000000001" as MessageUuid,
				{ wrong: "shape" } as unknown as Task,
				{ schema: taskSchemaWithGuard() },
			),
		).rejects.toBeInstanceOf(SchemaValidationError);
		expect(replySpy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// read<T> — inbound schema narrows plaintext after decrypt
// ---------------------------------------------------------------------------

describe("client.read<T>({ schema })", () => {
	it("strips the schema before calling the resource and narrows plaintext at the client layer", async () => {
		const client = new AsyncRineClient({});
		// Resource returns a JSON-string plaintext, the client-layer
		// parseMessagePlaintext JSON.parses and validates.
		const readSpy = vi
			// biome-ignore lint/suspicious/noExplicitAny: test reaches into private resource
			.spyOn((client as any).messagingResource, "read")
			.mockResolvedValue(
				makeDecrypted({
					plaintext: JSON.stringify({ query: "ok", maxResults: 1 }),
				}) as never,
			);

		const schema = taskSchemaWithGuard();
		const msg = await client.read<Task>(
			"00000000-0000-0000-0000-000000000001" as MessageUuid,
			{ schema },
		);

		expect(readSpy).toHaveBeenCalledTimes(1);
		const [, opts] = readSpy.mock.calls[0] as [unknown, { schema?: unknown }];
		// Schema is stripped before the resource is called — responsibility
		// split is "client validates, resource transports".
		expect(opts?.schema).toBeUndefined();
		expect(msg.plaintext).toEqual({ query: "ok", maxResults: 1 });
	});

	it("throws SchemaValidationError on a schema-incompatible plaintext", async () => {
		const client = new AsyncRineClient({});
		vi
			// biome-ignore lint/suspicious/noExplicitAny: test reaches into private resource
			.spyOn((client as any).messagingResource, "read")
			.mockResolvedValue(
				makeDecrypted({
					plaintext: JSON.stringify({ wrong: "shape" }),
				}) as never,
			);

		await expect(
			client.read<Task>("00000000-0000-0000-0000-000000000001" as MessageUuid, {
				schema: taskSchemaWithGuard(),
			}),
		).rejects.toBeInstanceOf(SchemaValidationError);
	});

	it("leaves decrypt-failed envelopes untouched", async () => {
		const client = new AsyncRineClient({});
		vi
			// biome-ignore lint/suspicious/noExplicitAny: test reaches into private resource
			.spyOn((client as any).messagingResource, "read")
			.mockResolvedValue(
				makeDecrypted({
					plaintext: null,
					decrypt_error: "HPKE decrypt failed",
				}) as never,
			);

		const msg = await client.read<Task>(
			"00000000-0000-0000-0000-000000000001" as MessageUuid,
			{ schema: taskSchemaWithGuard() },
		);
		expect(msg.decrypt_error).toBe("HPKE decrypt failed");
		expect(msg.plaintext).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// messages<T> — inbound schema per yielded message
// ---------------------------------------------------------------------------

describe("client.messages<T>({ schema })", () => {
	/**
	 * Build a client whose SSE source emits one event per message with a
	 * pre-serialised envelope. The top-level `vi.mock` for
	 * `./resources/decrypt.js` preserves `msg.plaintext` on the envelope, so
	 * whatever JSON-string this helper bakes into each `data` field lands on
	 * the other side of `decryptEnvelope` unchanged — ready for the
	 * `messagesGenerator` schema hook to parse + validate.
	 */
	function makeStreamingClient(
		messagesPayload: Array<{ id: string; type: string; plaintext: string }>,
	): AsyncRineClient {
		const client = new AsyncRineClient({});

		// biome-ignore lint/suspicious/noExplicitAny: test override
		(client.streams as any).stream = () => {
			return (async function* () {
				for (const m of messagesPayload) {
					const envelope = {
						id: m.id,
						conversation_id: randomUUID(),
						from_agent_id: randomUUID(),
						to_agent_id: randomUUID(),
						type: m.type,
						encrypted_payload: "ciphertext",
						encryption_version: "hpke-v1",
						metadata: {},
						created_at: "2026-04-11T00:00:00.000Z",
						plaintext: m.plaintext,
						verified: true,
						verification_status: "verified",
						decrypt_error: null,
					};
					yield {
						type: "message",
						data: JSON.stringify(envelope),
						id: m.id,
					};
				}
			})();
		};

		// biome-ignore lint/suspicious/noExplicitAny: test override
		(client as any).messagingResource.resolveSenderId = vi
			.fn()
			.mockResolvedValue("agent-id");
		// biome-ignore lint/suspicious/noExplicitAny: test override
		(client as any).http.getCoreHttpClient = () => ({});
		return client;
	}

	it("narrows plaintext on every yielded message", async () => {
		const plaintextValue = { query: "paris", maxResults: 3 };
		const client = makeStreamingClient([
			{
				id: randomUUID(),
				type: "rine.v1.task_request",
				plaintext: JSON.stringify(plaintextValue),
			},
		]);

		const out: DecryptedMessage<Task>[] = [];
		for await (const msg of client.messages<Task>({
			schema: taskSchemaWithGuard(),
		})) {
			out.push(msg);
		}

		expect(out).toHaveLength(1);
		expect(out[0]?.type).toBe("rine.v1.task_request");
		// Schema ran + narrowed: plaintext is the parsed object, not the
		// JSON string that flowed through `decryptEnvelope`.
		expect(out[0]?.plaintext).toEqual(plaintextValue);
	});

	it("throws SchemaValidationError mid-iteration when the schema rejects a yielded message", async () => {
		const client = makeStreamingClient([
			{
				id: randomUUID(),
				type: "rine.v1.task_request",
				plaintext: JSON.stringify({ not: "a task" }),
			},
		]);

		const iter = client.messages<Task>({ schema: taskSchemaWithGuard() });
		const consume = async () => {
			const collected: DecryptedMessage<Task>[] = [];
			for await (const msg of iter) collected.push(msg);
			return collected;
		};
		await expect(consume()).rejects.toBeInstanceOf(SchemaValidationError);
	});
});

// ---------------------------------------------------------------------------
// sendAndWait<Req, Rep> — outbound + replySchema
// ---------------------------------------------------------------------------

describe("client.sendAndWait<Req, Rep>({ schema, replySchema })", () => {
	it("validates the request at the client layer, strips both schemas from the resource call, and narrows the reply", async () => {
		const client = new AsyncRineClient({});
		const reply = makeDecrypted({
			plaintext: JSON.stringify({ query: "reply", maxResults: 2 }),
		});
		const swSpy = vi
			// biome-ignore lint/suspicious/noExplicitAny: test reaches into private resource
			.spyOn((client as any).messagingResource, "sendAndWait")
			.mockResolvedValue({
				sent: { id: "m1" },
				reply,
			} as never);

		const schema = taskSchemaWithGuard();
		const replySchema = taskSchemaWithGuard();

		const result = await client.sendAndWait<Task, Task>(
			"bot@acme.rine.network" as AgentHandle,
			{ query: "hi", maxResults: 1 },
			{ schema, replySchema },
		);

		expect(swSpy).toHaveBeenCalledTimes(1);
		const [, , opts] = swSpy.mock.calls[0] as [
			unknown,
			unknown,
			{ schema?: unknown; replySchema?: unknown },
		];
		// Both schemas are stripped — responsibility split is "client
		// validates, resource transports".
		expect(opts.schema).toBeUndefined();
		expect(opts.replySchema).toBeUndefined();
		// Reply plaintext is narrowed at the client layer.
		expect(result.reply?.plaintext).toEqual({ query: "reply", maxResults: 2 });
	});

	it("rejects with SchemaValidationError on a bad request payload and never calls the resource", async () => {
		const client = new AsyncRineClient({});
		const swSpy = vi
			// biome-ignore lint/suspicious/noExplicitAny: test reaches into private resource
			.spyOn((client as any).messagingResource, "sendAndWait")
			.mockResolvedValue({ sent: { id: "m1" }, reply: null } as never);

		await expect(
			client.sendAndWait<Task, Task>(
				"bot@acme.rine.network" as AgentHandle,
				{ not: "a task" } as unknown as Task,
				{ schema: taskSchemaWithGuard() },
			),
		).rejects.toBeInstanceOf(SchemaValidationError);
		expect(swSpy).not.toHaveBeenCalled();
	});

	it("returns { reply: null } untouched on long-poll timeout even when replySchema is supplied", async () => {
		const client = new AsyncRineClient({});
		vi
			// biome-ignore lint/suspicious/noExplicitAny: test reaches into private resource
			.spyOn((client as any).messagingResource, "sendAndWait")
			.mockResolvedValue({ sent: { id: "m1" }, reply: null } as never);

		// replySchema is a rejecting schema — it should NOT fire because the
		// reply is null (long-poll timeout path). If the bypass were broken,
		// the generator would throw ValidationError instead of returning the
		// null-reply result.
		const result = await client.sendAndWait<Task, Task>(
			"bot@acme.rine.network" as AgentHandle,
			{ query: "ok", maxResults: 1 },
			{ replySchema: rejectingSchema("should-not-fire") },
		);
		expect(result.sent).toEqual({ id: "m1" });
		expect(result.reply).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// ConversationScope — send + history schema wiring
// ---------------------------------------------------------------------------

describe("ConversationScope<T>({ schema })", () => {
	it("conversation(msg).send<T> forwards the schema down to client.reply", async () => {
		const client = new AsyncRineClient({});
		const replySpy = vi
			.spyOn(client, "reply")
			.mockResolvedValue({ id: "m1" } as never);

		const msg = makeDecrypted({
			conversation_id: "conv-xyz",
			sender_handle: "bot@acme.rine.network",
		});
		const conv = client.conversation(msg);
		const schema = passThroughSchema<Task>();
		await conv.send<Task>(
			{ query: "ok", maxResults: 2 },
			{ schema },
		);

		expect(replySpy).toHaveBeenCalledTimes(1);
		const [, , opts] = replySpy.mock.calls[0] as [
			unknown,
			unknown,
			ReplyOptions<Task>,
		];
		expect(opts.schema).toBe(schema);
	});

	it("conversation(id).history<T> applies the schema to matching messages", async () => {
		const client = new AsyncRineClient({});
		const convId = "conv-xyz";
		const matching = makeDecrypted({
			conversation_id: convId,
			plaintext: JSON.stringify({ query: "match", maxResults: 9 }),
		});
		const nonMatching = makeDecrypted({
			conversation_id: "other",
			plaintext: JSON.stringify({ query: "miss", maxResults: 0 }),
		});
		vi.spyOn(client, "inbox").mockResolvedValue(
			new CursorPage<DecryptedMessage>([matching, nonMatching], 2, null, null),
		);

		const conv = client.conversation(convId);
		const out: DecryptedMessage<Task>[] = [];
		for await (const msg of conv.history<Task>({
			schema: taskSchemaWithGuard(),
		})) {
			out.push(msg);
		}

		expect(out).toHaveLength(1);
		expect(out[0]?.plaintext).toEqual({ query: "match", maxResults: 9 });
	});

	it("conversation(id).history<T> throws SchemaValidationError on a bad match", async () => {
		const client = new AsyncRineClient({});
		const convId = "conv-xyz";
		const bad = makeDecrypted({
			conversation_id: convId,
			plaintext: JSON.stringify({ wrong: "shape" }),
		});
		vi.spyOn(client, "inbox").mockResolvedValue(
			new CursorPage<DecryptedMessage>([bad], 1, null, null),
		);

		const conv = client.conversation(convId);
		const iter = conv.history<Task>({ schema: taskSchemaWithGuard() });

		await expect(async () => {
			for await (const _ of iter) {
				/* consume */
			}
		}).rejects.toBeInstanceOf(SchemaValidationError);
	});

	it("conversation(id).history<T> leaves decrypt-failed envelopes untouched", async () => {
		const client = new AsyncRineClient({});
		const convId = "conv-xyz";
		const failed = makeDecrypted({
			conversation_id: convId,
			plaintext: null,
			decrypt_error: "HPKE decrypt failed",
		});
		vi.spyOn(client, "inbox").mockResolvedValue(
			new CursorPage<DecryptedMessage>([failed], 1, null, null),
		);

		const conv = client.conversation(convId);
		const out: DecryptedMessage<Task>[] = [];
		for await (const msg of conv.history<Task>({
			schema: taskSchemaWithGuard(),
		})) {
			out.push(msg);
		}
		expect(out).toHaveLength(1);
		expect(out[0]?.decrypt_error).toBe("HPKE decrypt failed");
		expect(out[0]?.plaintext).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// defineAgent<T>({ schema }) — per-message, routes to onError stage='schema'
// ---------------------------------------------------------------------------

describe("defineAgent<T>({ schema })", () => {
	it("narrows msg.plaintext for the handler on a successful validation", async () => {
		const client = new AsyncRineClient({});
		const plaintextValue = { query: "typed", maxResults: 7 };
		const good = makeDecrypted({
			plaintext: JSON.stringify(plaintextValue),
		});

		// Stub client.messages to yield our pre-cooked envelope.
		vi.spyOn(client, "messages").mockImplementation(() =>
			(async function* () {
				yield good;
			})(),
		);

		let captured: unknown = null;
		let handlerResolve!: () => void;
		const handled = new Promise<void>((resolve) => {
			handlerResolve = resolve;
		});
		const agent = defineAgent<Task>({
			client,
			schema: taskSchemaWithGuard(),
			onMessage: (msg) => {
				captured = msg.plaintext;
				handlerResolve();
			},
		});
		await agent.start();
		await handled;
		await agent.stop();

		expect(captured).toEqual(plaintextValue);
	});

	it("routes schema failures to onError({ stage: 'schema' }) and skips the handler", async () => {
		const client = new AsyncRineClient({});
		const bad = makeDecrypted({
			plaintext: JSON.stringify({ not: "a task" }),
		});

		vi.spyOn(client, "messages").mockImplementation(() =>
			(async function* () {
				yield bad;
			})(),
		);

		const handlerCalls: number[] = [];
		const errorCalls: Array<{ stage: string; err: unknown }> = [];
		let errorResolve!: () => void;
		const done = new Promise<void>((resolve) => {
			errorResolve = resolve;
		});

		const agent = defineAgent<Task>({
			client,
			schema: taskSchemaWithGuard(),
			onMessage: () => {
				handlerCalls.push(1);
			},
			onError: (err, ctx) => {
				errorCalls.push({ stage: ctx.stage, err });
				errorResolve();
			},
		});
		await agent.start();
		await done;
		await agent.stop();

		expect(handlerCalls).toEqual([]);
		expect(errorCalls).toHaveLength(1);
		expect(errorCalls[0]?.stage).toBe("schema");
		expect(errorCalls[0]?.err).toBeInstanceOf(SchemaValidationError);
	});

	it("bypasses the schema for decrypt-failed envelopes — handler still runs", async () => {
		const client = new AsyncRineClient({});
		const failed = makeDecrypted({
			plaintext: null,
			decrypt_error: "HPKE decrypt failed",
		});

		vi.spyOn(client, "messages").mockImplementation(() =>
			(async function* () {
				yield failed;
			})(),
		);

		const captured: { value: DecryptedMessage<Task> | null } = { value: null };
		let handlerResolve!: () => void;
		const handled = new Promise<void>((resolve) => {
			handlerResolve = resolve;
		});

		const agent = defineAgent<Task>({
			client,
			schema: taskSchemaWithGuard(),
			onMessage: (msg) => {
				captured.value = msg;
				handlerResolve();
			},
			onError: () => {
				// Should NOT fire — decrypt failures bypass schema routing.
				throw new Error("onError should not fire for decrypt_error paths");
			},
		});
		await agent.start();
		await handled;
		await agent.stop();

		expect(captured.value).not.toBeNull();
		expect(captured.value?.decrypt_error).toBe("HPKE decrypt failed");
	});
});
