/**
 * Standalone org registration.
 *
 * Module-level function (not a client method) because no identity
 * exists yet at registration time. Delegates to rine-core's
 * `performRegistration` for the PoW, root-key minting and persistence flow.
 */

import {
	DEFAULT_PROFILE,
	performRegistration,
	resolveOwnerDir,
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
	/** The runtime config directory (profiles, agent keys, token cache). */
	configDir: string;
	/**
	 * The owner directory that receives `root.key` and the recovery phrase. Defaults to
	 * `$RINE_OWNER_DIR` or `~/.config/rine-owner/`; refused inside a git checkout.
	 */
	ownerDir?: string;
	/** Profile name for the org profile (default `default`). */
	profile?: string;
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
	/** The 8 org verification words. Safe to print: they are not the phrase. */
	orgWords: string;
	/** Where the 24-word recovery phrase was written. The phrase is never returned. */
	phrasePath: string;
}

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

/**
 * Register a new org on the Rine network.
 *
 * Mints the org root key, solves the RSA time-lock proof-of-work, registers
 * the org's public keys, and writes `root.key`, the recovery phrase and the org
 * profile to the owner directory. The phrase is the only copy: back it up.
 *
 * @throws {ValidationError} If the slug fails client-side validation.
 * @throws {ConflictError} If the email, slug or org id is already registered.
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
			{ configDir: opts.configDir, ownerDir: opts.ownerDir ?? resolveOwnerDir() },
			opts.profile ?? DEFAULT_PROFILE,
			{ email: opts.email, slug: opts.slug, name: opts.name },
			opts.onProgress,
		);
		return {
			orgId: result.org_id,
			orgWords: result.org_words,
			phrasePath: result.phrase_path,
		};
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
