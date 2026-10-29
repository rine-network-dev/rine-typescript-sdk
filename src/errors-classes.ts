/**
 * The Rine SDK's error types — the whole hierarchy, and nothing that decides
 * when one is raised.
 *
 * Every class here descends from {@link RineError}, so `catch (e) { if (e
 * instanceof RineError) … }` catches the entire SDK surface. Which class an
 * HTTP response maps to is a separate question, answered by `raiseForStatus`
 * in `./errors.js`; that module is the one consumers and this package's own
 * code import, and it re-exports all of these.
 *
 * The split runs this way round on purpose. A class hierarchy cannot be spread
 * across two modules that import each other — the derived classes evaluate
 * `extends` at module scope, so a cycle leaves the base uninitialised. Keeping
 * the declarations in a leaf module and the dispatch above them is the only
 * arrangement with no cycle at all.
 *
 * Three of the SDK's refusals are minted by `rine-core` rather than declared
 * here — the two group-send guards and the group-identity refusal, each of
 * which exists once for the CLI, the MCP server and this SDK precisely so no
 * surface restates them. {@link RineError} recognises all three as its own;
 * `./errors-core-refusals.js` holds that mechanism and the reasoning behind it.
 */

import type { RevokedScope } from "@rine-network/core";
import { isRineErrorInstance } from "./errors-core-refusals.js";

// ---------------------------------------------------------------------------
// Base classes
// ---------------------------------------------------------------------------

/**
 * Base exception for all Rine SDK errors.
 *
 * `catch (e) { if (e instanceof RineError) … }` catches the entire SDK
 * surface, including the three refusals `rine-core` mints — see
 * `./errors-core-refusals.js` for why they are not declared here.
 */
export class RineError extends Error {
	static override [Symbol.hasInstance](
		this: { prototype: object },
		value: unknown,
	): boolean {
		return isRineErrorInstance(RineError, this, value);
	}

	constructor(message: string) {
		super(message);
		this.name = "RineError";
	}
}

/** HTTP API error with status code and detail. */
export class RineApiError extends RineError {
	/**
	 * The server's machine-readable error code — the `error` member of a rine
	 * error body, e.g. `not_in_electorate`. Undefined when the response carried
	 * none, or when the error was constructed by hand.
	 *
	 * Branch on this, never on `detail`: the detail is a sentence written for an
	 * operator and it is rewritten whenever the wording improves. It is set by
	 * `raiseForStatus` after construction rather than taken as a parameter
	 * because every subclass here declares its own `(detail, raw)` constructor,
	 * and threading a third argument through all eleven of them would change the
	 * public shape of each one to carry a value only the HTTP layer ever knows.
	 */
	code?: string;

	constructor(
		public readonly status: number,
		public readonly detail: string,
		public readonly raw?: unknown,
	) {
		super(`${status}: ${detail}`);
		this.name = "RineApiError";
	}
}

// ---------------------------------------------------------------------------
// HTTP status error subclasses
// ---------------------------------------------------------------------------

/** 401 — invalid or missing credentials. */
export class AuthenticationError extends RineApiError {
	constructor(detail = "Authentication failed", raw?: unknown) {
		super(401, detail, raw);
		this.name = "AuthenticationError";
	}
}

/**
 * 401 — the server refused the caller because its agent or its branch is revoked.
 *
 * Retrying cannot help and the credentials are not at fault: the principal itself
 * was revoked. The server names the scope on a bearer route (always) and on the
 * token mint (only once the key assertion verified, so the answer never reveals a
 * revocation to a stranger). An `AuthenticationError`, so a caller already
 * catching a refused login still catches it.
 */
export class PrincipalRevokedError extends AuthenticationError {
	constructor(
		public readonly scope: RevokedScope,
		detail = "The principal is revoked",
		raw?: unknown,
	) {
		super(detail, raw);
		this.name = "PrincipalRevokedError";
	}
}

/** 403 — insufficient permissions for the requested operation. */
export class AuthorizationError extends RineApiError {
	constructor(detail = "Permission denied", raw?: unknown) {
		super(403, detail, raw);
		this.name = "AuthorizationError";
	}
}

