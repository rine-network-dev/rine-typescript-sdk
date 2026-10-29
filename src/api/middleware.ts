/**
 * Middleware pipeline for `SDKHttpClient`.
 *
 * Functional chain: `(ctx, next) => Promise<Response>`. One symmetric signature
 * covers logging, retry, rate-limiting, telemetry. No split onRequest/onResponse
 * hooks.
 *
 * **Scope boundary.** Middleware wraps `SDKHttpClient.{get,post,put,patch,delete}()`.
 * It does NOT wrap `openStream()` (SSE lifecycle is incompatible with one-shot
 * request/response) or `getCoreHttpClient()` (crypto-path calls go through a
 * separate rine-core HttpClient).
 *
 * **Retry placement.** User middleware sits *outside* the core 401 refresh +
 * 429 retry loop. Middleware sees one logical call per `.get()/.post()/...`,
 * not per retry attempt.
 */

// ---------------------------------------------------------------------------
// RineOperation — stable low-cardinality telemetry labels
// ---------------------------------------------------------------------------

/**
 * One stable label per public SDK method. Used by middleware for
 * low-cardinality telemetry without URL parsing.
 *
 * **Stability guarantee.** Adding new labels is non-breaking; removing or
 * renaming a label is a breaking change. Telemetry consumers can depend on
 * these strings across v0.x → v1.x.
 */
export type RineOperation =
	// Messaging
	| "send"
	| "reply"
	| "inbox"
	| "markDelivered"
	| "read"
	| "sendAndWait"
	| "thread"
	| "stream"
	| "poll"
	// Identity
	| "whoami"
	| "createAgent"
	| "getAgent"
	| "listAgents"
	| "updateAgent"
	| "revokeAgent"
	| "rotateKeys"
	| "verifyIdentity"
	| "regeneratePollToken"
	| "revokePollToken"
	| "getQuotas"
	// Org lifecycle
	| "updateOrg"
	| "eraseOrg"
	| "exportOrg"
	// Agent cards
	| "setAgentCard"
	| "getAgentCard"
	| "deleteAgentCard"
	// Discovery
	| "discover"
	| "inspect"
	| "discoverGroups"
	// Groups
	| "groupsCreate"
	| "groupsGet"
	| "groupsJoin"
	| "groupsMembers"
	| "groupsInvite"
	| "groupsList"
	| "groupsUpdate"
	| "groupsDelete"
	| "groupsRemoveMember"
	| "groupsListRequests"
	| "groupsListInvites"
	| "groupsVote"
	// Webhooks
	| "webhooksCreate"
	| "webhooksList"
	| "webhooksUpdate"
	| "webhooksDelete"
	| "webhooksDeliveries"
	| "webhooksDeliverySummary"
	// Agentic layer
	| "messages"
	| "conversationSend"
	| "conversationReply"
	| "conversationMessages"
	| "conversationHistory";

// ---------------------------------------------------------------------------
// RequestContext
// ---------------------------------------------------------------------------

/**
 * Per-call context passed to every middleware. Fully formed by the time the
 * chain starts — url includes the query string, headers are a native
 * `Headers` object, body is the pre-serialization value (middleware sees the
 * object, not the JSON string).
 */
export interface RequestContext {
	readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	readonly url: string;
	/**
	 * Mutable — middleware may add/remove/set headers (auth, tracing, redact).
	 * The core request loop reads from this after the chain runs, so mutations
	 * take effect on the wire.
	 */
	readonly headers: Headers;
	/** Read-only from middleware's POV. */
	readonly body: unknown;
	/** Read-only — composed upstream at the SDK boundary. */
	readonly signal: AbortSignal;
	/** Read-only low-cardinality label for telemetry. */
	readonly operation: RineOperation;
	/** Reserved for future A2A Protocol Bridge. Always `'rest'` in v0.1. */
	readonly transport: "rest" | "a2a";
}

// ---------------------------------------------------------------------------
// RineMiddleware
// ---------------------------------------------------------------------------

