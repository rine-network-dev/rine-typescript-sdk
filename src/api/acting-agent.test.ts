/**
 * The per-call actor header rule, pinned where it now lives.
 *
 * The rule ("a bare name goes out as the resolved id; a handle and a UUID go
 * out as typed") was briefly written twice — a private helper in
 * `resources/messages.ts` and an inline ternary in `resources/thread.ts` — with
 * nothing binding the two. These tests pin the single definition rather than
 * either call site, so a third caller inherits a rule that is tested rather
 * than a shape that happens to match.
 *
 * The resolved-id substitution is the load-bearing half: `X-Rine-Agent` is
 * parsed by `_resolve_agent_header` (`src/rine/api/agent_identity.py`), which
 * answers **422** for a value that is neither a UUID nor a handle. Widening the
 * rung to accept a bare name without this only moves the refusal to the server.
 */

import { describe, expect, it } from "vitest";
import { ACTING_AGENT_HEADER } from "@rine-network/core";
import { actingAgentHeader } from "./acting-agent.js";

const RESOLVED = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("actingAgentHeader", () => {
	it("sends the resolved id for a bare name, which is the spelling the refusals ask for", () => {
		expect(actingAgentHeader("ops", RESOLVED)).toEqual({
			[ACTING_AGENT_HEADER]: RESOLVED,
		});
	});

	it("sends the resolved id for a handle too, because ownership is decided here", () => {
		// This used to pin the opposite — the handle went out as typed, and the
		// argument for it was that the header accepts one and resolving costs a
		// round trip. What that bought was a 422 from the server for a handle
		// this org does not own, naming no agent, while the client held the
		// list that could have named them all. The id is the stronger claim: it
		// says the lookup ran and found this agent among ours.
		expect(actingAgentHeader("ops@acme.rine.network", RESOLVED)).toEqual({
			[ACTING_AGENT_HEADER]: RESOLVED,
		});
	});

	it("sends a uuid the caller named as typed, even when it is not the resolved one", () => {
		// The caller named an actor; the resolved id is only the substitute for a
		// spelling the wire refuses. Overriding it here would silently retarget
		// the call to whichever agent the surrounding call happened to resolve.
		const other = "11111111-2222-3333-4444-555555555555";
		expect(actingAgentHeader(other, RESOLVED)).toEqual({
			[ACTING_AGENT_HEADER]: other,
		});
	});

	it("names nobody when the caller named nobody", () => {
		expect(actingAgentHeader(undefined, RESOLVED)).toBeUndefined();
	});

	it("treats an empty actor as absent rather than sending a blank header", () => {
		// The two copies disagreed here: one branched on falsiness and the other
		// on `!== undefined`, so `agent: ""` sent no header on one path and the
		// resolved id on the other. Absent is the answer both should have given —
		// it is what `normalizeActor` already means by a blank actor.
		expect(actingAgentHeader("", RESOLVED)).toBeUndefined();
	});
});