/** 404 — the requested resource was not found. */
export class NotFoundError extends RineApiError {
	constructor(detail = "Resource not found", raw?: unknown) {
		super(404, detail, raw);
		this.name = "NotFoundError";
	}
}

/** 409 — resource conflict (e.g., duplicate slug or agent name). */
export class ConflictError extends RineApiError {
	constructor(detail = "Conflict", raw?: unknown) {
		super(409, detail, raw);
		this.name = "ConflictError";
	}
}

/** 429 — rate limit exceeded. */
export class RateLimitError extends RineApiError {
	public readonly retryAfter: number | undefined;

	constructor(detail: string, retryAfter?: number, raw?: unknown) {
		super(429, detail, raw);
		this.name = "RateLimitError";
		this.retryAfter = retryAfter;
	}
}

/** 422 — request validation failed. */
export class ValidationError extends RineApiError {
	constructor(detail = "Validation error", raw?: unknown) {
		super(422, detail, raw);
		this.name = "ValidationError";
	}
}

/** 500 — unexpected server error. */
export class InternalServerError extends RineApiError {
	constructor(detail = "Internal server error", raw?: unknown) {
		super(500, detail, raw);
		this.name = "InternalServerError";
	}
}

/** 503 — service temporarily unavailable. */
export class ServiceUnavailableError extends RineApiError {
	constructor(detail = "Service unavailable", raw?: unknown) {
		super(503, detail, raw);
		this.name = "ServiceUnavailableError";
	}
}

// ---------------------------------------------------------------------------
// Transport / infrastructure errors
// ---------------------------------------------------------------------------

/** Request timed out — the server did not respond in time. */
export class RineTimeoutError extends RineError {
	constructor(message = "Request timed out") {
		super(message);
		this.name = "RineTimeoutError";
	}
}

/** Network-level failure — could not reach the server. */
export class APIConnectionError extends RineError {
	override cause?: unknown;

	constructor(message = "Connection failed", cause?: unknown) {
		super(message);
		this.name = "APIConnectionError";
		this.cause = cause;
	}
}

/** Encryption or decryption failure. */
export class CryptoError extends RineError {
	override cause?: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "CryptoError";
		this.cause = cause;
	}
}

/** Missing or invalid SDK configuration. */
export class ConfigError extends RineError {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/** Client-side schema validation failure (Standard Schema v1). */
export class SchemaValidationError extends RineError {
	constructor(message: string) {
		super(message);
		this.name = "SchemaValidationError";
	}
}

/**
 * A reply would be filed from an agent the original was not addressed to.
 *
 * Thrown client-side, before anything is encrypted or sent. A reply is
 * attributed to the agent that acts, so answering as a sibling of the addressee
 * files it from an agent the message never reached — and that agent holds no key
 * that opens what it is answering, so the far side receives a reply it cannot
 * tie to the message it wrote.
 *
 * `GET /messages/{id}` is authorised for the ORG, which is why every one of an
 * org's agents can reach the row and why this comparison is the client's own to
 * make. The three ids are carried as fields, not only in the sentence, so a
 * caller can retry as the addressee without parsing prose — the Python SDK's
 * `ReplyAttributionError` holds the same three.
 */
export class ReplyAttributionError extends RineError {
	constructor(
		public readonly messageId: string,
		public readonly actingAgentId: string,
		public readonly addresseeAgentId: string,
	) {
		super(
			`Cannot reply to message ${messageId} as agent ${actingAgentId}: it was addressed to agent ${addresseeAgentId}. Reply as that agent (opts.agent), or send a new message to start your own conversation.`,
		);
		this.name = "ReplyAttributionError";
	}
}

/**
 * A read answered about a different group than the one it asked for.
 *
 * Re-exported, not declared: this package once declared a SECOND class of the
 * same name, and narrowing to either one missed half the throws. The
 * reasoning lives on the declaration in `rine-core`, and how a re-exported
 * class is still recognised as a `RineError` is in `./errors-core-refusals.ts`
 * — a JSDoc block here reaches no consumer anyway (the declaration's own doc is
 * what `dist/index.d.ts` carries), so keeping a third copy only creates one
 * more place for it to go stale.
 */
export { GroupIdentityMismatchError, RevokedScope } from "@rine-network/core";
