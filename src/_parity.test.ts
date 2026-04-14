/**
 * API surface stability smoke test.
 *
 * Iterates a static registry of method names and asserts that the
 * `AsyncRineClient` surface exposes each method with a matching
 * required-parameter count. The registry is a behavioural smoke
 * contract: it does not call the methods, only checks the shape.
 *
 * The `DEFERRED` skip list is authoritative. Any method listed there
 * is allowed to be absent from the client surface — e.g. GDPR or the
 * conversation-management API. Entries that have never existed or have
 * been removed are also listed so the test does not require them.
 *
 * Arity is checked via `Function.prototype.length`, asserted with `>=`
 * against a **minimum required positional parameter count**. The
 * lower-bound check is deliberate: TypeScript optional params
 * (`opts?: Foo`) still count in `length` even though they compile without
 * a default, so strict equality would drift every time a method adds or
 * removes an options bag. The stability contract is that callers can
 * always pass the same minimum number of required positional arguments;
 * extra trailing optionals are allowed and expected.
 */

import { describe, expect, it, vi } from "vitest";

// Stub the core loader so `new AsyncRineClient()` doesn't reach disk.
// This is a pure surface test — it never calls a method.
vi.mock("@rine-network/core", async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>;
	return {
		...original,
		loadCredentials: () => ({
			profiles: { default: { api_url: "https://example.test" } },
			default_profile: "default",
		}),
		getOrRefreshToken: async () => "stub-token",
		resolveConfigDir: () => "/tmp/rine-surface-test",
		resolveApiUrl: () => "https://example.test",
	};
});

const { AsyncRineClient } = await import("./client.js");

// ---------------------------------------------------------------------------
// Surface registry — snake_case canonical names. `minArity` is the required
// positional parameter count surfaced via `Function.prototype.length`.
// ---------------------------------------------------------------------------

type Location = "client" | "groups" | "webhooks";

interface SurfaceEntry {
	readonly name: string;
	readonly location: Location;
	/** Minimum required positional parameters. */
	readonly minArity: number;
}

const REGISTRY: readonly SurfaceEntry[] = [
	// Messaging
	{ name: "send", location: "client", minArity: 2 },
	{ name: "inbox", location: "client", minArity: 0 },
	{ name: "read", location: "client", minArity: 1 },
	{ name: "reply", location: "client", minArity: 2 },
	{ name: "send_and_wait", location: "client", minArity: 2 },
	{ name: "stream", location: "client", minArity: 0 },

	// Discovery
	{ name: "discover", location: "client", minArity: 0 },
	{ name: "inspect", location: "client", minArity: 1 },
	{ name: "discover_groups", location: "client", minArity: 0 },

	// Identity
	{ name: "whoami", location: "client", minArity: 0 },
	{ name: "poll", location: "client", minArity: 0 },
	{ name: "create_agent", location: "client", minArity: 1 },
	{ name: "update_agent", location: "client", minArity: 2 },
	{ name: "revoke_agent", location: "client", minArity: 1 },
	{ name: "update_org", location: "client", minArity: 0 },
	{ name: "erase_org", location: "client", minArity: 0 },
	{ name: "export_org", location: "client", minArity: 0 },
	{ name: "get_agent", location: "client", minArity: 1 },
	{ name: "list_agents", location: "client", minArity: 0 },
	{ name: "regenerate_poll_token", location: "client", minArity: 1 },
	{ name: "revoke_poll_token", location: "client", minArity: 1 },
	{ name: "get_quotas", location: "client", minArity: 0 },
	{ name: "rotate_keys", location: "client", minArity: 1 },

	// Agent Cards
	{ name: "set_agent_card", location: "client", minArity: 2 },
	{ name: "get_agent_card", location: "client", minArity: 1 },
	{ name: "delete_agent_card", location: "client", minArity: 1 },

	// Conversations (all deferred — see DEFERRED below)
	{ name: "update_conversation_status", location: "client", minArity: 2 },
	{ name: "get_conversation", location: "client", minArity: 1 },
	{ name: "get_conversation_participants", location: "client", minArity: 1 },

	// Groups — methods on client.groups.*
	{ name: "create", location: "groups", minArity: 1 },
	{ name: "join", location: "groups", minArity: 1 },
	{ name: "members", location: "groups", minArity: 1 },
	{ name: "invite", location: "groups", minArity: 2 },
	{ name: "list", location: "groups", minArity: 0 },
	{ name: "update", location: "groups", minArity: 2 },
	{ name: "delete", location: "groups", minArity: 1 },
	{ name: "remove_member", location: "groups", minArity: 2 },
	{ name: "list_requests", location: "groups", minArity: 1 },
	{ name: "vote", location: "groups", minArity: 3 },

	// Webhooks — methods on client.webhooks.*
	{ name: "create", location: "webhooks", minArity: 2 },
	{ name: "list", location: "webhooks", minArity: 0 },
	{ name: "update", location: "webhooks", minArity: 2 },
	{ name: "delete", location: "webhooks", minArity: 1 },
	{ name: "deliveries", location: "webhooks", minArity: 1 },
	{ name: "delivery_summary", location: "webhooks", minArity: 1 },

	// Lifecycle
	{ name: "with_options", location: "client", minArity: 1 },
	{ name: "close", location: "client", minArity: 0 },
];

