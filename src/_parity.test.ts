/**
 * Python SDK parity smoke test.
 *
 * Iterates a static registry of Python SDK method names and asserts that the
 * `AsyncRineClient` surface exposes a same-named (camelCase) method with
 * matching required-parameter count. The registry is a behavioural smoke
 * contract: it does not call the methods, only checks the shape.
 *
 * The `DEFERRED` skip list is authoritative. Any Python method listed there
 * is allowed to be absent — e.g. GDPR or the conversation-management API,
 * both Non-goals. Deleted surface (`get_org`, `encrypt_dm`, `leave_group`)
 * is also listed so the test does not require methods that have been
 * intentionally removed.
 *
 * Arity is checked via `Function.prototype.length`, asserted with `>=`
 * against the Python signature's **minimum required positional parameter
 * count**. The lower-bound check is deliberate: TypeScript optional params
 * (`opts?: Foo`) still count in `length` even though they compile without
 * a default, so strict equality would drift every time a method adds or
 * removes an options bag. "Right arity" in parity terms means the TS
 * method can be invoked with the same required positional args as the
 * Python equivalent — extra trailing optionals are allowed and expected.
 */

import { describe, expect, it, vi } from "vitest";

// Stub the core loader so `new AsyncRineClient()` doesn't reach disk.
// Parity is a pure surface test — it never calls a method.
vi.mock("@rine-network/core", async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>;
	return {
		...original,
		loadCredentials: () => ({
			profiles: { default: { api_url: "https://example.test" } },
			default_profile: "default",
		}),
		getOrRefreshToken: async () => "stub-token",
		resolveConfigDir: () => "/tmp/rine-parity-test",
		resolveApiUrl: () => "https://example.test",
	};
});

const { AsyncRineClient } = await import("./client.js");

// ---------------------------------------------------------------------------
// Parity registry — snake_case Python method names. `minArity` is the TS
// `Function.prototype.length` — required positional params only.
// ---------------------------------------------------------------------------

type Location = "client" | "groups" | "webhooks";

interface ParityEntry {
	readonly pyName: string;
	readonly location: Location;
	/** Minimum required positional parameters per the Python signature. */
	readonly minArity: number;
}

const REGISTRY: readonly ParityEntry[] = [
	// Messaging — §3 "Messaging" table
	{ pyName: "send", location: "client", minArity: 2 },
	{ pyName: "inbox", location: "client", minArity: 0 },
	{ pyName: "read", location: "client", minArity: 1 },
	{ pyName: "reply", location: "client", minArity: 2 },
	{ pyName: "send_and_wait", location: "client", minArity: 2 },
	{ pyName: "stream", location: "client", minArity: 0 },

	// Discovery — §3 "Discovery" table
	{ pyName: "discover", location: "client", minArity: 0 },
	{ pyName: "inspect", location: "client", minArity: 1 },
	{ pyName: "discover_groups", location: "client", minArity: 0 },

	// Identity — §3 "Identity" table
	{ pyName: "whoami", location: "client", minArity: 0 },
	{ pyName: "poll", location: "client", minArity: 0 },
	{ pyName: "create_agent", location: "client", minArity: 1 },
	{ pyName: "update_agent", location: "client", minArity: 2 },
	{ pyName: "revoke_agent", location: "client", minArity: 1 },
	{ pyName: "update_org", location: "client", minArity: 0 },
	{ pyName: "erase_org", location: "client", minArity: 0 },
	{ pyName: "export_org", location: "client", minArity: 0 },
	{ pyName: "get_agent", location: "client", minArity: 1 },
	{ pyName: "list_agents", location: "client", minArity: 0 },
	{ pyName: "regenerate_poll_token", location: "client", minArity: 1 },
	{ pyName: "revoke_poll_token", location: "client", minArity: 1 },
	{ pyName: "get_quotas", location: "client", minArity: 0 },
	{ pyName: "rotate_keys", location: "client", minArity: 1 },

	// Agent Cards — §3 "Agent Cards" table
	{ pyName: "set_agent_card", location: "client", minArity: 2 },
	{ pyName: "get_agent_card", location: "client", minArity: 1 },
	{ pyName: "delete_agent_card", location: "client", minArity: 1 },

	// Conversations — §3 "Conversations" table (all deferred)
	{ pyName: "update_conversation_status", location: "client", minArity: 2 },
	{ pyName: "get_conversation", location: "client", minArity: 1 },
	{ pyName: "get_conversation_participants", location: "client", minArity: 1 },

	// Groups — §3 "Groups" table, methods on client.groups.*
	{ pyName: "create", location: "groups", minArity: 1 },
	{ pyName: "join", location: "groups", minArity: 1 },
	{ pyName: "members", location: "groups", minArity: 1 },
	{ pyName: "invite", location: "groups", minArity: 2 },
	{ pyName: "list", location: "groups", minArity: 0 },
	{ pyName: "update", location: "groups", minArity: 2 },
	{ pyName: "delete", location: "groups", minArity: 1 },
	{ pyName: "remove_member", location: "groups", minArity: 2 },
	{ pyName: "list_requests", location: "groups", minArity: 1 },
	{ pyName: "vote", location: "groups", minArity: 3 },

	// Webhooks — §3 "Webhooks" table, methods on client.webhooks.*
	{ pyName: "create", location: "webhooks", minArity: 2 },
	{ pyName: "list", location: "webhooks", minArity: 0 },
	{ pyName: "update", location: "webhooks", minArity: 2 },
	{ pyName: "delete", location: "webhooks", minArity: 1 },
	{ pyName: "deliveries", location: "webhooks", minArity: 1 },
	{ pyName: "delivery_summary", location: "webhooks", minArity: 1 },

	// Lifecycle — §3 "Lifecycle" table
	{ pyName: "with_options", location: "client", minArity: 1 },
	{ pyName: "close", location: "client", minArity: 0 },
];