/**
 * Functional middleware — Koa/Hono/Vercel-AI-SDK shape.
 *
 * - **Continue**: call `next()` and return (or return-from) its `Response`.
 * - **Short-circuit**: do not call `next()`. The downstream chain and the
 *   network request are both skipped. Middleware can synthesize a `Response`
 *   to serve a cached/mocked reply.
 * - **Throw**: propagates up the chain as a rejected promise.
 */
export type RineMiddleware = (
	ctx: RequestContext,
	next: () => Promise<Response>,
) => Promise<Response>;

// ---------------------------------------------------------------------------
// composeMiddleware
// ---------------------------------------------------------------------------

/**
 * Fold a middleware array into a single bound pipeline.
 *
 * Composed once at `SDKHttpClient` construction. The first element of
 * `middleware` is the outermost layer (called first); the last element is
 * adjacent to `core`. Order corresponds to the reader's mental model: a
 * `loggingMiddleware` placed first wraps everything below it.
 *
 * ```
 * user's middleware[0]  ← outermost, called first
 *   └── user's middleware[1]
 *       └── user's middleware[2]
 *           └── core request
 * ```
 */
export function composeMiddleware(
	middleware: readonly RineMiddleware[],
	core: (ctx: RequestContext) => Promise<Response>,
): (ctx: RequestContext) => Promise<Response> {
	return middleware.reduceRight<(ctx: RequestContext) => Promise<Response>>(
		(next, mw) => (ctx) => mw(ctx, () => next(ctx)),
		core,
	);
}

// ---------------------------------------------------------------------------
// loggingMiddleware — the one built-in
// ---------------------------------------------------------------------------

export interface LoggingMiddlewareOptions {
	/** @default console */
	logger?: { log(msg: string, meta?: unknown): void };
	/**
	 * Header names (case-insensitive) to redact from logs. `authorization` is
	 * always redacted — even if the caller passes `redact: []` it is force-
	 * added to the set.
	 *
	 * @default ['authorization', 'cookie']
	 */
	redact?: readonly string[];
}

const DEFAULT_REDACT = ["authorization", "cookie"] as const;

/**
 * Logs one line per request start + one line per response (with duration).
 * On error (middleware throw or downstream rejection) logs a `✗` line and
 * re-throws — never swallows errors.
 *
 * Format:
 *   rine → {method} {url} op={operation}
 *   rine ← {status} {method} {url} ({durationMs}ms)
 *   rine ✗ {method} {url} {err.name}: {err.message}
 */
export function loggingMiddleware(
	opts: LoggingMiddlewareOptions = {},
): RineMiddleware {
	const logger = opts.logger ?? console;
	// Case-insensitive set with `authorization` always included.
	const redactSet = new Set<string>(
		(opts.redact ?? DEFAULT_REDACT).map((h) => h.toLowerCase()),
	);
	redactSet.add("authorization");

	return async (ctx, next) => {
		const started = Date.now();
		const redactedHeaders = snapshotHeaders(ctx.headers, redactSet);
		logger.log(`rine → ${ctx.method} ${ctx.url} op=${ctx.operation}`, {
			headers: redactedHeaders,
		});
		try {
			const res = await next();
			const durationMs = Date.now() - started;
			logger.log(
				`rine ← ${res.status} ${ctx.method} ${ctx.url} (${durationMs}ms)`,
			);
			return res;
		} catch (err) {
			const name = err instanceof Error ? err.name : "Error";
			const message = err instanceof Error ? err.message : String(err);
			logger.log(`rine ✗ ${ctx.method} ${ctx.url} ${name}: ${message}`);
			throw err;
		}
	};
}

/**
 * Snapshot a `Headers` object into a plain record with redaction applied.
 * Produces a stable, logger-friendly object (Headers itself doesn't pretty-
 * print inside structured loggers).
 */
function snapshotHeaders(
	headers: Headers,
	redactSet: ReadonlySet<string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key] = redactSet.has(key.toLowerCase()) ? "[REDACTED]" : value;
	});
	return out;
}
