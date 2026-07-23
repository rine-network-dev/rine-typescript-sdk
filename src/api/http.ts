/**
 * Internal HTTP layer for the SDK.
 *
 * Wraps rine-core's HttpClient to add:
 * - Native AbortSignal support (via a thin fetch wrapper)
 * - Per-request timeout via AbortSignal.timeout()
 * - Typed error mapping via raiseForStatus()
 * - Agent header injection
 * - User middleware pipeline
 *
 * Middleware wraps `.get/.post/.put/.patch/.delete` only. It does NOT wrap
 * `openStream()` (SSE lifecycle) or `getCoreHttpClient()` (crypto-path —
 * those calls go through a separate rine-core HttpClient).
 */

import {
	HttpClient as CoreHttpClient,
	getOrRefreshToken,
	jitteredRefreshMargin,
	loadCredentials,
} from "@rine-network/core";
import { RineTimeoutError, raiseForStatus } from "../errors.js";
import { anySignal } from "../utils/abort.js";
import { GroupDecryptMemo } from "../utils/decrypt-memo.js";
import { sleepWithSignal } from "../utils/sleep.js";
import {
	type RequestContext,
	type RineMiddleware,
	type RineOperation,
	composeMiddleware,
} from "./middleware.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SDKHttpClientOptions {
	/** Path to the rine config directory. */
	configDir?: string;
	/** API base URL. */
	apiUrl?: string;
	/** Agent handle/UUID to set as X-Rine-Agent on every request. */
	agent?: string;
	/** Request timeout in ms. Default: 30_000. */
	timeout?: number;
	/** Max retries on 429. Default: 2. */
	maxRetries?: number;
	/**
	 * User middleware chain. Composed once at construction.
	 * The first element is the outermost layer.
	 */
	middleware?: readonly RineMiddleware[];
}

export interface GetOptions {
	params?: Record<string, string | number | boolean | undefined>;
	extraHeaders?: Record<string, string>;
	signal?: AbortSignal;
	/** Skip auth header (public endpoints). Default: false. */
	unauthenticated?: boolean;
	/**
	 * Low-cardinality telemetry label. Resource methods auto-populate this
	 * when calling the SDK HTTP layer, so middleware receives a stable label
	 * without needing to parse the URL. Left optional here because a handful
	 * of internal call sites are pre-label (and `openStream`, which doesn't
	 * run middleware, doesn't use `GetOptions`).
	 */
	operation?: RineOperation;
}

export interface RequestOptions extends GetOptions {
	body?: unknown;
}

export interface GetCoreHttpClientOptions {
	/**
	 * Composed abort signal for the crypto operation. Callers must compose
	 * it from the user signal + operation timeout before passing it in;
	 * raw user signals should go through anySignal() first.
	 */
	signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// SDKHttpClient
// ---------------------------------------------------------------------------

export class SDKHttpClient {
	private readonly _configDir: string;
	readonly apiUrl: string;
	readonly agentHeader: Record<string, string> | undefined;
	private readonly _timeout: number;
	readonly maxRetries: number;
	/**
	 * Per-instance token refresh margin, drawn once at construction and
	 * shared by the REST path and every short-lived crypto-path core client, so
	 * co-located SDK instances desynchronize their refreshes instead of
	 * clustering into the same minute.
	 */
	private readonly _refreshMargin: number;
	/**
	 * The user middleware chain, preserved so derived clients
	 * (`client.withSignal`, `withTimeout`, `withAgent`) can forward it. The
	 * compiled pipeline lives in `this.pipeline`.
	 */
	readonly middleware: readonly RineMiddleware[];
	/** Composed middleware pipeline. Bound once at construction. */
	private readonly pipeline: (ctx: RequestContext) => Promise<Response>;
	/**
	 * Per-client memo of successful group decrypts, shared by every receive
	 * surface (`inbox`, `read`, `sendAndWait`, `client.messages`, `thread`).
	 * It lives here because this object is the per-client context those
	 * surfaces already hold; it never touches the wire. `client.close()`
	 * clears it so decrypted plaintext does not outlive the client.
	 */
	readonly decryptMemo = new GroupDecryptMemo();

	get configDir(): string {
		return this._configDir;
	}
	get timeout(): number {
		return this._timeout;
	}

