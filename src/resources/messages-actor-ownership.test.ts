/**
 * An acting agent must be an agent this org owns — proven at the SDK boundary.
 *
 * 🔴 This file mocks NOTHING of `@rine-network/core`'s resolution. Every other
 * suite here stubs `fetchAgents`/`resolveAgent` to a fixed id so it can get on
 * with testing something else, which means none of them can see what a caller
 * is told when the agent they named is not one of ours. The only stub is the
 * HTTP layer, so `GET /agents` answers and the whole ladder above it runs for
 * real, through `MessagesResource`, from the option an SDK caller passes.
 *
 * `inbox()` is the verb under test because it is the shortest path from
 * `opts.agent` to a resolved id: `resolveSenderId` → `fetchAgents` →
 * `resolveAgent`, then one GET. `rine-mastra` and `rine-eve` reach this exact
 * rung through `withAgent`/`opts.agent`, so this is their coverage too.
 *
 * What used to happen, and is what these tests exist to keep from returning: a
 * handle went to `resolveToUuid` — unauthenticated WebFinger, which asks the
 * world who owns a handle. A miss threw *"Ensure WebFinger is available or use
 * a UUID"*, naming no agent; a hit for another org's handle came back with an
 * id this caller has no keys for.
 */

import { describe, expect, it, vi } from "vitest";
import { MessagesResource } from "./messages.js";
import type { SDKHttpClient } from "../api/http.js";

const OPS_ID = "11111111-1111-4111-8111-111111111111";
const BOT_ID = "22222222-2222-4222-8222-222222222222";

const OPS = { id: OPS_ID, name: "ops", handle: "ops@acme.rine.network" };
const BOT = { id: BOT_ID, name: "bot", handle: "bot@acme.rine.network" };

interface Harness {
	messages: MessagesResource;
	/** The core HTTP client the resource resolves through. */
	core: { get: ReturnType<typeof vi.fn> };
	/** Every path the SDK layer fetched, in order. */
	paths: string[];
	/** Every path the core layer fetched — where `GET /agents` lands. */
	corePaths: string[];
	/** The acting agent each SDK-layer request declared. */
	actors: (string | undefined)[];
}

/** A client whose org holds exactly the agents given, and nothing else. */
function makeHarness(agents: object[]): Harness {
	const paths: string[] = [];
	const corePaths: string[] = [];
	const actors: (string | undefined)[] = [];
	const core = {
		get: vi.fn(async (path: string) => {
			corePaths.push(path);
			return { items: agents, total: agents.length };
		}),
	};
	const http = {
		apiUrl: "https://api.test.rine.network",
		configDir: "/tmp/rine-actor-ownership",
		timeout: 30_000,
		getCoreHttpClient: () => core,
		async get<T>(path: string, opts?: Record<string, unknown>): Promise<T> {
			paths.push(path);
			const headers = opts?.extraHeaders as Record<string, string> | undefined;
			actors.push(headers?.["X-Rine-Agent"]);
			return { items: [], total: 0 } as T;
		},
	} as unknown as SDKHttpClient;
	return { messages: new MessagesResource(http), core, paths, corePaths, actors };
}

/**
 * The clause every actor refusal on this surface ends with, and the one that
 * says why a choice is being asked for at all. Both are only ever rendered
 * over a roster of two or more now — a one-agent org acts instead of
 * refusing — and `agent` is named without a bracketed slot because this stack
 * reads no environment and has no flag.
 */
const MULTI =
	"This org has more than one agent, so a call has to name one. Available agents:";
const CHOOSE = "Name one of them with agent.";

