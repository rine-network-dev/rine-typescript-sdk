/**
 * Typed error hierarchy for the Rine SDK.
 *
 * Mirrors the Python SDK error hierarchy (rine/errors.py) but adapted for TypeScript.
 * All error classes are compatible with the `raiseForStatus()` pattern.
 */

// ---------------------------------------------------------------------------
// Base classes
// ---------------------------------------------------------------------------

/** Base exception for all Rine SDK errors. */
export class RineError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RineError";
	}
}

/** HTTP API error with status code and detail. */
export class RineApiError extends RineError {
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

// ---------------------------------------------------------------------------
// Status → Error class mapping
// ---------------------------------------------------------------------------

const STATUS_MAP: Map<
	number,
	new (
		detail: string,
		raw?: unknown,
	) => RineApiError
> = new Map([
	[401, AuthenticationError],
	[403, AuthorizationError],
	[404, NotFoundError],
	[409, ConflictError],
	[422, ValidationError],
	[500, InternalServerError],
	[503, ServiceUnavailableError],
]);

/**
 * Raise the appropriate error class for an HTTP status code.
 *
 * @param status - HTTP status code.
 * @param detail - Error detail string from the server.
 * @param raw   - Optional raw response body for debugging.
 */
export function raiseForStatus(
	status: number,
	detail: string,
	raw?: unknown,
): never {
	if (status === 429) {
		// RateLimitError has an extra retryAfter field parsed from the response headers
		const retryAfter = (raw as Response | undefined)?.headers?.get(
			"retry-after",
		)
			? Number.parseInt((raw as Response).headers.get("retry-after")!, 10)
			: undefined;
		throw new RateLimitError(detail, retryAfter, raw);
	}
	const cls = STATUS_MAP.get(status);
	if (cls) throw new cls(detail, raw);
	throw new RineApiError(status, detail, raw);
}
