/**
 * Regression tests for `defineAgent()`.
 *
 * The test strategy mirrors `messages.test.ts`: construct a real
 * `AsyncRineClient`, stub its `messages()` method with a bounded async
 * iterable, and assert on dispatch / error / lifecycle behaviour.
 *
 * We stub at the `client.messages()` layer (not `streams.stream()`) because
 * `defineAgent` contracts against `messages()`, not the raw SSE primitive.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DefineAgentOptions,
	type RineAgent,
	defineAgent,
} from "./agent.js";
import { AsyncRineClient, type MessagesOptions } from "./client.js";
import type { DecryptedMessage } from "./types.js";

/**
 * Test-only wrapper that pins `autoStart: false`. Every test in this file
 * arranges stream fixtures between `defineAgentT()` and the first pushed
 * message — they must keep the original explicit-`start()` discipline or
 * they race against the loop. A dedicated describe block below covers the
 * auto-start behaviour using the raw `defineAgent`.
 */
function defineAgentT<T = unknown>(opts: DefineAgentOptions<T>): RineAgent {
	return defineAgent<T>({ ...opts, autoStart: false });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecrypted(
	over: Partial<DecryptedMessage> & { type: string },
): DecryptedMessage {
	return {
		id: randomUUID(),
		conversation_id: randomUUID(),
		from_agent_id: randomUUID(),
		to_agent_id: randomUUID(),
		encrypted_payload: "enc",
		encryption_version: "hpke-hybrid-v2",
		metadata: {},
		created_at: "2026-04-11T00:00:00.000Z",
		plaintext: "payload",
		verified: true,
		verification_status: "verified",
		decrypt_error: null,
		...over,
	} as DecryptedMessage;
}

interface StubHandle {
	client: AsyncRineClient;
	messagesCalls: MessagesOptions[];
	/** Manually push a message into a currently-open stream. */
	push: (msg: DecryptedMessage) => void;
	/** Close the currently-open stream (the agent's loop exits). */
	end: () => void;
}

/**
 * Build a client whose `messages()` method returns a controllable async
 * iterable. Tests can push messages, release a deferred open, or close
 * the stream at will.
 */
function makeStubClient(): StubHandle {
	const client = new AsyncRineClient({});
	const messagesCalls: MessagesOptions[] = [];

	let resolveQueue: ((msg: IteratorResult<DecryptedMessage>) => void) | null =
		null;
	const pending: DecryptedMessage[] = [];
	let closed = false;

	const push = (msg: DecryptedMessage) => {
		if (resolveQueue) {
			const r = resolveQueue;
			resolveQueue = null;
			r({ value: msg, done: false });
		} else {
			pending.push(msg);
		}
	};

	const end = () => {
		closed = true;
		if (resolveQueue) {
			const r = resolveQueue;
			resolveQueue = null;
			r({ value: undefined, done: true });
		}
	};

	// biome-ignore lint/suspicious/noExplicitAny: test override of instance method
	(client as any).messages = (opts: MessagesOptions = {}) => {
		messagesCalls.push(opts);

		// Honor the caller-supplied abort signal — the real
		// `client.messages()` passes it down to `streams.stream()`, which
		// tears down the underlying SSE fetch. Simulate that by closing
		// the stub on abort.
		const onAbort = () => {
			closed = true;
			if (resolveQueue) {
				const r = resolveQueue;
				resolveQueue = null;
				r({ value: undefined, done: true });
			}
		};
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		const iter: AsyncIterator<DecryptedMessage> = {
			next() {
				if (pending.length > 0) {
					return Promise.resolve({
						value: pending.shift() as DecryptedMessage,
						done: false,
					});
				}
				if (closed) {
					return Promise.resolve({ value: undefined, done: true });
				}
				return new Promise<IteratorResult<DecryptedMessage>>((resolve) => {
					resolveQueue = resolve;
				});
			},
			return() {
				closed = true;
				if (resolveQueue) {
					const r = resolveQueue;
					resolveQueue = null;
					r({ value: undefined, done: true });
				}
				return Promise.resolve({ value: undefined, done: true });
			},
		};
		return { [Symbol.asyncIterator]: () => iter };
	};

	// Stub `reply` too so the ctx.reply shortcut can be exercised without
	// touching HTTP.
	// biome-ignore lint/suspicious/noExplicitAny: test override
	(client as any).reply = vi.fn().mockResolvedValue({ id: "reply-id" });

	return { client, messagesCalls, push, end };
}

async function tick(ms = 0) {
	await new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("defineAgent()", () => {
	it("dispatches type-routed handlers for matching message types", async () => {
		const { client, push, end } = makeStubClient();
		const taskHandler = vi.fn().mockResolvedValue(undefined);
		const statusHandler = vi.fn().mockResolvedValue(undefined);

		const agent = defineAgentT({
			client,
			handlers: {
				"rine.v1.task_request": taskHandler,
				"rine.v1.status_update": statusHandler,
			},
		});
		await agent.start();

		const m1 = makeDecrypted({ type: "rine.v1.task_request" });
		const m2 = makeDecrypted({ type: "rine.v1.status_update" });
		push(m1);
		push(m2);
		await tick();
		end();
		await agent.stop();

		expect(taskHandler).toHaveBeenCalledTimes(1);
		expect(statusHandler).toHaveBeenCalledTimes(1);
		expect(taskHandler.mock.calls[0]?.[0]).toBe(m1);
	});

	it("drops messages with no matching handler and no '*' catch-all", async () => {
		const { client, push, end } = makeStubClient();
		const taskHandler = vi.fn();

		const agent = defineAgentT({
			client,
			handlers: { "rine.v1.task_request": taskHandler },
		});
		await agent.start();

		push(makeDecrypted({ type: "rine.v1.unknown_type" }));
		await tick();
		end();
		await agent.stop();

		expect(taskHandler).not.toHaveBeenCalled();
	});

	it("routes to '*' catch-all when the specific type handler is absent", async () => {
		const { client, push, end } = makeStubClient();
		const taskHandler = vi.fn();
		const catchAll = vi.fn();

		const agent = defineAgentT({
			client,
			handlers: {
				"rine.v1.task_request": taskHandler,
				"*": catchAll,
			},
		});
		await agent.start();

		push(makeDecrypted({ type: "rine.v1.task_request" }));
		push(makeDecrypted({ type: "rine.v1.status_update" }));
		await tick();
		end();
		await agent.stop();

		expect(taskHandler).toHaveBeenCalledTimes(1);
		expect(catchAll).toHaveBeenCalledTimes(1);
		expect(catchAll.mock.calls[0]?.[0].type).toBe("rine.v1.status_update");
	});

	it("delivers every non-reserved message to the onMessage handler", async () => {
		const { client, push, end } = makeStubClient();
		const onMessage = vi.fn();

		const agent = defineAgentT({ client, onMessage });
		await agent.start();

		push(makeDecrypted({ type: "rine.v1.task_request" }));
		push(makeDecrypted({ type: "a2a.v1.message" }));
		await tick();
		end();
		await agent.stop();

		expect(onMessage).toHaveBeenCalledTimes(2);
	});

	it("applies the pre-decrypt type filter when handlers has no '*'", async () => {
		const { client, messagesCalls, end } = makeStubClient();
		const agent = defineAgentT({
			client,
			handlers: {
				"rine.v1.task_request": vi.fn(),
				"a2a.v1.message": vi.fn(),
			},
		});
		await agent.start();
		end();
		await agent.stop();

		expect(messagesCalls).toHaveLength(1);
		expect(messagesCalls[0]?.type).toEqual([
			"rine.v1.task_request",
			"a2a.v1.message",
		]);
	});

	it("does NOT apply a type filter when a '*' catch-all is present", async () => {
		const { client, messagesCalls, end } = makeStubClient();
		const agent = defineAgentT({
			client,
			handlers: {
				"rine.v1.task_request": vi.fn(),
				"*": vi.fn(),
			},
		});
		await agent.start();
		end();
		await agent.stop();

		expect(messagesCalls[0]?.type).toBeUndefined();
	});

	it("does NOT apply a type filter when onMessage is used", async () => {
		const { client, messagesCalls, end } = makeStubClient();
		const agent = defineAgentT({ client, onMessage: vi.fn() });
		await agent.start();
		end();
		await agent.stop();

		expect(messagesCalls[0]?.type).toBeUndefined();
	});

	it("forwards includeReserved through to client.messages()", async () => {
		const { client, messagesCalls, end } = makeStubClient();
		const agent = defineAgentT({
			client,
			onMessage: vi.fn(),
			includeReserved: true,
		});
		await agent.start();
		end();
		await agent.stop();

		expect(messagesCalls[0]?.includeReserved).toBe(true);
	});

	it("isolates handler throws via onError and keeps processing", async () => {
		const { client, push, end } = makeStubClient();
		const onError = vi.fn();
		const onMessage = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("boom");
			})
			.mockResolvedValue(undefined);

		const agent = defineAgentT({ client, onMessage, onError });
		await agent.start();

		const m1 = makeDecrypted({ type: "rine.v1.task_request" });
		const m2 = makeDecrypted({ type: "rine.v1.task_request" });
		push(m1);
		await tick(10);
		push(m2);
		await tick(10);
		end();
		await agent.stop();

		expect(onMessage).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[1]).toEqual({
			message: m1,
			stage: "handler",
		});
		expect((onError.mock.calls[0]?.[0] as Error).message).toBe("boom");
	});

	it("logs via console.error when onError is not provided and a handler throws", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { client, push, end } = makeStubClient();
		const agent = defineAgentT({
			client,
			onMessage: () => {
				throw new Error("boom");
			},
		});
		await agent.start();
		push(makeDecrypted({ type: "rine.v1.task_request" }));
		await tick(10);
		end();
		await agent.stop();

		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(errSpy.mock.calls[0]?.[0]).toMatch(/handler error/);
		expect(errSpy.mock.calls[0]?.[0]).toMatch(/boom/);
	});

	it("catches a throw inside onError itself and keeps running", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { client, push, end } = makeStubClient();
		const onError = vi.fn().mockImplementation(() => {
			throw new Error("meta-boom");
		});
		const onMessage = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("boom");
			})
			.mockResolvedValue(undefined);

		const agent = defineAgentT({ client, onMessage, onError });
		await agent.start();
		push(makeDecrypted({ type: "rine.v1.task_request" }));
		await tick(10);
		push(makeDecrypted({ type: "rine.v1.task_request" }));
		await tick(10);
		end();
		await agent.stop();

		expect(onMessage).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenCalledTimes(1);
		// console.error fired once for the onError throw.
		expect(
			errSpy.mock.calls.some((c) => /onError itself threw/.test(String(c[0]))),
		).toBe(true);
	});

	it("routes lifecycle errors (client.messages() throw) to onError", async () => {
		const client = new AsyncRineClient({});
		// biome-ignore lint/suspicious/noExplicitAny: test override
		(client as any).messages = () => {
			return {
				[Symbol.asyncIterator]() {
					return {
						next() {
							return Promise.reject(new Error("stream exploded"));
						},
					};
				},
			};
		};
		const onError = vi.fn();
		const agent = defineAgentT({ client, onMessage: vi.fn(), onError });
		await agent.start();
		await tick(10);
		await agent.stop();

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[1]).toEqual({
			message: null,
			stage: "lifecycle",
		});
	});

	it("ctx.reply calls client.reply with the current message id", async () => {
		const { client, push, end } = makeStubClient();
		const agent = defineAgentT({
			client,
			onMessage: async (msg, ctx) => {
				await ctx.reply({ echo: msg.plaintext });
			},
		});
		await agent.start();

		const m1 = makeDecrypted({ type: "rine.v1.task_request" });
		push(m1);
		await tick(10);
		end();
		await agent.stop();

		// biome-ignore lint/suspicious/noExplicitAny: mock inspection
		const replyMock = (client as any).reply as ReturnType<typeof vi.fn>;
		expect(replyMock).toHaveBeenCalledTimes(1);
		expect(replyMock.mock.calls[0]?.[0]).toBe(m1.id);
		expect(replyMock.mock.calls[0]?.[1]).toEqual({ echo: "payload" });
	});

	it("start() is idempotent", async () => {
		const { client, messagesCalls, end } = makeStubClient();
		const agent = defineAgentT({ client, onMessage: vi.fn() });
		await agent.start();
		await agent.start();
		await agent.start();
		end();
		await agent.stop();

		expect(messagesCalls).toHaveLength(1);
		expect(agent.started).toBe(true);
	});

	it("stop() is idempotent and returns the same drain promise", async () => {
		const { client, end } = makeStubClient();
		const agent = defineAgentT({ client, onMessage: vi.fn() });
		await agent.start();
		end();
		const p1 = agent.stop();
		const p2 = agent.stop();
		expect(p1).toBe(p2);
		await p1;
	});

	it("await using calls stop() on scope exit", async () => {
		const { client, end } = makeStubClient();
		let disposed = false;
		{
			const agent = defineAgentT({ client, onMessage: vi.fn() });
			await agent.start();
			end();
			await agent[Symbol.asyncDispose]();
			disposed = true;
		}
		expect(disposed).toBe(true);
	});

	it("aborting the external signal tears down the loop", async () => {
		const { client, messagesCalls } = makeStubClient();
		const ac = new AbortController();
		const agent = defineAgentT({
			client,
			onMessage: vi.fn(),
			signal: ac.signal,
		});
		await agent.start();

		// The composed signal passed into client.messages() should trip
		// when the external signal aborts.
		const composedSignal = messagesCalls[0]?.signal as AbortSignal;
		expect(composedSignal.aborted).toBe(false);
		ac.abort();
		expect(composedSignal.aborted).toBe(true);
		await agent.stop();
	});

	it("does not open a stream when start() is called with an already-aborted signal", async () => {
		const { client, messagesCalls } = makeStubClient();
		const ac = new AbortController();
		ac.abort();
		const agent = defineAgentT({
			client,
			onMessage: vi.fn(),
			signal: ac.signal,
		});
		await agent.start();
		await agent.stop();

		expect(messagesCalls).toHaveLength(0);
	});

	it("throws at construction time when pollInterval is set (deferred)", () => {
		const { client } = makeStubClient();
		expect(() =>
			defineAgentT({ client, onMessage: vi.fn(), pollInterval: 5_000 }),
		).toThrow(/pollInterval/);
	});

	it("drains in-flight handlers before stop() resolves", async () => {
		const { client, push, end } = makeStubClient();
		let handlerResolved = false;
		let releaseHandler: () => void = () => {};
		const onMessage = vi.fn().mockImplementation(
			() =>
				new Promise<void>((r) => {
					releaseHandler = () => {
						handlerResolved = true;
						r();
					};
				}),
		);

		const agent = defineAgentT({ client, onMessage });
		await agent.start();
		push(makeDecrypted({ type: "rine.v1.task_request" }));
		await tick(10);
		end();

		const stopPromise = agent.stop();
		// stop() cannot have resolved yet — handler still in-flight.
		await tick(10);
		expect(handlerResolved).toBe(false);
		releaseHandler();
		await stopPromise;
		expect(handlerResolved).toBe(true);
	});

	it("stop() before start() is a no-op and poisons subsequent start()", async () => {
		// A stop-before-start should abort the internal controller cleanly,
		// and a later start() should NOT kick off a stream against an
		// already-aborted signal. The agent is single-shot.
		const { client, messagesCalls } = makeStubClient();
		const agent = defineAgentT({ client, onMessage: vi.fn() });

		await agent.stop();
		expect(agent.started).toBe(true);
		expect(messagesCalls).toHaveLength(0);

		// Subsequent start() — must also be a no-op.
		await agent.start();
		expect(messagesCalls).toHaveLength(0);
	});

	it("start() after stop() is a no-op (single-shot lifecycle)", async () => {
		const { client, messagesCalls, end } = makeStubClient();
		const agent = defineAgentT({ client, onMessage: vi.fn() });
		await agent.start();
		end();
		await agent.stop();

		// Re-starting must not open a second stream.
		await agent.start();
		expect(messagesCalls).toHaveLength(1);
	});

	it("logs the handler error message via console.error when onError absent", async () => {
		// Assert the full substring shape of the default-log path (id, type,
		// error name + message) rather than just /handler error/.
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { client, push, end } = makeStubClient();
		const agent = defineAgentT({
			client,
			onMessage: () => {
				throw new TypeError("boom-boom");
			},
		});
		await agent.start();
		const m1 = makeDecrypted({ type: "rine.v1.task_request" });
		push(m1);
		await tick(10);
		end();
		await agent.stop();

		expect(errSpy).toHaveBeenCalledTimes(1);
		const logLine = String(errSpy.mock.calls[0]?.[0]);
		expect(logLine).toContain("handler error");
		expect(logLine).toContain(m1.id);
		expect(logLine).toContain("rine.v1.task_request");
		expect(logLine).toContain("TypeError");
		expect(logLine).toContain("boom-boom");
	});
});

