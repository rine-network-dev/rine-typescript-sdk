/**
 * Type-level API surface stability pins.
 *
 * Zero runtime code. `tsc` fails at build time if any committed method is
 * renamed or deleted on `AsyncRineClient`, `GroupsResource`, or
 * `WebhooksResource`.
 *
 * Technique: a `Pick` over each class's method keys. If a method is
 * renamed, deleted, or has its access modifier flipped, tsc fails with a
 * clear "Type 'X' is missing the following properties" error.
 *
 * Imported by `src/index.ts` as a type-only import so the bundler strips
 * it entirely — no JavaScript emitted.
 */

import type { AsyncRineClient } from "./client.js";
import type { GroupsResource } from "./resources/groups.js";
import type { WebhooksResource } from "./resources/webhooks.js";

// ---------------------------------------------------------------------------
// Client surface — pinned method names.
// ---------------------------------------------------------------------------

type _ClientSurfaceKeys =
	// Messaging
	| "send"
	| "inbox"
	| "read"
	| "reply"
	| "sendAndWait"
	| "stream"
	// Discovery
	| "discover"
	| "inspect"
	| "discoverGroups"
	// Identity
	| "whoami"
	| "poll"
	| "createAgent"
	| "updateAgent"
	| "revokeAgent"
	| "getAgent"
	| "listAgents"
	| "regeneratePollToken"
	| "revokePollToken"
	| "getQuotas"
	| "rotateKeys"
	// Agent cards
	| "setAgentCard"
	| "getAgentCard"
	| "deleteAgentCard"
	// Org lifecycle
	| "updateOrg"
	| "eraseOrg"
	| "exportOrg"
	// Lifecycle
	| "withOptions"
	| "close";

// ---------------------------------------------------------------------------
// Groups surface — pinned `client.groups.*` method names.
// ---------------------------------------------------------------------------

type _GroupsSurfaceKeys =
	| "create"
	| "join"
	| "members"
	| "invite"
	| "list"
	| "update"
	| "delete"
	| "removeMember"
	| "listRequests"
	| "vote";

// ---------------------------------------------------------------------------
// Webhooks surface — pinned `client.webhooks.*` method names.
// ---------------------------------------------------------------------------

type _WebhooksSurfaceKeys =
	| "create"
	| "list"
	| "update"
	| "delete"
	| "deliveries"
	| "deliverySummary";

// ---------------------------------------------------------------------------
// Pins — each `Pick` fails tsc with a clear "missing property" error if
// any listed key is absent from its class. This is the load-bearing
// build-time drift detector.
// ---------------------------------------------------------------------------

type _ClientPin = Pick<AsyncRineClient, _ClientSurfaceKeys>;
type _GroupsPin = Pick<GroupsResource, _GroupsSurfaceKeys>;
type _WebhooksPin = Pick<WebhooksResource, _WebhooksSurfaceKeys>;

/**
 * Public type-only export that forces tsc to evaluate all three pins.
 * Imported from `src/index.ts` via `export type` so the bundler strips
 * it entirely — there is no JavaScript emitted for this file.
 */
export type SurfacePins = {
	readonly client: _ClientPin;
	readonly groups: _GroupsPin;
	readonly webhooks: _WebhooksPin;
};
