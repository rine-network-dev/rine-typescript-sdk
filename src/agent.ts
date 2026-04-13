/**
 * `defineAgent()` — handler-based actor loop for incoming messages.
 *
 * Built on top of `client.messages()`. No new transport, no new
 * crypto — this file is purely lifecycle + handler dispatch + error
 * isolation. Schema validation runs inside `defineAgent` so a failure
 * routes to `onError({ stage: 'schema' })` and the loop keeps running.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
	AsyncRineClient,
	MessagesOptions,
	ReplyOptions,
} from "./client.js";
import type { ConversationScope } from "./resources/conversation.js";
import { type DecryptedMessage, asMessageUuid } from "./types.js";
import { anySignal } from "./utils/abort.js";
import { parseMessagePlaintext } from "./utils/schema.js";

/** Return type of `client.reply()` — pinned via `ReturnType` to keep the
 * agent decoupled from whichever `MessageRead` variant the resource layer
 * hands back. */
type ReplyResult = Awaited<ReturnType<AsyncRineClient["reply"]>>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * User-supplied message handler. Called once per decrypted,
 * non-reserved, schema-passing message. A throw is caught and routed to
 * `onError({ stage: 'handler' })` — the agent keeps running. When
 * `defineAgent<T>({ schema })` is used, `msg.plaintext` is narrowed to
 * `T | null` per SPEC §7.4 / §11.4.
 */
export type AgentHandler<T = unknown> = (
	msg: DecryptedMessage<T>,
	ctx: AgentMessageContext,
) => void | Promise<void>;

export interface AgentMessageContext {
	/** The client the agent was built on. Use for sends, discovery, state lookups. */
	client: AsyncRineClient;
	/**
	 * Pre-bound conversation scope — shortcut for
	 * `client.conversation(msg.conversation_id)` (SPEC §11.2 / §11.3).
	 * Use for turn-taking inside the same conversation without manually
	 * threading `conversation_id` through every call.
	 */
	conversation: ConversationScope;
	/** Shortcut for `client.reply(msg.id, payload, opts)`. */
	reply: <R = unknown>(
		payload: R,
		opts?: ReplyOptions<R>,
	) => Promise<ReplyResult>;
	/** Aborted when `agent.stop()` is called (or an external `opts.signal` fires). */
	signal: AbortSignal;
}

export interface AgentErrorContext {
	/** The message being processed, or null if the error was in setup / stream connect. */
	message: DecryptedMessage | null;
	/**
	 * Stage at which the error occurred.
	 *
	 * Note: `"decrypt"` is deliberately absent from this union — §11.3.2
	 * specifies that decryption failures surface on `msg.decrypt_error`
	 * and still reach the handler, so they never route to `onError`.
	 * `"schema"` fires when the `defineAgent<T>({ schema })` validation
	 * step rejects a decrypted plaintext (SPEC §11.4 / §11.3.2) — the
	 * message is skipped and the loop keeps running.
	 */
	stage: "schema" | "handler" | "lifecycle";
}

interface DefineAgentCommon<T = unknown> {
	client: AsyncRineClient;
	signal?: AbortSignal;
	/** Debug escape hatch — forwarded to `client.messages({ includeReserved })`. */
	includeReserved?: boolean;
	/**
	 * Whether to fire-and-forget `agent.start()` when the factory returns.
	 * Default `true` — first-time users otherwise call `defineAgent(...)` and
	 * watch the loop sit idle because they didn't call `start()`. Tests that
	 * need to arrange fixtures between `defineAgent()` and the first
	 * message must pass `autoStart: false` and call `start()` explicitly.
	 */
	autoStart?: boolean;
	/**
	 * Standard Schema v1 — validates `msg.plaintext` for every delivered
	 * message before the handler runs (SPEC §11.4). A failure routes to
	 * `onError({ stage: 'schema' })` and the message is skipped; the loop
	 * keeps running. `msg.plaintext` is narrowed to `T | null` inside
	 * handlers when a schema is supplied.
	 */
	schema?: StandardSchemaV1<unknown, T>;
	/**
	 * Opt-in polling mode. NOT yet implemented in Step 17 — setting this
	 * throws at construction time. The `pollInterval` path is SPEC §11.3.4
	 * and is deferred until the poll/inbox ergonomics settle (§11.3.5
	 * explicitly rejects silent SSE→polling fallback, so we'd rather ship
	 * nothing than ship the wrong semantics).
	 */
	pollInterval?: number;
	/** Called for every uncaught error — schema, handler, or lifecycle. */
	onError?: (err: unknown, ctx: AgentErrorContext) => void | Promise<void>;
}

interface DefineAgentWithHandlers<T = unknown> extends DefineAgentCommon<T> {
	handlers: Partial<Record<string, AgentHandler<T>>> & {
		"*"?: AgentHandler<T>;
	};
	onMessage?: never;
}

