/**
 * What a caller-supplied acting agent puts on `X-Rine-Agent`, decided once.
 *
 * The per-call `agent` option takes three spellings — a bare name, a handle or
 * a UUID — and only one of them, the UUID, is a value the wire reads as an
 * agent **id** as written. The other two are resolved against the caller's own
 * agent list before the request is built (`resolveSenderId` → `resolveAgent`),
 * so this sends what that lookup found.
 *
 * 🔴 **A handle goes out resolved, and that is the ownership rule, not a
 * micro-optimisation.** `_resolve_agent_header` (`src/rine/api/agent_identity.py`)
 * does accept a handle, so sending one verbatim worked — for an agent this org
 * owns. For one it does not, the server answered **422** *"Agent x@org not found
 * or not owned by this org"*, naming no agent, while the client held the list
 * that could have named them all. An acting agent must be an agent the caller
 * owns, so the lookup happens here and the header carries its answer. The
 * Python twin is `is_wire_agent_id` (`rine-sdk/src/rine/_resolve.py`), which
 * answers this same question and deliberately says no to a handle.
 *
 * 🔴 **One definition, because the rule was briefly two.** It was written as a
 * private helper in `resources/messages.ts` and again as an inline ternary in
 * `resources/thread.ts` — same rule, two shapes, nothing binding them. Every
 * other `ACTING_AGENT_HEADER` site in this package sends an id it resolved
 * itself and never sees a caller's spelling, so this is the whole surface: any
 * new call that forwards a caller-supplied `agent` belongs here rather than in
 * a third copy.
 *
 * 🔴 **It does not reach the constructor rung.** `new AsyncRineClient({ agent })`
 * and `withAgent()` still put the value on the header verbatim
 * (`api/http.ts`), so a bare name there is refused by the server with a 422 —
 * that rung has no resolved id to substitute and no lookup at construction
 * time, and closing it is a behaviour decision rather than a refactor. The
 * asymmetry is deliberate and documented in
 * `docs/docs/concepts/multi-agent-hosts.md`.
 */

import { ACTING_AGENT_HEADER, UUID_RE } from "@rine-network/core";

/**
 * The `X-Rine-Agent` header for a per-call actor, or `undefined` for none.
 *
 * @param agent - The acting agent as the caller spelled it: a bare name, a
 *   handle or a UUID. Absent, or empty, means the caller named nobody on this
 *   call and the client's own actor stands.
 * @param resolvedId - The same agent already resolved to a UUID by the call —
 *   what a name and a handle both go out as. Never re-resolved here: one lookup
 *   per call.
 */
export function actingAgentHeader(
	agent: string | undefined,
	resolvedId: string,
): Record<string, string> | undefined {
	if (!agent) return undefined;
	return {
		[ACTING_AGENT_HEADER]: UUID_RE.test(agent) ? agent : resolvedId,
	};
}
