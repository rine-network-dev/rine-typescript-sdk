/**
 * Middleware pipeline: compose the built-in `loggingMiddleware` with a
 * custom middleware, then wire both into the client constructor.
 *
 * Middleware is a functional chain — `(ctx, next) => Promise<Response>` —
 * composed once at construction. The first array element is the outermost
 * layer (called first, sees the request before anything downstream).
 *
 * Scope boundary (load-bearing, not an oversight): middleware wraps
 * `SDKHttpClient`'s REST calls only. It does NOT wrap `client.stream()` /
 * `client.messages()` (SSE lifecycle isn't request/response-shaped) or the
 * crypto-path calls inside encrypt/decrypt (those go through a separate
 * rine-core HTTP client). A middleware that logs "every request" will not
 * see SSE frames or key-fetch traffic.
 *
 * Run: `npx tsx examples/middleware.ts`
 */

import {
  AsyncRineClient,
  composeMiddleware,
  loggingMiddleware,
  type RineMiddleware,
} from "@rine-network/sdk";

// A custom middleware: attach a request id header and time the call.
// `ctx.headers` is a mutable `Headers` — the core loop reads from it after
// the chain returns, so mutations here take effect on the wire.
const requestIdMiddleware: RineMiddleware = async (ctx, next) => {
  ctx.headers.set("X-Request-Id", crypto.randomUUID());
  const started = performance.now();
  try {
    return await next();
  } finally {
    const elapsed = (performance.now() - started).toFixed(1);
    console.log(`[timing] ${ctx.operation} took ${elapsed}ms`);
  }
};

// Order matters: this array's first element is outermost. Logging wraps
// everything, including the timing middleware's own duration.
await using client = new AsyncRineClient({
  middleware: [
    loggingMiddleware({ redact: ["authorization", "cookie", "x-api-key"] }),
    requestIdMiddleware,
  ],
});

// composeMiddleware() is also exported directly for callers who want to
// build (and test) a pipeline without a client — useful for unit-testing a
// custom middleware in isolation.
const pipeline = composeMiddleware(
  [loggingMiddleware(), requestIdMiddleware],
  async () => new Response(null, { status: 204 }),
);
await pipeline({
  method: "GET",
  url: "https://rine.network/whoami",
  headers: new Headers(),
  body: undefined,
  signal: new AbortController().signal,
  operation: "whoami",
  transport: "rest",
});

// Both middleware entries run on every REST call the client makes.
const identity = await client.whoami();
console.log(`-> whoami: ${identity.org.name}`);
