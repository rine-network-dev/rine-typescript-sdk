import type { AgentRead } from "../types.js";

/**
 * The org's own agent ids, resolved to handles, fetched at most once per client
 * lifetime.
 *
 * ## The stated rule, in one place
 *
 * Every surface that prints "which of YOUR agents is seated here" renders the
 * same three cases, and this comment is the sentence the other renderers cite:
 *
 * 1. A seated id this org knows prints its **handle** — `AgentRead.handle`,
 *    never `AgentRead.name`. A bare name is not a value any caller can hand
 *    back: `src/rine/api/agent_identity.py` refuses a non-UUID without an `@`,
 *    so a printed name would be unusable on every raw HTTP caller. A handle is
 *    hand-backable, a UUID is hand-backable, a name is not.
 * 2. A seated id this org cannot resolve prints **the id**. Not a blank, not a
 *    placeholder — the UUID is still the value `X-Rine-Agent` takes, so the
 *    degraded rendering is the older rendering rather than a loss.
 * 3. An empty or absent list prints the surface's `NO_OWN_AGENTS` sentence,
 *    unchanged. "None of your agents is seated" and "this server predates the
 *    field" collapse into one sentence on purpose — see the CLI's constant.
 *
 * ## Why this never throws
 *
 * Resolution is decoration on a success path. `rine group get` and
 * `rine_groups` answered the caller's question before this existed and must
 * keep answering it when the extra `GET /agents` fails — an org whose agent
 * list 500s or times out gets case 2 for every id, not a failed group read.
 * The rejected fetch is *not* memoised, so a transient failure costs one render
 * rather than the whole process lifetime.
 */
export type AgentHandleMap = ReadonlyMap<string, string>;

/** What every degraded path resolves to: case 2 for every id. */
export const NO_AGENT_HANDLES: AgentHandleMap = new Map();

/**
 * Index an already-fetched agent list by id.
 *
 * Keys are lowercased because a UUID is case-insensitive and the two sides of
 * the lookup come from different places — `member_agent_ids` from the group
 * row, `AgentRead.id` from `GET /agents` — so a server that ever upper-cased
 * one of them would silently degrade every row to case 2.
 */
export function agentHandleMap(agents: readonly AgentRead[]): AgentHandleMap {
	return new Map(agents.map((a) => [a.id.toLowerCase(), a.handle]));
}

/**
 * One `GET /agents` per client lifetime, shared with every derived client.
 *
 * The list is org-scoped, and `withOptions` derives a client that shares this
 * one's credentials — so `withAgent()` per tool call (what `rine-mastra` does
 * on every execute) must not mean a fetch per tool call. The founder accepted
 * the new call deliberately; what was accepted is one, not one per render.
 */
export class AgentHandleCache {
	private pending: Promise<AgentHandleMap> | undefined;

	constructor(private readonly list: () => Promise<readonly AgentRead[]>) {}

	get(): Promise<AgentHandleMap> {
		this.pending ??= this.list()
			.then(agentHandleMap)
			.catch(() => {
				// Clear the memo before answering: a poisoned cache would turn one
				// timed-out request into UUIDs for the rest of the process.
				this.pending = undefined;
				return NO_AGENT_HANDLES;
			});
		return this.pending;
	}
}