// ---------------------------------------------------------------------------
// defineAgent auto-start
// ---------------------------------------------------------------------------

describe("defineAgent() — auto-start", () => {
	it("auto-starts by default (no manual agent.start() needed)", async () => {
		const { client, push, end } = makeStubClient();
		const onMessage = vi.fn();

		// Intentionally no explicit `start()` — the factory should kick
		// the loop on its own.
		const agent = defineAgent({ client, onMessage });

		// `start()` is a microtask internally; let it schedule.
		await tick(0);
		expect(agent.started).toBe(true);

		push(makeDecrypted({ type: "rine.v1.task_request" }));
		await tick(10);
		end();
		await agent.stop();

		expect(onMessage).toHaveBeenCalledTimes(1);
	});

	it("respects autoStart: false (no loop until start() is called)", async () => {
		const { client, messagesCalls } = makeStubClient();
		const onMessage = vi.fn();

		const agent = defineAgent({
			client,
			onMessage,
			autoStart: false,
		});

		await tick(10);
		// Loop must not have opened a stream yet.
		expect(messagesCalls).toHaveLength(0);
		expect(agent.started).toBe(false);

		// Cleanly tear down without ever starting.
		await agent.stop();
	});

	it("await using agent = defineAgent(...) works without explicit start()", async () => {
		const { client, push, end } = makeStubClient();
		const onMessage = vi.fn();
		let disposed = false;

		{
			// biome-ignore lint/correctness/noUnusedVariables: asyncDispose sentinel
			await using agent = defineAgent({ client, onMessage });
			await tick(0);
			push(makeDecrypted({ type: "rine.v1.task_request" }));
			await tick(10);
			end();
			disposed = true;
		}

		expect(disposed).toBe(true);
		expect(onMessage).toHaveBeenCalledTimes(1);
	});
});
