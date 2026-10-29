/**
 * The out-of-band onboarding flow shared by the framework connectors' `onboard`
 * commands (`@rine-network/eve`, `@rine-network/mastra`).
 *
 * A ~30-60 s proof-of-work does not belong in an LLM turn, so this is a one-time
 * command a human runs, never a tool. The org root and the 24-word recovery phrase
 * land in the owner dir, apart from the runtime config dir the agent reads; only
 * the phrase file's path is printed, never the words. A connector supplies only
 * its own closing lines (how to point its runtime at the new identity).
 */

import { dirname } from "node:path";
import {
	PHRASE_INSTRUCTION,
	compareVerificationWordsForAgent,
	ownerDirNotice,
	resolveApiUrl,
	resolveConfigDir,
	verificationWordsLines,
} from "@rine-network/core";
import { AsyncRineClient } from "./client.js";
import { register } from "./onboard.js";

/** What the flow needs to register an org and create its first agent. */
export interface OnboardOptions {
	email: string;
	slug: string;
	name: string;
	/** API base URL; when omitted, `resolveApiUrl()` is used. */
	apiUrl?: string;
	/** Runtime config dir (profile, agent keys, token cache); `resolveConfigDir()` if omitted. */
	configDir?: string;
	/** Owner dir for `root.key` and the recovery phrase; the library default if omitted. */
	ownerDir?: string;
	/**
	 * Handle-safe first-agent name (handle local-part); defaults to
	 * {@link agentNameFromOrgName}(`name`, `slug`). A free-form `name` like
	 * "My Org" is invalid verbatim (the server rejects uppercase and spaces).
	 */
	agentName?: string;
}

/** Where the flow writes its progress and output. */
export interface OnboardIO {
	log: (line: string) => void;
	/** Where usage errors go; `log` when omitted. */
	error?: (line: string) => void;
}

/** The default {@link OnboardIO}: one line per call on stdout. */
export const stdoutOnboardIO: OnboardIO = {
	log: (line) => process.stdout.write(`${line}\n`),
};

/**
 * Derive a server-valid agent name (handle local-part: 1-200 lowercase alnum +
 * interior hyphens) from a free-form display name; fall back to `slug` if empty.
 */
export function agentNameFromOrgName(name: string, slug: string): string {
	const derived = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 200)
		.replace(/-+$/g, "");
	return derived.length > 0 ? derived : slug;
}

/**
 * Register a fresh org (RSA proof-of-work), create its first agent, print the handle
 * and verification words, then `closingLines`. Returns the new agent's handle. Errors
 * propagate: a failed onboarding should exit non-zero.
 */
export async function runOnboardFlow(
	opts: OnboardOptions,
	closingLines: readonly string[],
	io: OnboardIO = stdoutOnboardIO,
): Promise<string> {
	const apiUrl = opts.apiUrl ?? resolveApiUrl();
	const configDir = opts.configDir ?? resolveConfigDir();

	io.log(`Onboarding org "${opts.slug}" at ${apiUrl} …`);
	io.log("Solving registration proof-of-work (this takes ~30–60 s) …");

	let lastPct = -1;
	const registration = await register({
		apiUrl,
		configDir,
		ownerDir: opts.ownerDir,
		email: opts.email,
		slug: opts.slug,
		name: opts.name,
		onProgress: (pct) => {
			const whole = Math.floor(pct);
			if (whole > lastPct) {
				lastPct = whole;
				io.log(`  proof-of-work ${whole}%`);
			}
		},
	});

	io.log("Registered. Creating your first agent …");
	const client = new AsyncRineClient({
		configDir,
		apiUrl,
		ownerDir: opts.ownerDir,
	});
	const agentName = opts.agentName ?? agentNameFromOrgName(opts.name, opts.slug);
	const agent = await client.createAgent(agentName);

	io.log("");
	io.log(`Agent ready: ${agent.handle}`);
	// Derived from the signing key just written to this config dir, never from
	// the string the server returned with the agent.
	for (const line of verificationWordsLines(
		compareVerificationWordsForAgent(
			configDir,
			agent.id,
			agent.verification_words,
		),
	)) {
		io.log(line);
	}
	io.log(`Org ${registration.orgId}, verification words: ${registration.orgWords}`);
	io.log(`Recovery phrase file: ${registration.phrasePath}`);
	io.log(PHRASE_INSTRUCTION);
	io.log(`Config dir: ${configDir}`);
	io.log(ownerDirNotice(dirname(registration.phrasePath)));
	for (const line of closingLines) io.log(line);
	return agent.handle;
}