	constructor(opts: SDKHttpClientOptions = {}) {
		this._configDir = opts.configDir ?? "";
		this.apiUrl = opts.apiUrl ?? "https://api.rine.network";
		this.agentHeader = opts.agent ? { "X-Rine-Agent": opts.agent } : undefined;
		this._timeout = opts.timeout ?? 30_000;
		this.maxRetries = opts.maxRetries ?? 2;
		this.middleware = opts.middleware ?? [];
		this._refreshMargin = jitteredRefreshMargin();

		// Bind the middleware pipeline once. `coreRequest` is the inner
		// transport: it reads `ctx.headers` after all middleware has run so
		// header mutations (auth, tracing, redact) take effect on the wire.
		const coreRequest = this.createCoreRequest();
		this.pipeline = composeMiddleware(this.middleware, coreRequest);
	}

	/**
	 * GET /path with typed response.
	 */
	async get<T>(path: string, opts: GetOptions = {}): Promise<T> {
		return this.request<T>("GET", path, opts);
	}

	/**
	 * POST /path with optional body.
	 */
	async post<T>(
		path: string,
		body?: unknown,
		opts: RequestOptions = {},
	): Promise<T> {
		return this.request<T>("POST", path, { ...opts, body });
	}

	/**
	 * POST /path returning both HTTP status code and parsed body.
	 * Used when the caller must branch on status (e.g. 200 vs 202).
	 */
	async postWithStatus<T>(
		path: string,
		body?: unknown,
		opts: RequestOptions = {},
	): Promise<{ status: number; body: T }> {
		return this.requestWithStatus<T>("POST", path, { ...opts, body });
	}

	/**
	 * PUT /path with optional body.
	 */
	async put<T>(
		path: string,
		body?: unknown,
		opts: RequestOptions = {},
	): Promise<T> {
		return this.request<T>("PUT", path, { ...opts, body });
	}

	/**
	 * PATCH /path with optional body.
	 */
	async patch<T>(
		path: string,
		body?: unknown,
		opts: RequestOptions = {},
	): Promise<T> {
		return this.request<T>("PATCH", path, { ...opts, body });
	}

	/**
	 * DELETE /path.
	 */
	async delete<T>(path: string, opts: RequestOptions = {}): Promise<T> {
		return this.request<T>("DELETE", path, opts);
	}

	/**
	 * Open a long-lived streaming GET with auth applied. Used by the SSE
	 * resource — returns the raw Response so the caller can consume the body.
	 *
	 * No per-request timeout is applied: streams are long-lived by design, so
	 * lifetime is controlled exclusively by the caller's AbortSignal.
	 *
	 * **Middleware scope**: `openStream` does NOT run the user middleware
	 * pipeline. SSE lifecycle (long-lived, Last-Event-ID resume, reconnect)
	 * is incompatible with the one-shot request/response middleware shape.
	 * Auth injection still runs via the `fetchWithAuth` path.
	 *
	 * @param opts.signal - REQUIRED. A long-lived stream without a cancel
	 *   signal leaks a connection forever, so the type enforces it. Fire-and-
	 *   forget callers can pass `new AbortController().signal` explicitly
	 *   (see `neverAbortingSignal()` in `streams.ts` for the documented
	 *   escape hatch).
	 */
	async openStream(
		path: string,
		opts: { headers?: Record<string, string>; signal: AbortSignal },
	): Promise<Response> {
		const url = buildUrl(this.apiUrl, path);
		const headers: Record<string, string> = {
			Accept: "text/event-stream",
			...(this.agentHeader ?? {}),
			...(opts.headers ?? {}),
		};
		return this.fetchWithAuth(
			"GET",
			url,
			headers,
			undefined,
			opts.signal,
			false,
		);
	}

	/**
	 * Returns a rine-core HttpClient bound to the same credentials, base URL,
	 * and agent header as this SDKHttpClient, scoped to the given signal.
	 *
	 * Short-lived by contract — construct one per crypto operation, do not
	 * cache. Cost is one object allocation (no network, no token fetch, no
	 * file I/O at construction). The tokenFn closure reads the same config
	 * dir and token cache as the SDK's REST path, so a refresh on either
	 * side is visible to the other.
	 *
	 * Middleware scope: calls made through the returned client do NOT run
	 * the SDK middleware pipeline.
	 */
	getCoreHttpClient(opts: GetCoreHttpClientOptions = {}): CoreHttpClient {
		const entry = loadCredentials(this._configDir).default;
		return new CoreHttpClient({
			apiUrl: this.apiUrl,
			tokenFn: (force) =>
				getOrRefreshToken(this._configDir, this.apiUrl, entry, "default", {
					force,
					refreshMargin: this._refreshMargin,
				}),
			defaultHeaders: this.agentHeader,
			canRefresh: true,
			signal: opts.signal,
		});
	}

