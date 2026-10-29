/**
 * The SDK's error entry point: the type hierarchy, re-exported, plus the rule
 * that decides which of those types an HTTP response raises.
 *
 * All error classes are compatible with the `raiseForStatus()` pattern and are
 * declared in `./errors-classes.js` — importing them from here is the same
 * thing, and stays the same thing. The declarations sit in their own module
 * because the two halves answer different questions and because a class
 * hierarchy split the other way round would import itself in a cycle; that
 * module's own docstring carries the reasoning.
 */

import {
	PrincipalRevokedError as CorePrincipalRevokedError,
	scopeOfRevokedCode,
} from "@rine-network/core";
import {
	AuthenticationError,
	AuthorizationError,
	ConflictError,
	InternalServerError,
	NotFoundError,
	PrincipalRevokedError,
	RateLimitError,
	RineApiError,
	ServiceUnavailableError,
	ValidationError,
} from "./errors-classes.js";

// Everything declared there is part of this module's surface: `./errors.js`
// is the import path the SDK and its consumers use for every error type.
export * from "./errors-classes.js";

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
 * @param code  - The server's machine-readable error code, when it sent one.
 */
export function raiseForStatus(
	status: number,
	detail: string,
	raw?: unknown,
	code?: string,
): never {
	const err = errorForStatus(status, detail, raw, code);
	// Carried so a caller can branch on WHICH refusal this is — two 403s on the
	// same route mean different things (`not_in_electorate` vs a plain
	// membership refusal) and the only alternative is matching on the sentence.
	if (code) err.code = code;
	throw err;
}

/** The error class this status maps to, built but not yet thrown. */
function errorForStatus(
	status: number,
	detail: string,
	raw?: unknown,
	code?: string,
): RineApiError {
	// A bearer route names a revoked principal in the error code, and only a 401
	// does; the token mint names it in `reason`, which the SDK's token path maps
	// on its own.
	const scope = status === 401 ? scopeOfRevokedCode(code) : undefined;
	if (scope !== undefined) return new PrincipalRevokedError(scope, detail, raw);
	if (status === 429) {
		// RateLimitError has an extra retryAfter field parsed from the response headers
		const retryAfter = (raw as Response | undefined)?.headers?.get(
			"retry-after",
		)
			? Number.parseInt((raw as Response).headers.get("retry-after")!, 10)
			: undefined;
		return new RateLimitError(detail, retryAfter, raw);
	}
	const cls = STATUS_MAP.get(status);
	if (cls) return new cls(detail, raw);
	return new RineApiError(status, detail, raw);
}

/**
 * The SDK's own error for a revoked-principal refusal that `rine-core` raised from
 * the token mint, so a request the SDK makes itself raises one class whichever
 * route refused. Any other error comes back as it is. The parsed body is not
 * copied: the SDK's `RineApiError` has no `body` member.
 *
 * Operations the SDK delegates to `rine-core` raise core's own class, like every
 * other core refusal; `isPrincipalRevokedError` answers true for both.
 */
export function sdkErrorFromCore(error: unknown): unknown {
	if (!(error instanceof CorePrincipalRevokedError)) return error;
	const revoked = new PrincipalRevokedError(error.scope, error.detail, error.raw);
	if (error.code !== undefined) revoked.code = error.code;
	return revoked;
}

/**
 * The server's error code for `err`, or `undefined` for anything else.
 *
 * The one way to ask "which refusal is this?" without matching on the operator
 * sentence in `detail`. Codes are stable; that sentence is not.
 */
export function rineErrorCode(err: unknown): string | undefined {
	return err instanceof RineApiError ? err.code : undefined;
}
