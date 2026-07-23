/**
 * Standalone org registration.
 *
 * Module-level function (not a client method) because credentials don't
 * exist yet at registration time. Delegates to rine-core's
 * `performRegistration` for the PoW + credential persistence flow.
 */

import {
	performRegistration,
	validateSlug,
} from "@rine-network/core";
import {
	ConflictError,
	RateLimitError,
	RineError,
	ValidationError,
} from "./errors.js";

// Re-export validateSlug so SDK consumers don't need rine-core.
export { validateSlug };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterOptions {
	/** API base URL (e.g. "https://rine.network"). */
	apiUrl: string;
	/** Path to the rine config directory for credential persistence. */
	configDir: string;
	/** Registration email address. */
	email: string;
	/** Organisation slug (validated client-side via `validateSlug`). */
	slug: string;
	/** Organisation display name. */
	name: string;
	/** Optional PoW progress callback — called with 0-100. */
	onProgress?: (pct: number) => void;
}

/** Returned on successful registration. */
export interface RegistrationResult {
	orgId: string;
	clientId: string;
}

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

/**
 * Register a new org on the Rine network.
 *
 * Solves the RSA time-lock proof-of-work, saves credentials to
 * `{configDir}/credentials.json`, and caches the initial OAuth token.
 *
 * @throws {ValidationError} If the slug fails client-side validation.
 * @throws {ConflictError} If the email or slug is already registered.
 * @throws {RateLimitError} On 429 from the server.
 * @throws {RineError} On PoW challenge expiry or other failures.
 */
export async function register(opts: RegisterOptions): Promise<RegistrationResult> {
	if (!validateSlug(opts.slug)) {
		throw new ValidationError(
			`Invalid slug "${opts.slug}" — must be 2-32 lowercase alphanumeric chars or hyphens, no leading/trailing hyphen.`,
		);
	}

	try {
		const result = await performRegistration(
			opts.apiUrl,
			opts.configDir,
			"default",
			{ email: opts.email, slug: opts.slug, name: opts.name },
			opts.onProgress,
		);
		return { orgId: result.org_id, clientId: result.client_id };
	} catch (err) {
		// Map rine-core's generic Error messages to SDK typed errors.
		if (err instanceof Error) {
			const msg = err.message;
			if (msg.includes("already registered") || msg.includes("Conflict")) {
				throw new ConflictError(msg);
			}
			if (msg.includes("Rate limited")) {
				throw new RateLimitError(msg);
			}
			if (msg.includes("expired")) {
				throw new RineError(msg);
			}
		}
		throw err;
	}
}