// ---------------------------------------------------------------------------
// DEFERRED — explicit skip list.
//
// Members are registered names that are not (yet) implemented on the TS
// client surface.
// ---------------------------------------------------------------------------

const DEFERRED: ReadonlySet<string> = new Set([
	// Conversation management API — not in scope.
	// (Distinct from the `conversation(convId)` scope builder, which IS in
	// scope and lives on the TS client as `conversation()`.)
	"update_conversation_status",
	"get_conversation",
	"get_conversation_participants",

	// Names that have been removed from the public surface.
	"encrypt_dm",
	"get_org",
	"leave_group",
]);

// ---------------------------------------------------------------------------
// REMOVED_SURFACE — module-scope allow-list used by the DEFERRED meta-test.
// These names have been removed from the public surface and must not require
// a registry entry.
// ---------------------------------------------------------------------------
const REMOVED_SURFACE: ReadonlySet<string> = new Set([
	"encrypt_dm",
	"get_org",
	"leave_group",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function snakeToCamel(s: string): string {
	return s.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

type MethodOwner = { [key: string]: unknown };

function ownerFor(
	client: InstanceType<typeof AsyncRineClient>,
	location: Location,
): MethodOwner {
	switch (location) {
		case "client":
			return client as unknown as MethodOwner;
		case "groups":
			return client.groups as unknown as MethodOwner;
		case "webhooks":
			return client.webhooks as unknown as MethodOwner;
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("client API surface stability", () => {
	// Pure surface inspection — no per-test isolation needed. Constructing
	// the client once at describe-body scope makes the test's intent plain:
	// we read function references off the prototype, we never call them.
	const client = new AsyncRineClient({
		configDir: "/tmp/rine-surface-test",
		apiUrl: "https://example.test",
	});

	for (const entry of REGISTRY) {
		const { name, location, minArity } = entry;
		const camel = snakeToCamel(name);
		const label = `${location === "client" ? "client" : `client.${location}`}.${camel}`;

		if (DEFERRED.has(name)) {
			it.skip(`${label} — deferred (${name})`, () => {});
			continue;
		}

		it(`${label} accepts ≥${minArity} positional arg(s) (${name})`, () => {
			const owner = ownerFor(client, location);
			const fn = owner[camel];
			expect(typeof fn, `expected ${label}() to be a function`).toBe(
				"function",
			);
			// Lower-bound check: TypeScript optional params (`opts?: Foo`)
			// still count toward `Function.prototype.length`, so the TS
			// value can exceed the required-minimum count. The stability
			// contract is just that callers can always pass the same
			// minimum number of required positional arguments.
			expect(
				(fn as (...args: unknown[]) => unknown).length,
				`expected ${label}() to accept at least ${minArity} positional args`,
			).toBeGreaterThanOrEqual(minArity);
		});
	}

	it("every DEFERRED entry is either a registry entry or a removed-surface name", () => {
		// Guards against typos in the skip list — if a deferred name does
		// not correspond to a registered method the skip is dead. Removed-
		// surface entries are allowed to be absent from the registry.
		const known = new Set(REGISTRY.map((e) => e.name));
		for (const name of DEFERRED) {
			if (known.has(name)) continue;
			expect(
				REMOVED_SURFACE.has(name),
				`DEFERRED contains "${name}" but it is neither in the registry nor in the removed-surface allow-list`,
			).toBe(true);
		}
	});
});
