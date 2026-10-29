/**
 * The shared onboarding flow behind the connectors' `onboard` commands.
 *
 * The words printed come from the signing key in the config dir, never from the
 * string the server returned with the agent: the fixture writes REAL keys and
 * derives the expected string from them, since a test that asserted the server's
 * own answer back would pass whatever the flow did with it. The proof-of-work
 * and agent-creation boundary is mocked at this package's own module edges so
 * the test never runs a ~30-60 s proof-of-work.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	PHRASE_INSTRUCTION,
	ownerDirNotice,
	saveAgentKeys,
	verificationWordsForKey,
} from "@rine-network/core";
import { derivedAgentKeys } from "@rine-network/core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const register = vi.fn();
const createAgent = vi.fn();

vi.mock("./onboard.js", () => ({ register }));
vi.mock("./client.js", () => ({
	AsyncRineClient: class {
		createAgent = createAgent;
	},
}));

const { runOnboardFlow } = await import("./onboard-runner.js");

const AGENT_ID = "11111111-2222-3333-4444-555555555555";
/** What `register` returns: the phrase's PATH, never its words. */
const REGISTRATION = {
	orgId: "org-1",
	orgWords: "alpha bravo charlie delta echo foxtrot golf hotel",
	phrasePath: "/owner/recovery-phrase.txt",
};
const CLOSING = ["Closing line one.", "Closing line two."];

let configDir: string;
let ownWords: string;

/** Collect printed lines instead of writing to stdout. */
function makeIO() {
	const lines: string[] = [];
	return { io: { log: (l: string) => lines.push(l) }, lines };
}

beforeEach(() => {
	configDir = fs.mkdtempSync(join(tmpdir(), "rine-sdk-onboard-"));
	const keys = derivedAgentKeys(AGENT_ID);
	saveAgentKeys(configDir, AGENT_ID, keys);
	ownWords = verificationWordsForKey(keys.signing.publicKey);

	register.mockReset();
	createAgent.mockReset();
	register.mockResolvedValue(REGISTRATION);
	createAgent.mockResolvedValue({
		id: AGENT_ID,
		handle: "support@acme.rine.network",
		name: "Support",
		verification_words: ownWords,
	});
});

afterEach(() => {
	vi.clearAllMocks();
	fs.rmSync(configDir, { recursive: true, force: true });
});