interface DefineAgentWithOnMessage<T = unknown> extends DefineAgentCommon<T> {
	onMessage: AgentHandler<T>;
	handlers?: never;
}

/**
 * Options bag for `defineAgent()`. The discriminated union enforces that
 * callers supply exactly one of `handlers` (type-routed dispatch dict,
 * optionally with a `"*"` catch-all) OR `onMessage` (single handler for
 * every non-reserved message) — passing both is a TypeScript error.
 */
export type DefineAgentOptions<T = unknown> =
	| DefineAgentWithHandlers<T>
	| DefineAgentWithOnMessage<T>;

export interface RineAgent {
	/** `true` after `start()` has been called at least once. */
	readonly started: boolean;
	/** Begin consuming messages. Resolves once the loop is scheduled. Idempotent. */
	start(): Promise<void>;
	/** Drain in-flight handlers, close the stream. Idempotent. */
	stop(): Promise<void>;
	/** AsyncDisposable — `await using agent = defineAgent(...)` calls stop() on scope exit. */
	[Symbol.asyncDispose](): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Grace period after `stop()` before in-flight handlers are logged as
 * still-running. SPEC §11.3.3 — we don't forcibly terminate user promises
 * (Node has no mechanism), we just wait and then log.
 */
const STOP_GRACE_MS = 30_000;

// ---------------------------------------------------------------------------
// defineAgent
// ---------------------------------------------------------------------------

export function defineAgent<T = unknown>(
	opts: DefineAgentOptions<T>,
): RineAgent {
	if (opts.pollInterval !== undefined) {
		throw new Error(
			"defineAgent: pollInterval is not yet supported. " +
				"Use SSE (the default) for message delivery.",
		);
	}

	const {
		client,
		signal: externalSignal,
		includeReserved,
		onError,
		schema,
	} = opts;

	// Internal stop controller — fires when the user calls stop() OR when
	// the external signal aborts. Composed via `anySignal` so either path
	// tears down the same way.
	const internalStop = new AbortController();
	const composedSignal = externalSignal
		? anySignal(externalSignal, internalStop.signal)
		: internalStop.signal;

	// Handler mode detection. The discriminated union above guarantees
	// TypeScript errors at call sites if both `handlers` and `onMessage`
	// are passed, but we still need the runtime branch for dispatch.
	const handlerMode = "handlers" in opts && opts.handlers !== undefined;
	const handlers: Partial<Record<string, AgentHandler<T>>> | undefined =
		handlerMode ? opts.handlers : undefined;
	const onMessage: AgentHandler<T> | undefined = !handlerMode
		? opts.onMessage
		: undefined;

	// Pre-decrypt type filter optimization (SPEC §11.3.1). Type-routed
	// agents without a catch-all pass `Object.keys(handlers)` down to
	// `client.messages({ type })` so the SSE layer filters on the
	// cleartext `type` field before we spend a decrypt call on it.
	//
	// With a `'*'` catch-all or the `onMessage` form, the agent sees every
	// non-reserved message, so no filter is applied.
	let typeFilter: string[] | undefined;
	if (handlers) {
		const keys = Object.keys(handlers).filter((k) => k !== "*");
		const hasWildcard = handlers["*"] !== undefined;
		if (!hasWildcard && keys.length > 0) {
			typeFilter = keys;
		}
	}

	// Track in-flight handler promises so stop() can drain them.
	const inflight = new Set<Promise<unknown>>();

	let started = false;
	let stopPromise: Promise<void> | null = null;
	let loopPromise: Promise<void> | null = null;

	const reportError = async (
		err: unknown,
		ctx: AgentErrorContext,
	): Promise<void> => {
		if (onError === undefined) {
			const msgId = ctx.message?.id ?? "<no-msg>";
			const msgType = ctx.message?.type ?? "<no-type>";
			const name = err instanceof Error ? err.name : "Error";
			const reason = err instanceof Error ? err.message : String(err);
			console.error(
				`rine: defineAgent ${ctx.stage} error on ${msgId} (${msgType}): ${name}: ${reason}`,
			);
			return;
		}
		try {
			await onError(err, ctx);
		} catch (innerErr) {
			// SPEC §11.3.2: a throw inside onError is caught and logged once,
			// the agent keeps running.
			const reason =
				innerErr instanceof Error ? innerErr.message : String(innerErr);
			console.error(`rine: defineAgent onError itself threw: ${reason}`);
		}
	};

	const dispatch = async (msg: DecryptedMessage): Promise<void> => {
		// Schema validation runs first. A failure routes to `onError` with
		// `stage: 'schema'` and the message is skipped — the handler is not
		// invoked. Decrypt-failed envelopes bypass the schema check so the
		// handler still sees them and can branch on `decrypt_error`. SPEC
		// §11.3.2 / §11.4.
		let typed: DecryptedMessage<T>;
		if (schema !== undefined && msg.decrypt_error == null) {
			try {
				typed = await parseMessagePlaintext(msg, schema);
			} catch (err) {
				await reportError(err, { message: msg, stage: "schema" });
				return;
			}
		} else {
			typed = msg as DecryptedMessage<T>;
		}

		const ctx: AgentMessageContext = {
			client,
			// Pass the full message — the scope auto-binds the peer so
			// handlers can call `ctx.conversation.send(payload)` without
			// threading a recipient. See REQ-07 (sdk-handoff-fixes).
			conversation: client.conversation(msg),
			reply: (payload, replyOpts) =>
				client.reply(asMessageUuid(msg.id), payload, replyOpts),
			signal: composedSignal,
		};

		// Pick the handler. Type-routed dispatch first, then '*', then drop.
		let handler: AgentHandler<T> | undefined;
		if (handlers) {
			handler = handlers[msg.type] ?? handlers["*"];
		} else if (onMessage) {
			handler = onMessage;
		}
		if (!handler) return; // silent drop — SPEC §11.3.1 dispatch rule 3

		try {
			await handler(typed, ctx);
		} catch (err) {
			await reportError(err, { message: msg, stage: "handler" });
		}
	};

	const runLoop = async (): Promise<void> => {
		try {
			const messageOpts: MessagesOptions = {
				signal: composedSignal,
				includeReserved,
			};
			if (typeFilter) messageOpts.type = typeFilter;

			for await (const msg of client.messages(messageOpts)) {
				if (composedSignal.aborted) break;

				// Add to the inflight set BEFORE attaching the cleanup
				// `.finally()` — if the cleanup was chained first, a future
				// edit inserting an `await` between the two statements could
				// race with `stop()` and miss a handler that hadn't been
				// registered yet. Registering synchronously before the
				// chain closes that door.
				const task = dispatch(msg);
				inflight.add(task);
				task.finally(() => inflight.delete(task));
			}
		} catch (err) {
			// Swallow abort-originated errors on a clean stop. Any other
			// stream-level failure (reconnect exhaust, resolveSenderId
			// throw, etc.) surfaces as a lifecycle error.
			if (composedSignal.aborted) return;
			await reportError(err, { message: null, stage: "lifecycle" });
		}
	};

	const agent: RineAgent = {
		get started() {
			return started;
		},

		async start(): Promise<void> {
			// `stop()` without a prior `start()` flips `started` to true so
			// this guard also blocks start-after-stop (the agent is a
			// single-shot lifecycle; reuse is not supported).
			if (started) return;
			started = true;

			// If an already-aborted signal was passed in, skip the loop
			// entirely — otherwise `for await` would kick off a stream
			// only to immediately tear it down.
			if (composedSignal.aborted) {
				loopPromise = Promise.resolve();
				return;
			}
			loopPromise = runLoop();
		},

		stop(): Promise<void> {
			if (stopPromise) return stopPromise;
			// Mark as started — a stop-before-start + subsequent start()
			// should be a no-op, not a surprise restart against an already
			// aborted controller.
			started = true;
			stopPromise = (async () => {
				if (!internalStop.signal.aborted) internalStop.abort();

				// Wait for the message loop to exit first.
				if (loopPromise) {
					try {
						await loopPromise;
					} catch {
						// Loop-level errors were already routed to onError.
					}
				}

				// Drain in-flight handlers with a bounded grace period.
				// The timer handle is cleared when the drain completes first
				// so successful stops don't leak a 30-second setTimeout.
				if (inflight.size > 0) {
					let timedOut = false;
					let timerHandle: ReturnType<typeof setTimeout> | undefined;
					const timeout = new Promise<void>((resolve) => {
						timerHandle = setTimeout(() => {
							timedOut = true;
							resolve();
						}, STOP_GRACE_MS);
					});
					try {
						await Promise.race([Promise.allSettled([...inflight]), timeout]);
					} finally {
						if (timerHandle !== undefined) clearTimeout(timerHandle);
					}
					if (timedOut && inflight.size > 0) {
						console.warn(
							`rine: defineAgent.stop() grace period (${STOP_GRACE_MS}ms) elapsed with ${inflight.size} handler(s) still running`,
						);
					}
				}
			})();
			return stopPromise;
		},

		async [Symbol.asyncDispose](): Promise<void> {
			await agent.stop();
		},
	};

	// Auto-start by default. Any error inside `start()` is funneled through
	// the existing `onError({ stage: 'lifecycle' })` path via `runLoop()`,
	// so a fire-and-forget here does not leak an unhandled rejection.
	if (opts.autoStart !== false) {
		void agent.start();
	}

	return agent;
}