// ---------------------------------------------------------------------------
// DEFERRED — explicit skip list.
//
// Members are Python-SDK snake_case names not yet implemented in the TS SDK.
// ---------------------------------------------------------------------------

const DEFERRED: ReadonlySet<string> = new Set([
	// Conversation management API — deferred (not in scope).
	// (Distinct from the `conversation(convId)` scope builder, which IS in
	// scope and lives on the TS client as `conversation()`.)
	"update_conversation_status",
	"get_conversation",
	"get_conversation_participants",

	// Deleted surface — methods removed from both SDKs.
	"encrypt_dm",
	"get_org",
	"leave_group",
]);

// ---------------------------------------------------------------------------
// DELETED_SURFACE — module-scope allow-list used by the DEFERRED meta-test.
// These names either never existed in the Python SDK or have been removed
// from both SDKs, and must not require a registry entry.
// ---------------------------------------------------------------------------
const DELETED_SURFACE: ReadonlySet<string> = new Set([
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

describe("Python SDK method parity", () => {
	// Pure surface inspection — no per-test isolation needed. Constructing
	// the client once at describe-body scope makes the test's intent plain:
	// we read function references off the prototype, we never call them.
	const client = new AsyncRineClient({
		configDir: "/tmp/rine-parity-test",
		apiUrl: "https://example.test",
	});

	for (const entry of REGISTRY) {
		const { pyName, location, minArity } = entry;
		const camel = snakeToCamel(pyName);
		const label = `${location === "client" ? "client" : `client.${location}`}.${camel}`;

		if (DEFERRED.has(pyName)) {
			it.skip(`${label} — deferred (py: ${pyName})`, () => {});
			continue;
		}

		it(`${label} accepts ≥${minArity} positional arg(s) (py: ${pyName})`, () => {
			const owner = ownerFor(client, location);
			const fn = owner[camel];
			expect(typeof fn, `expected ${label}() to be a function`).toBe(
				"function",
			);
			// Lower-bound check: TypeScript optional params (`opts?: Foo`)
			// still count toward `Function.prototype.length`, so the TS
			// value can exceed the Python required count. What parity
			// really requires is that callers can pass the same number of
			// required positional arguments the Python SDK accepts.
			expect(
				(fn as (...args: unknown[]) => unknown).length,
				`expected ${label}() to accept at least ${minArity} positional args`,
			).toBeGreaterThanOrEqual(minArity);
		});
	}

	it("every DEFERRED entry is a real Python method in the registry", () => {
		// Guards against typos in the skip list — if a deferred name does
		// not correspond to a registered Python method the skip is dead.
		// Deleted-surface entries are allowed to be absent from the registry
		// (they were never in or have been removed from the Python SDK).
		const known = new Set(REGISTRY.map((e) => e.pyName));
		for (const pyName of DEFERRED) {
			if (known.has(pyName)) continue;
			expect(
				DELETED_SURFACE.has(pyName),
				`DEFERRED contains "${pyName}" but it is neither in the registry nor in the deleted-surface allow-list`,
			).toBe(true);
		}
	});
});
