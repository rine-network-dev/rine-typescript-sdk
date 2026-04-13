/**
 * Step 20 — middleware stack regression tests.
 *
 * DoD: test shows middleware runs on every request, short-circuits on throw,
 * composes in order. Plus the `loggingMiddleware` built-in and the scope
 * boundary rule (openStream/getCoreHttpClient do NOT run middleware).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the rine-core auth helpers so openStream / getCoreHttpClient can reach
// fetch without a real credentials file. Hoisted by vitest — must be above
// the SDKHttpClient import.
vi.mock("@rine-network/core", async () => {
	const actual =
		await vi.importActual<typeof import("@rine-network/core")>(
			"@rine-network/core",
		);
	return {
		...actual,
		loadCredentials: vi.fn(() => ({
			default: {
				org_id: "stub",
				agent_handle: "stub@stub",
				agent_id: "stub",
				signing_key: "stub",
				encryption_key: "stub",
			},
		})),
		getOrRefreshToken: vi.fn(async () => "stub-token"),
	};
});

import { SDKHttpClient } from "./http.js";
import {
	type RequestContext,
	type RineMiddleware,
	composeMiddleware,
	loggingMiddleware,
} from "./middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
	return {
		method: "GET",
		url: "https://api.test/example",
		headers: new Headers(),
		body: undefined,
		signal: new AbortController().signal,
		operation: "poll",
		transport: "rest",
		...overrides,
	};
}

function okResponse(body = "{}"): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

// ---------------------------------------------------------------------------
// composeMiddleware — pure unit
// ---------------------------------------------------------------------------

describe("composeMiddleware", () => {
	it("returns the core function when middleware is empty", async () => {
		const core = vi.fn(async () => okResponse());
		const pipeline = composeMiddleware([], core);
		const ctx = makeCtx();
		await pipeline(ctx);
		expect(core).toHaveBeenCalledTimes(1);
		expect(core).toHaveBeenCalledWith(ctx);
	});

	it("runs middleware in order — first element is outermost", async () => {
		const trace: string[] = [];
		const a: RineMiddleware = async (ctx, next) => {
			trace.push("a:before");
			const res = await next();
			trace.push("a:after");
			return res;
		};
		const b: RineMiddleware = async (ctx, next) => {
			trace.push("b:before");
			const res = await next();
			trace.push("b:after");
			return res;
		};
		const c: RineMiddleware = async (ctx, next) => {
			trace.push("c:before");
			const res = await next();
			trace.push("c:after");
			return res;
		};
		const core = vi.fn(async () => {
			trace.push("core");
			return okResponse();
		});
		const pipeline = composeMiddleware([a, b, c], core);
		await pipeline(makeCtx());
		expect(trace).toEqual([
			"a:before",
			"b:before",
			"c:before",
			"core",
			"c:after",
			"b:after",
			"a:after",
		]);
	});

	it("short-circuits when middleware does not call next()", async () => {
		const core = vi.fn(async () => okResponse());
		const downstream: RineMiddleware = vi.fn(async (_ctx, next) => next());
		const short: RineMiddleware = async () =>
			new Response("cached", { status: 200 });
		const pipeline = composeMiddleware([short, downstream], core);
		const res = await pipeline(makeCtx());
		expect(await res.text()).toBe("cached");
		expect(downstream).not.toHaveBeenCalled();
		expect(core).not.toHaveBeenCalled();
	});

	it("propagates middleware throws up the chain", async () => {
		const core = vi.fn(async () => okResponse());
		const bomb: RineMiddleware = async () => {
			throw new Error("boom");
		};
		const pipeline = composeMiddleware([bomb], core);
		await expect(pipeline(makeCtx())).rejects.toThrow("boom");
		expect(core).not.toHaveBeenCalled();
	});

	it("outer middleware may swallow downstream errors and return a synthetic response", async () => {
		// Valid-but-dangerous pattern: outer layer catches a downstream throw
		// and converts it into a success Response. Guards against a future
		// refactor that double-throws through the pipeline.
		const suppressor: RineMiddleware = async (_ctx, next) => {
			try {
				return await next();
			} catch {
				return new Response("{}", { status: 200 });
			}
		};
		const core = vi.fn(async () => {
			throw new Error("downstream-fail");
		});
		const pipeline = composeMiddleware([suppressor], core);
		const res = await pipeline(makeCtx());
		expect(res.status).toBe(200);
		expect(core).toHaveBeenCalledTimes(1);
	});

	it("propagates downstream rejections back through middleware", async () => {
		const seen: unknown[] = [];
		const catcher: RineMiddleware = async (_ctx, next) => {
			try {
				return await next();
			} catch (err) {
				seen.push(err);
				throw err;
			}
		};
		const core = vi.fn(async () => {
			throw new Error("downstream-fail");
		});
		const pipeline = composeMiddleware([catcher], core);
		await expect(pipeline(makeCtx())).rejects.toThrow("downstream-fail");
		expect(seen).toHaveLength(1);
		expect((seen[0] as Error).message).toBe("downstream-fail");
	});

	it("lets middleware observe header mutations made by outer layers", async () => {
		const outer: RineMiddleware = async (ctx, next) => {
			ctx.headers.set("X-Trace", "outer");
			return next();
		};
		const inner: RineMiddleware = async (ctx, next) => {
			expect(ctx.headers.get("X-Trace")).toBe("outer");
			ctx.headers.set("X-Trace-Inner", "inner");
			return next();
		};
		let seenAtCore: Headers | undefined;
		const core = async (ctx: RequestContext) => {
			seenAtCore = ctx.headers;
			return okResponse();
		};
		const pipeline = composeMiddleware([outer, inner], core);
		await pipeline(makeCtx());
		expect(seenAtCore?.get("X-Trace")).toBe("outer");
		expect(seenAtCore?.get("X-Trace-Inner")).toBe("inner");
	});
});

// ---------------------------------------------------------------------------
// loggingMiddleware — built-in
// ---------------------------------------------------------------------------

describe("loggingMiddleware", () => {
	it("logs start and response lines with duration", async () => {
		const log = vi.fn();
		const mw = loggingMiddleware({ logger: { log } });
		const core = async () => okResponse();
		const pipeline = composeMiddleware([mw], core);
		await pipeline(
			makeCtx({
				method: "POST",
				url: "https://api.test/send",
				operation: "send",
			}),
		);
		expect(log).toHaveBeenCalledTimes(2);
		expect(log.mock.calls[0]?.[0]).toBe(
			"rine → POST https://api.test/send op=send",
		);
		expect(log.mock.calls[1]?.[0]).toMatch(
			/^rine ← 200 POST https:\/\/api\.test\/send \(\d+ms\)$/,
		);
	});

	it("redacts authorization and cookie headers by default", async () => {
		const log = vi.fn();
		const mw = loggingMiddleware({ logger: { log } });
		const core = async () => okResponse();
		const pipeline = composeMiddleware([mw], core);
		const headers = new Headers({
			Authorization: "Bearer secret-token",
			Cookie: "session=abc",
			"X-Trace-Id": "trace-1",
		});
		await pipeline(makeCtx({ headers }));
		const startMeta = log.mock.calls[0]?.[1] as {
			headers: Record<string, string>;
		};
		expect(startMeta.headers.authorization).toBe("[REDACTED]");
		expect(startMeta.headers.cookie).toBe("[REDACTED]");
		expect(startMeta.headers["x-trace-id"]).toBe("trace-1");
	});

	it("always redacts authorization even if caller passes redact: []", async () => {
		const log = vi.fn();
		const mw = loggingMiddleware({ logger: { log }, redact: [] });
		const core = async () => okResponse();
		const pipeline = composeMiddleware([mw], core);
		const headers = new Headers({ Authorization: "Bearer whatever" });
		await pipeline(makeCtx({ headers }));
		const meta = log.mock.calls[0]?.[1] as { headers: Record<string, string> };
		expect(meta.headers.authorization).toBe("[REDACTED]");
	});

	it("logs an error line and re-throws on downstream failure", async () => {
		const log = vi.fn();
		const mw = loggingMiddleware({ logger: { log } });
		const core = async () => {
			throw new TypeError("network down");
		};
		const pipeline = composeMiddleware([mw], core);
		await expect(pipeline(makeCtx())).rejects.toThrow("network down");
		expect(log).toHaveBeenCalledTimes(2);
		expect(log.mock.calls[1]?.[0]).toBe(
			"rine ✗ GET https://api.test/example TypeError: network down",
		);
	});
});

// ---------------------------------------------------------------------------
// SDKHttpClient integration — middleware wraps the request loop
// ---------------------------------------------------------------------------

describe("SDKHttpClient middleware integration", () => {
	let fetchStub: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchStub = vi.fn(
			async () =>
				new Response(JSON.stringify({ count: 3 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchStub);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("runs the middleware pipeline on every HTTP call", async () => {
		const seen: RequestContext[] = [];
		const mw: RineMiddleware = async (ctx, next) => {
			seen.push(ctx);
			return next();
		};
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			middleware: [mw],
		});
		// Unauthenticated path avoids the loadCredentials file read.
		await http.get("/poll", { unauthenticated: true, operation: "poll" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.method).toBe("GET");
		expect(seen[0]?.url).toBe("https://api.test/poll");
		expect(seen[0]?.operation).toBe("poll");
		expect(seen[0]?.transport).toBe("rest");
		expect(fetchStub).toHaveBeenCalledTimes(1);
	});

	it("composes middleware in order around the transport", async () => {
		const trace: string[] = [];
		const outer: RineMiddleware = async (_ctx, next) => {
			trace.push("outer:before");
			const r = await next();
			trace.push("outer:after");
			return r;
		};
		const inner: RineMiddleware = async (_ctx, next) => {
			trace.push("inner:before");
			const r = await next();
			trace.push("inner:after");
			return r;
		};
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			middleware: [outer, inner],
		});
		await http.get("/poll", { unauthenticated: true, operation: "poll" });
		expect(trace).toEqual([
			"outer:before",
			"inner:before",
			"inner:after",
			"outer:after",
		]);
	});

	it("short-circuiting middleware skips the fetch entirely", async () => {
		const cached: RineMiddleware = async () =>
			new Response(JSON.stringify({ count: 99 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			middleware: [cached],
		});
		const result = await http.get<{ count: number }>("/poll", {
			unauthenticated: true,
			operation: "poll",
		});
		expect(result).toEqual({ count: 99 });
		expect(fetchStub).not.toHaveBeenCalled();
	});

	it("middleware throw short-circuits the chain and never calls fetch", async () => {
		const bomb: RineMiddleware = async () => {
			throw new Error("blocked");
		};
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			middleware: [bomb],
		});
		await expect(
			http.get("/poll", { unauthenticated: true, operation: "poll" }),
		).rejects.toThrow("blocked");
		expect(fetchStub).not.toHaveBeenCalled();
	});

	it("header mutations in middleware reach the outbound request", async () => {
		const trace: RineMiddleware = async (ctx, next) => {
			ctx.headers.set("X-Request-Id", "req-42");
			return next();
		};
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			middleware: [trace],
		});
		await http.post(
			"/poll",
			{ ping: true },
			{ unauthenticated: true, operation: "poll" },
		);
		expect(fetchStub).toHaveBeenCalledTimes(1);
		const init = fetchStub.mock.calls[0]?.[1] as RequestInit;
		const sentHeaders = init.headers as Record<string, string>;
		expect(sentHeaders["x-request-id"]).toBe("req-42");
	});

	it("runs middleware for POST / PUT / PATCH / DELETE", async () => {
		const seen: Array<{ method: string; operation: string }> = [];
		const mw: RineMiddleware = async (ctx, next) => {
			seen.push({ method: ctx.method, operation: ctx.operation });
			return next();
		};
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			middleware: [mw],
		});
		const baseOpts = { unauthenticated: true, operation: "poll" } as const;
		await http.get("/poll", baseOpts);
		await http.post("/poll", { x: 1 }, baseOpts);
		await http.put("/poll", { x: 2 }, baseOpts);
		await http.patch("/poll", { x: 3 }, baseOpts);
		await http.delete("/poll", baseOpts);
		expect(seen.map((s) => s.method)).toEqual([
			"GET",
			"POST",
			"PUT",
			"PATCH",
			"DELETE",
		]);
	});

	it("throws when a resource call forgets to set `operation` (GET)", async () => {
		const http = new SDKHttpClient({ apiUrl: "https://api.test" });
		// `operation` is typed `RineOperation | undefined`, so tsc does not
		// flag the omission — this test exercises the runtime guard at
		// http.ts:238 that catches unlabeled call sites loudly in dev.
		await expect(http.get("/poll", { unauthenticated: true })).rejects.toThrow(
			/without opts\.operation/,
		);
		expect(fetchStub).not.toHaveBeenCalled();
	});

	it("throws when a resource call forgets to set `operation` (POST)", async () => {
		// Same runtime guard — exercised through the other HTTP verb path to
		// prove it isn't GET-specific.
		const http = new SDKHttpClient({ apiUrl: "https://api.test" });
		await expect(
			http.post("/poll", { x: 1 }, { unauthenticated: true }),
		).rejects.toThrow(/without opts\.operation/);
		expect(fetchStub).not.toHaveBeenCalled();
	});

	it("openStream does NOT run the middleware pipeline (SPEC §9.6)", async () => {
		// openStream is the SSE path — long-lived, Last-Event-ID resume,
		// reconnect — incompatible with one-shot middleware. Stub the auth
		// helpers (vi.mock at top of file) so openStream actually reaches
		// fetch; then verify the spy middleware never ran.
		let middlewareRuns = 0;
		const spy: RineMiddleware = async (_ctx, next) => {
			middlewareRuns++;
			return next();
		};
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			middleware: [spy],
		});
		fetchStub.mockResolvedValueOnce(
			new Response("data: {}\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		const ac = new AbortController();
		const res = await http.openStream("/agents/x/stream", {
			signal: ac.signal,
		});
		expect(res.status).toBe(200);
		expect(fetchStub).toHaveBeenCalledTimes(1);
		expect(middlewareRuns).toBe(0);
	});

	it("getCoreHttpClient does NOT run the middleware pipeline (SPEC §6.5)", async () => {
		// getCoreHttpClient returns a rine-core HttpClient for the crypto
		// path. Calls through it must bypass SDK middleware entirely — the
		// crypto layer has its own retry/auth semantics.
		let middlewareRuns = 0;
		const spy: RineMiddleware = async (_ctx, next) => {
			middlewareRuns++;
			return next();
		};
		const http = new SDKHttpClient({
			apiUrl: "https://api.test",
			middleware: [spy],
		});
		const core = http.getCoreHttpClient();
		fetchStub.mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await core.get("/agents/someone/prekeys");
		expect(fetchStub).toHaveBeenCalledTimes(1);
		expect(middlewareRuns).toBe(0);
	});
});