describe("runOnboardFlow — orchestration (PoW/register boundary mocked)", () => {
	it("registers with explicit overrides, creates the agent, prints handle + words", async () => {
		const { io, lines } = makeIO();
		const handle = await runOnboardFlow(
			{
				email: "a@b.co",
				slug: "acme",
				name: "Support",
				apiUrl: "https://test.rine",
				configDir,
				ownerDir: "/tmp/owner",
			},
			CLOSING,
			io,
		);

		expect(handle).toBe("support@acme.rine.network");

		// register() got the resolved overrides + a progress callback.
		expect(register).toHaveBeenCalledTimes(1);
		const regArg = register.mock.calls[0]?.[0];
		expect(regArg).toMatchObject({
			email: "a@b.co",
			slug: "acme",
			name: "Support",
			apiUrl: "https://test.rine",
			configDir,
			ownerDir: "/tmp/owner",
		});
		expect(typeof regArg.onProgress).toBe("function");

		// createAgent ran with the handle-safe name DERIVED from the display name
		// ("Support" → "support") — the server rejects uppercase/spaces.
		expect(createAgent).toHaveBeenCalledWith("support");

		// The handle + verification words reached stdout.
		const out = lines.join("\n");
		expect(out).toContain("Agent ready: support@acme.rine.network");
		expect(out).toContain(`Verification words: ${ownWords}`);
		// The org's words and the phrase FILE's path are printed with the owner's
		// instruction; the phrase itself is never in the register result.
		expect(out).toContain(REGISTRATION.orgWords);
		expect(out).toContain(`Recovery phrase file: ${REGISTRATION.phrasePath}`);
		expect(out).toContain(PHRASE_INSTRUCTION);
		// The owner dir is named, with the warning that a host reading it acts as the org.
		expect(out).toContain(ownerDirNotice(dirname(REGISTRATION.phrasePath)));
	});

	it("derives a handle-safe agent name from a free-form display name (regression)", async () => {
		const { io } = makeIO();
		await runOnboardFlow(
			{
				email: "a@b.co",
				slug: "my-org",
				name: "My Org",
				configDir,
			},
			CLOSING,
			io,
		);
		// The org display name ("My Org") is NOT a valid agent name; the first
		// agent is created with the derived handle-safe form, while register()
		// still receives the human display name.
		expect(createAgent).toHaveBeenCalledWith("my-org");
		expect(register.mock.calls[0]?.[0]).toMatchObject({ name: "My Org" });
	});

	it("uses an explicit agentName override verbatim", async () => {
		const { io } = makeIO();
		await runOnboardFlow(
			{
				email: "a@b.co",
				slug: "acme",
				name: "Acme Inc",
				agentName: "coordinator",
				configDir,
			},
			CLOSING,
			io,
		);
		expect(createAgent).toHaveBeenCalledWith("coordinator");
	});

	it("forwards progress percentages to the IO as whole-percent lines", async () => {
		register.mockImplementation(
			async (opts: { onProgress?: (p: number) => void }) => {
				opts.onProgress?.(0);
				opts.onProgress?.(49.7);
				opts.onProgress?.(100);
				return REGISTRATION;
			},
		);
		const { io, lines } = makeIO();
		await runOnboardFlow(
			{ email: "a@b.co", slug: "acme", name: "Support", configDir },
			CLOSING,
			io,
		);
		const out = lines.join("\n");
		expect(out).toContain("proof-of-work 0%");
		expect(out).toContain("proof-of-work 49%");
		expect(out).toContain("proof-of-work 100%");
	});

	it("still prints its own words when the server names none", async () => {
		createAgent.mockResolvedValue({
			id: AGENT_ID,
			handle: "support@acme.rine.network",
			name: "Support",
			verification_words: null,
		});
		const { io, lines } = makeIO();
		await runOnboardFlow(
			{ email: "a@b.co", slug: "acme", name: "Support", configDir },
			CLOSING,
			io,
		);
		const out = lines.join("\n");
		expect(out).toContain(`Verification words: ${ownWords}`);
		expect(out).toContain("nothing to compare");
	});

	it("renders BOTH values when the server asserts different words", async () => {
		createAgent.mockResolvedValue({
			id: AGENT_ID,
			handle: "support@acme.rine.network",
			name: "Support",
			verification_words: "abandon ability able about above",
		});
		const { io, lines } = makeIO();
		await runOnboardFlow(
			{ email: "a@b.co", slug: "acme", name: "Support", configDir },
			CLOSING,
			io,
		);
		const out = lines.join("\n");
		expect(out).toContain(`Verification words (this client): ${ownWords}`);
		expect(out).toContain("abandon ability able about above");
		expect(out).toContain("Messages still send and arrive");
	});

	it("says so rather than echoing the server's string when it holds no key", async () => {
		createAgent.mockResolvedValue({
			id: "99999999-9999-9999-9999-999999999999",
			handle: "support@acme.rine.network",
			name: "Support",
			verification_words: "abandon ability able about above",
		});
		const { io, lines } = makeIO();
		await runOnboardFlow(
			{ email: "a@b.co", slug: "acme", name: "Support", configDir },
			CLOSING,
			io,
		);
		const out = lines.join("\n");
		expect(out).toContain(
			"Verification words (server): abandon ability able about above",
		);
		expect(out).toContain("Not recomputed here");
	});
});

it("prints the caller's closing lines last", async () => {
	const { io, lines } = makeIO();
	await runOnboardFlow(
		{ email: "a@b.co", slug: "acme", name: "Support", configDir },
		CLOSING,
		io,
	);
	expect(lines.slice(-2)).toEqual(CLOSING);
});
