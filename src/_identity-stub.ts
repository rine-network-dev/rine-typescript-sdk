// Support for the IdentityResource suites: not part of the published surface
// (see tsconfig.build.json, `src/_*.ts`).
import { deriveBranch, deriveOrg } from "@rine-network/core";
import { type CustodyFixture, FIXTURE_ROOT } from "@rine-network/core/testing";
import type { SDKHttpClient } from "./api/http.js";
import type { AgentUuid } from "./types.js";

export interface PostCall {
	path: string;
	body: unknown;
	opts: { signal?: AbortSignal; operation?: string } | undefined;
}

export interface GetCall {
	path: string;
	opts: { signal?: AbortSignal; operation?: string } | undefined;
}

export interface CorePost {
	path: string;
	body: unknown;
}

export interface StubOptions {
	/** The profile name the fake client acts as (default `default`). */
	profile?: string;
	/** Override the runtime config dir (used for the empty-configDir guard). */
	configDir?: string;
	/** What `GET /agents/{id}/keys` answers (rotateKeys). */
	keysResponse?: unknown;
	/** When set, every POST rejects with this error. */
	postError?: Error;
	/** Stand-in for the rine-core HTTP client (MLS KeyPackage publish). */
	coreClient?: unknown;
	/** When set, `POST /agents` answers this id instead of echoing the minted one. */
	serverId?: string;
	/** When set, the echoed `POST /agents` response carries this `poll_url`. */
	pollUrl?: string;
}

/**
 * Minimal SDKHttpClient stub over a custody fixture. It records GET/POST calls,
 * echoes the client-minted `id` on `POST /agents` (the server does the same) and
 * exposes the custody `dirs`, `profile` and `getCoreHttpClient()` seam that
 * `IdentityResource` reads. Only the fields the resource actually touches are
 * populated; the rest of the surface is unreachable in this test.
 */
export function makeHttpStub(
	fx: CustodyFixture,
	opts: StubOptions = {},
): {
	http: SDKHttpClient;
	posts: PostCall[];
	gets: GetCall[];
	corePosts: CorePost[];
} {
	const posts: PostCall[] = [];
	const gets: GetCall[] = [];
	const corePosts: CorePost[] = [];
	const dirs =
		opts.configDir === undefined
			? fx.dirs
			: { ...fx.dirs, configDir: opts.configDir };
	const coreClient =
		opts.coreClient ??
		({
			async post(p: string, body: unknown) {
				corePosts.push({ path: p, body });
				const pkgs = (body as { packages?: unknown[] }).packages ?? [];
				return { stored: pkgs.length };
			},
		} as const);
	const stub = {
		get configDir() {
			return dirs.configDir;
		},
		get ownerDir() {
			return dirs.ownerDir;
		},
		get dirs() {
			return dirs;
		},
		custodyDirs() {
			return dirs;
		},
		get profile() {
			return opts.profile ?? "default";
		},
		async get<T>(p: string, o?: GetCall["opts"]): Promise<T> {
			gets.push({ path: p, opts: o });
			if (opts.keysResponse !== undefined) return opts.keysResponse as T;
			throw new Error(`unexpected GET ${p}`);
		},
		async post<T>(p: string, body?: unknown, o?: PostCall["opts"]): Promise<T> {
			posts.push({ path: p, body, opts: o });
			if (opts.postError) throw opts.postError;
			if (p === "/agents") {
				const id = opts.serverId ?? (body as { id: string }).id;
				return sampleAgentRead(id, {
					...(opts.pollUrl ? { poll_url: opts.pollUrl } : {}),
				}) as T;
			}
			if (p.endsWith("/keys")) return sampleAgentRead(AGENT_ID) as T;
			throw new Error(`unexpected POST ${p}`);
		},
		getCoreHttpClient() {
			return coreClient;
		},
	} as unknown as SDKHttpClient;
	return { http: stub, posts, gets, corePosts };
}

export function sampleAgentRead(
	agentId: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: agentId,
		name: "alice",
		handle: "alice@acme.rine.network",
		human_oversight: true,
		incoming_policy: "accept_all",
		outgoing_policy: "send_all",
		created_at: "2026-04-11T12:00:00Z",
		...overrides,
	};
}

/** The fixture org's `main` branch, used to derive the expected leaf keys. */
export function mainBranch() {
	return deriveBranch(deriveOrg(FIXTURE_ROOT), "main");
}

// Valid UUID v4 shape required by rine-core's `validatePathId` regex.
export const AGENT_ID = "11111111-1111-4111-8111-111111111111" as AgentUuid;
export const CANONICAL_UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