	// -------------------------------------------------------------------------
	// Internal request machinery
	// -------------------------------------------------------------------------

	private async request<T>(
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
		path: string,
		opts: GetOptions & { body?: unknown } = {},
	): Promise<T> {
		const res = await this.executeRequest(method, path, opts);
		if (res.status === 204 || res.headers.get("content-length") === "0") {
			return undefined as T;
		}
		return (await res.json()) as T;
	}

	/**
	 * Like `request()` but also returns the HTTP status code. Used when
	 * the caller must branch on status (e.g. 200 vs 202 for group join).
	 */
	private async requestWithStatus<T>(
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
		path: string,
		opts: GetOptions & { body?: unknown } = {},
	): Promise<{ status: number; body: T }> {
		const res = await this.executeRequest(method, path, opts);
		if (res.status === 204 || res.headers.get("content-length") === "0") {
			return { status: res.status, body: undefined as T };
		}
		return { status: res.status, body: (await res.json()) as T };
	}

	/**
	 * Shared request execution: builds context, runs middleware pipeline,
	 * handles errors and timeouts, returns the validated Response.
	 */
	private async executeRequest(
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
		path: string,
		opts: GetOptions & { body?: unknown } = {},
	): Promise<Response> {
		const { params, extraHeaders, signal, body, operation } = opts;
		const url = buildUrl(this.apiUrl, path, params);
		const headers = buildHeaders(this.agentHeader, extraHeaders, body);

		const ac = new AbortController();
		const timeoutId = setTimeout(() => ac.abort(), this.timeout);
		const fetchSignal = signal ? anySignal(signal, ac.signal) : ac.signal;

		if (operation === undefined) {
			throw new Error(
				`SDKHttpClient.${method.toLowerCase()}(${path}) was called without opts.operation — every resource method must set a RineOperation label.`,
			);
		}

		const ctx: RequestContext = {
			method,
			url,
			headers: new Headers(headers),
			body,
			signal: fetchSignal,
			operation,
			transport: "rest",
		};
		callMeta.set(ctx, { unauthenticated: opts.unauthenticated === true });

		try {
			const res = await this.pipeline(ctx);
			clearTimeout(timeoutId);

			if (!res.ok) {
				const detail = await parseErrorDetail(res);
				raiseForStatus(res.status, detail, res);
			}

			return res;
		} catch (err) {
			clearTimeout(timeoutId);
			if (err instanceof Error && err.name === "AbortError") {
				if (signal?.aborted) {
					if (signal.reason instanceof RineTimeoutError) throw signal.reason;
					throw err;
				}
				throw new RineTimeoutError(
					`Request to ${method} ${path} timed out after ${this.timeout}ms`,
				);
			}
			throw err;
		}
	}

	/**
	 * Build the innermost "core" transport function handed to
	 * `composeMiddleware`. It reads from `ctx` *after* middleware has run
	 * so header mutations (auth, tracing, redact) take effect on the wire.
	 *
	 * Core handles auth injection + 401 refresh — these are transport
	 * concerns (Dec-3.1), so middleware sees one logical call, not per-retry
	 * attempts.
	 */
	private createCoreRequest(): (ctx: RequestContext) => Promise<Response> {
		return async (ctx: RequestContext) => {
			const meta = callMeta.get(ctx);
			const unauthenticated = meta?.unauthenticated === true;
			const headers = headersToRecord(ctx.headers);
			const serializedBody = serializeBody(ctx.body);
			return this.fetchWithAuth(
				ctx.method,
				ctx.url,
				headers,
				serializedBody,
				ctx.signal,
				unauthenticated,
			);
		};
	}

