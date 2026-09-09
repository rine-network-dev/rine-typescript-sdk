/**
 * Both-sided transcript fetch + decrypt + render.
 *
 * Backs `ConversationScope.thread()` and `client.thread()`. Kept in its own
 * module so the already-oversized `conversation.ts` stays close to the
 * file-size budget.
 *
 * A transcript has two routes, because it has two things it can be named by: a
 * conversation (`GET /conversations/{id}/messages`) and a group
 * (`GET /groups/{id}/messages`). They answer with the same page shape and need
 * the identical decrypt and render, so {@link transcriptPath} is where the two
 * references part company and {@link fetchThread} takes the route rather than
 * either id — the same split the Python SDK's `_transcript_rows` makes, and for
 * the same reason: the decrypt has no opinion about which name got it here.
 *
 * 🔴 The two routes do NOT return the same rows for a group founded before the
 * group⇄conversation cutover (alembic 0015 is forward-only, so both message
 * shapes are permanent). The group route is the group's own history;
 * the conversation route cannot reach a pre-cutover post at all. Anything
 * comparing them pins a tolerance, never an equality.
 *
 * Either route returns the messages in both directions, ascending. What one row
 * becomes is `thread-row.ts`; the one page-level rule that lives here is the
 * no-sender-key tiering (explained in full on the first row of the render that
 * carries it, a bounded marker on the rest), because "the first row" is
 * a fact about the caller's row ORDER and the rows decrypt concurrently.
 */

import {
	type HttpClient as CoreHttpClient,
	type ThreadRef,
	conversationTranscriptPath,
	groupTranscriptPath,
	senderKeyExplainer,
} from "@rine-network/core";
import { actingAgentHeader } from "../api/acting-agent.js";
import type { SDKHttpClient } from "../api/http.js";
import type { ThreadEntry } from "../types.js";
import { ConversationMessagesPageSchema } from "../types.js";
import { resolveGroupRef } from "./groups-resolve.js";
import { toThreadEntry } from "./thread-row.js";

/**
 * The route that reads the transcript the caller named, resolving a group
 * reference on the way if that is what they named.
 *
 * A group is resolved to its UUID exactly once per read, through the same
 * resolver the send path uses (`./groups-resolve.js`), so `#ops@acme`, `ops`
 * and the UUID all reach the same transcript. A conversation reference has
 * already been checked against what the wire reads as a UUID
 * ({@link ThreadRef}), so it becomes a path segment as it stands.
 *
 * 🔴 Neither route is spelled here. Both come from `@rine-network/core`, which
 * this package already depends on and where `readThreadPage` reads the same two
 * routes: a route written down in two packages is a route a server-side rename
 * fixes in one of them. The contract gate resolves the core builders against
 * the real FastAPI routes and does not scan this package at all, so a copy kept
 * here would be the copy nothing checks.
 *
 * `extraHeaders` rides the resolve leg so the group is looked up as the same
 * acting agent the read is attributed to.
 *
 * @throws {Error} A group reference no group answers to.
 */
export async function transcriptPath(
	core: CoreHttpClient,
	ref: ThreadRef,
	extraHeaders?: Record<string, string>,
): Promise<string> {
	if (ref.kind === "conversation") {
		return conversationTranscriptPath(ref.conversationId);
	}
	const group = await resolveGroupRef(core, ref.ref, extraHeaders);
	return groupTranscriptPath(group.id);
}

export interface FetchThreadOptions {
	readonly http: SDKHttpClient;
	readonly core: CoreHttpClient;
	readonly agentId: string;
	/**
	 * The transcript's route, from {@link transcriptPath}. A route rather than
	 * an id because a transcript has two of them and the decrypt below has no
	 * opinion about which one this is.
	 */
	readonly path: string;
	/**
	 * The acting agent as the caller spelled it — name, handle or UUID — for the
	 * `X-Rine-Agent` override. `agentId` above is the same agent resolved, and
	 * is what decrypts; this is what the header says.
	 */
	readonly agent?: string;
	readonly limit?: number;
	readonly signal?: AbortSignal;
}

/**
 * Fetch the both-sided transcript, decrypt each row with the caller's own keys,
 * and return an ordered, role-tagged rendering. Never throws on an
 * undecryptable row.
 */
export async function fetchThread(
	opts: FetchThreadOptions,
): Promise<ThreadEntry[]> {
	const { http, core, agentId, path, agent, limit, signal } = opts;
	const actorHeader = actingAgentHeader(agent, agentId);

	const raw = await http.get<unknown>(path, {
		params: { limit },
		// One definition, in `api/acting-agent.ts`: a name and a handle both go
		// out as the id already resolved for them against this org's own
		// agents, because an acting agent must be an agent the caller owns.
		// Written inline here once, which is how a rule with two copies starts
		// disagreeing with itself.
		...(actorHeader ? { extraHeaders: actorHeader } : {}),
		signal,
		operation: "thread",
	});
	// Either endpoint returns `{ messages, truncated }` — the both-sided
	// transcript, ascending — NOT a cursor page. Parse that shape
	// directly (`truncated` is currently informational and not surfaced).
	const page = ConversationMessagesPageSchema.parse(raw);

	// 🔴 One row at a time, deliberately. Every row of a group render opens
	// against one ratchet in one state file, so a concurrent map made one
	// key-recovery scan PER ROW and then let them overwrite each other's key
	// material: most of a transcript came back sealed on the first render after
	// being away and readable on the second. A row costs a local AEAD open AND
	// the inbound verify's `GET /agents/{id}/keys`, which is cache-served only
	// for a sender already fetched inside the client's TTL — so this is not free,
	// and the claim is correctness, not speed. What does get cheaper is the
	// recovery: one scan for the whole render instead of one per row. The Python
	// client has always rendered this way.
	const classified: Awaited<ReturnType<typeof toThreadEntry>>[] = [];
	for (const row of page.messages) {
		classified.push(await toThreadEntry({ core, http, agentId, row }));
	}
	// One call to `thread()` is one render, so the explainer is created, spent
	// and dropped here — never at module scope, where the second transcript of a
	// process would silently lose the explanation the first one used up.
	const explain = senderKeyExplainer();
	return classified.map(({ entry, explanation }) =>
		explanation === null
			? entry
			: { ...entry, text: explain(explanation).line },
	);
}