describe("the agent an SDK call acts as", () => {
	it("takes a handle of this org and acts as the agent it names", async () => {
		const h = makeHarness([OPS, BOT]);

		await h.messages.inbox({ agent: "bot@acme.rine.network" });

		expect(h.paths).toEqual([`/agents/${BOT_ID}/messages`]);
		expect(h.actors).toEqual([BOT_ID]);
		// The org's own list answered it — no WebFinger anywhere on this path.
		expect(h.corePaths).toEqual(["/agents"]);
	});

	it("takes the short form of that handle as the same agent", async () => {
		const h = makeHarness([OPS, BOT]);

		await h.messages.inbox({ agent: "bot@acme" });

		expect(h.actors).toEqual([BOT_ID]);
	});

	it("refuses an unknown actor the same way under either spelling", async () => {
		const roster =
			"  - ops (ops@acme.rine.network)\n  - bot (bot@acme.rine.network)";
		const bare = makeHarness([OPS, BOT]);
		const handle = makeHarness([OPS, BOT]);

		await expect(bare.messages.inbox({ agent: "ghost" })).rejects.toThrow(
			`No agent named 'ghost'. This org has more than one agent, so a call has to name one. Available agents:\n${roster}\n${CHOOSE}`,
		);
		await expect(
			handle.messages.inbox({ agent: "ghost@acme.rine.network" }),
		).rejects.toThrow(
			`No agent with handle 'ghost@acme.rine.network'. This org has more than one agent, so a call has to name one. Available agents:\n${roster}\n${CHOOSE}`,
		);
		// Neither reached the inbox: the actor is settled before the read, and a
		// read issued for nobody would mark nobody's delivery row.
		expect(bare.paths).toEqual([]);
		expect(handle.paths).toEqual([]);
	});

	it("refuses a handle another org owns rather than acting as it", async () => {
		const h = makeHarness([OPS, BOT]);

		await expect(
			h.messages.inbox({ agent: "someone@other-org.rine.network" }),
		).rejects.toThrow(
			"No agent with handle 'someone@other-org.rine.network'. " + MULTI,
		);
		expect(h.paths).toEqual([]);
	});

	it("refuses an ambiguous bare name, naming the candidates", async () => {
		const twin = { id: "33333333-3333-4333-8333-333333333333", name: "Bot", handle: null };
		const h = makeHarness([OPS, BOT, twin]);

		await expect(h.messages.inbox({ agent: "bot" })).rejects.toThrow(
			"More than one agent is named 'bot'. Say which one is acting:\n" +
				"  - bot (bot@acme.rine.network)\n" +
				"  - Bot (33333333-3333-4333-8333-333333333333)\n" +
				"A name is not unique in an org — name it by handle or UUID.",
		);
		expect(h.paths).toEqual([]);
	});
});

describe("a one-agent org acts on a value that named nobody", () => {
	// The actor here is fixed by the operator at construction and is not a
	// model-visible parameter, so the audience for the note is whoever wired the
	// client — this stack's existing operator log, not a result the caller never
	// asked a question with.
	const WARNING =
		"Ignored agent 'null': this org has one agent, so " +
		"ops (ops@acme.rine.network) acted. Omit agent for a one-agent org.";

	it("acts as the only agent and logs what it ignored", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const h = makeHarness([OPS]);

		await h.messages.inbox({ agent: "null" });

		expect(h.actors).toEqual([OPS_ID]);
		expect(h.paths).toEqual([`/agents/${OPS_ID}/messages`]);
		expect(warn).toHaveBeenCalledWith(`rine: ${WARNING}`);
		warn.mockRestore();
	});

	it("says nothing when the value named that agent after all", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const h = makeHarness([OPS]);

		await h.messages.inbox({ agent: "ops" });

		expect(h.actors).toEqual([OPS_ID]);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("hands the same note to a caller that asks for it, and logs nothing", async () => {
		// The public per-call step: a host rendering the note itself resolves
		// once, here, rather than reading it off a client attribute that a
		// concurrent call would have overwritten.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const h = makeHarness([OPS]);

		const resolved = await h.messages.resolveSenderActor(
			h.core as unknown as Parameters<
				MessagesResource["resolveSenderActor"]
			>[0],
			"null",
		);

		expect(resolved).toEqual({ agentId: OPS_ID, warning: WARNING });
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("never substitutes an agent for a UUID the caller supplied", async () => {
		// Rung 1 is the one spelling that costs no lookup, and a fallback here
		// would be a silent identity substitution — exactly what the ownership
		// check above exists to refuse. It still refuses.
		const h = makeHarness([OPS]);

		await expect(
			h.messages.inbox({ agent: "44444444-4444-4444-8444-444444444444" }),
		).rejects.toThrow("is not owned by the current org");
		expect(h.paths).toEqual([]);
	});
});