	private async fetchWithAuth(
		method: string,
		url: string,
		headers: Record<string, string>,
		body: string | undefined,
		fetchSignal: AbortSignal,
		unauthenticated: boolean,
	): Promise<Response> {
		const doFetch = async (): Promise<Response> => {
			if (unauthenticated) {
				return fetch(url, { method, headers, body, signal: fetchSignal });
			}

			const creds = loadCredentials(this._configDir).default;
			const token = await getOrRefreshToken(
				this._configDir,
				this.apiUrl,
				creds,
				"default",
				{ refreshMargin: this._refreshMargin },
			);
			headers.Authorization = `Bearer ${token}`;
			const res = await fetch(url, {
				method,
				headers,
				body,
				signal: fetchSignal,
			});

			// 401 → retry once (token might have just expired)
			if (res.status === 401) {
				const tokenRetry = await getOrRefreshToken(
					this._configDir,
					this.apiUrl,
					creds,
					"default",
					{ force: true },
				);
				headers.Authorization = `Bearer ${tokenRetry}`;
				return fetch(url, {
					method,
					headers,
					body,
					signal: fetchSignal,
				});
			}

			return res;
		};

		// 429 → honor Retry-After, backoff capped at 30s, cap at `maxRetries`
		// attempts. The 401 refresh branch inside `doFetch` is
		// independent of this loop: a refresh success returns directly and
		// does not consume a retry slot, matching the "one transport, one
		// logical call" principle that keeps middleware simple.
		let attempt = 0;
		while (true) {
			const res = await doFetch();
			if (res.status !== 429 || attempt >= this.maxRetries) {
				return res;
			}
			attempt += 1;
			const delayMs = parseRetryAfter(res.headers.get("Retry-After"), attempt);
			if (fetchSignal.aborted) return res;
			await sleepWithSignal(delayMs, fetchSignal);
		}
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Per-call metadata stashed outside the public `RequestContext` shape.
 * Keyed on the ctx via a WeakMap so GC cleans up after the call finishes.
 * Middleware authors can't accidentally depend on this — it's pure
 * transport bookkeeping.
 */
interface CallMeta {
	readonly unauthenticated: boolean;
}
const callMeta = new WeakMap<RequestContext, CallMeta>();

function buildUrl(
	baseUrl: string,
	path: string,
	params?: Record<string, string | number | boolean | undefined>,
): string {
	// Absolute URLs (e.g. poll_url from credentials) bypass base URL prepend.
	let url =
		path.startsWith("http://") || path.startsWith("https://")
			? path
			: baseUrl + path;
	if (params) {
		const qs = new URLSearchParams(
			Object.entries(params)
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => [k, String(v)]),
		).toString();
		if (qs) url += `?${qs}`;
	}
	return url;
}

function buildHeaders(
	agentHeader: Record<string, string> | undefined,
	extraHeaders: Record<string, string> | undefined,
	body?: unknown,
): Record<string, string> {
	const headers: Record<string, string> = {
		...(agentHeader ?? {}),
		...(extraHeaders ?? {}),
	};
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	return headers;
}

function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}

function serializeBody(body: unknown): string | undefined {
	if (body === undefined) return undefined;
	return JSON.stringify(body);
}

async function parseErrorDetail(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { detail?: string | unknown[] };
		if (typeof body.detail === "string") return body.detail;
		if (Array.isArray(body.detail)) {
			return body.detail
				.map((e) => (typeof e === "string" ? e : (e as { msg: string }).msg))
				.join("; ");
		}
	} catch {
		// ignore parse failures
	}
	return res.statusText;
}

/**
 * Parse the `Retry-After` response header and pick a delay, capped at 30s.
 * Supports both numeric "seconds" and RFC 7231 HTTP-date forms;
 * falls back to exponential backoff (1s, 2s, 4s, ...) keyed on the attempt
 * counter when the server omits or emits an unparseable value.
 */
function parseRetryAfter(header: string | null, attempt: number): number {
	const MAX_DELAY_MS = 30_000;
	const fallback = Math.min(MAX_DELAY_MS, 2 ** (attempt - 1) * 1000);
	if (!header) return fallback;
	const asNumber = Number(header);
	if (Number.isFinite(asNumber) && asNumber >= 0) {
		return Math.min(MAX_DELAY_MS, asNumber * 1000);
	}
	const asDate = Date.parse(header);
	if (!Number.isNaN(asDate)) {
		return Math.max(0, Math.min(MAX_DELAY_MS, asDate - Date.now()));
	}
	return fallback;
}

