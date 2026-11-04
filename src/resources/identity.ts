/**
 * Identity resource — whoami, createAgent, listAgents, getAgent, updateAgent,
 * revokeAgent, rotateKeys, agent cards, poll tokens, quotas.
 */

import {
	OrgMismatchError,
	agentCreateRequest,
	loadCustody,
	performKeyRotation,
	persistCreatedAgent,
	settleRotation,
	verifyIdentitySpiffe,
	verifyNewAgent,
} from "@rine-network/core";
import type { VerifyIdentityResult } from "@rine-network/core";
import { parse, parseCursorPage } from "../api/adapters.js";
import type { SDKHttpClient } from "../api/http.js";
import { RineError } from "../errors.js";
import {
	AgentCardSchema,
	AgentReadSchema,
	ErasureResultSchema,
	OrgQuotasSchema,
	OrgReadSchema,
	PollTokenResponseSchema,
	WhoAmISchema,
} from "../types.js";
import type { AgentRead, AgentUuid, ErasureResult, OrgRead } from "../types.js";

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface CreateAgentOptions {
	/** The branch the agent is created under (default `main`). */
	branch?: string;
	human_oversight?: boolean;
	unlisted?: boolean;
	signal?: AbortSignal;
	/**
	 * Prove control of a SPIFFE identity for the new agent immediately after
	 * creation (elevating the org to trust tier 2). Verification also runs
	 * automatically when a `svid` is supplied or a SPIFFE Workload API endpoint
	 * is detected. A verification failure never undoes agent creation — the
	 * error is surfaced on `CreateAgentResult.identityError` instead.
	 */
	verifyIdentity?: boolean;
	/** Caller-supplied SPIFFE JWT-SVID for the auto-verify step. */
	svid?: string;
}

export interface VerifyIdentityOptions {
	/**
	 * A caller-supplied SPIFFE JWT-SVID (compact JWS) whose `aud` matches the
	 * server-minted challenge audience. When absent and no SPIFFE Workload API
	 * endpoint is available, `SpiffeVerificationError` is thrown (never a silent
	 * no-op).
	 */
	svid?: string;
	/** Sink for human-readable diagnostics. */
	log?: (message: string) => void;
	signal?: AbortSignal;
}

/**
 * Result of {@link IdentityResource.createAgent}: the created agent plus, when
 * verification ran, either the typed identity result or the failure message.
 * Verification failure never undoes creation.
 */
export type CreateAgentResult = AgentRead & {
	identity?: VerifyIdentityResult;
	identityError?: string;
};

export interface RotateKeysOptions {
	signal?: AbortSignal;
}

export type UpdateAgentPatch = {
	human_oversight?: boolean;
	incoming_policy?: "accept_all" | "groups_only";
	outgoing_policy?: "send_all" | "groups_only";
	unlisted?: boolean;
};

export interface UpdateOrgPatch {
	name?: string;
	contact_email?: string;
	country_code?: string;
	slug?: string;
}

export interface EraseOrgOptions {
	confirm: boolean;
	signal?: AbortSignal;
}

export interface AgentCardInput {
	name: string;
	description: string;
	version?: string;
	is_public?: boolean;
	skills?: Array<{
		id: string;
		name: string;
		description: string;
		tags?: string[];
	}>;
	categories?: string[];
	languages?: string[];
	pricing_model?: "free" | "per_request" | "subscription" | "negotiated";
}

// ---------------------------------------------------------------------------
// IdentityResource
// ---------------------------------------------------------------------------

export class IdentityResource {
	constructor(private readonly http: SDKHttpClient) {}

	/**
	 * Fetch the caller's org summary, principal and the agents it can see.
	 *
	 * Route: `GET /whoami`. Every principal kind is answered, each inside what
	 * it may read: an org principal sees the whole org, a branch or agent
	 * principal only its own scope.
	 *
	 * Throws {@link OrgMismatchError} when the answer names another org than the
	 * one the local profile was created under: a misconfigured profile or a lying
	 * server, and either way nothing in the answer is trusted.
	 */
	async whoami(opts?: { signal?: AbortSignal }) {
		const raw = await this.http.get<unknown>("/whoami", {
			signal: opts?.signal,
			operation: "whoami",
		});
		const who = parse(WhoAmISchema, raw);
		const local = this.http.localOrgId;
		if (local !== undefined && who.org.id.toLowerCase() !== local.toLowerCase()) {
			throw new OrgMismatchError(local, who.org.id);
		}
		return who;
	}

	/**
	 * Create a new agent whose keys are derived from the org's custody.
	 *
	 * Flow:
	 *   1. Load the branch's custody from the owner directory or the runtime config directory
	 *      and derive the agent's generation-0 keys under a client-minted id.
	 *   2. POST `/agents` with the id, the key material and the branch-signed
	 *      certificate (the same body builder as `rotateKeys`).
	 *   3. Save the leaf keys under `{configDir}/keys/{agentId}/`, publish MLS
	 *      KeyPackages and name the agent in a profile if the profile name is free.
	 *
	 * The keys are derived, so a crash between the POST and the save loses
	 * nothing: `rine org recover` rebuilds the files from the phrase.
	 */
	async createAgent(
		name: string,
		opts?: CreateAgentOptions,
	): Promise<CreateAgentResult> {
		const { signal, verifyIdentity, svid, branch, human_oversight, unlisted } =
			opts ?? {};
		requireConfigDir(this.http.configDir, "createAgent");
		const custody = loadCustody(this.http.custodyDirs(), branch ?? "main");
		const mintedId = crypto.randomUUID();
		const { body, keys } = agentCreateRequest(custody, mintedId, {
			name,
			humanOversight: human_oversight,
			unlisted,
		});
		const raw = await this.http.post<unknown>("/agents", body, {
			signal,
			operation: "createAgent",
		});
		const agent = parse(AgentReadSchema, raw);
		await persistCreatedAgent(
			this.http.getCoreHttpClient({ signal }),
			this.http.custodyDirs(),
			this.http.profile,
			custody,
			agent,
			mintedId,
			keys,
		);
		return {
			...agent,
			...(await verifyNewAgent(this.spiffePoster(signal), agent.id, {
				verifyIdentity,
				svid,
			})),
		};
	}

	/**
	 * Prove control of a SPIFFE identity for `agentId`, elevating the org to
	 * trust tier 2. Delegates the challenge → SVID → verify orchestration to
	 * rine-core's `verifyIdentitySpiffe`; this method only bridges the SDK HTTP
	 * client and pins the telemetry `operation` label.
	 *
	 * Throws `SpiffeVerificationError` (re-exported from `@rine-network/core`)
	 * when no SVID can be obtained — never a silent no-op — and propagates the
	 * typed `RineApiError` hierarchy for server 4xx/5xx responses.
	 *
	 * Route: `POST /agents/{id}/verify-svid/challenge` then
	 * `POST /agents/{id}/verify-svid`.
	 */
	async verifyIdentity(
		agentId: AgentUuid,
		opts?: VerifyIdentityOptions,
	): Promise<VerifyIdentityResult> {
		return verifyIdentitySpiffe(
			this.spiffePoster(opts?.signal),
			agentId,
			{ svid: opts?.svid, log: opts?.log },
		);
	}

	/** Bridges the SDK client to core's SPIFFE flow, pinning the telemetry label. */
	private spiffePoster(signal?: AbortSignal) {
		return {
			post: (path: string, requestBody?: unknown) =>
				this.http.post<unknown>(path, requestBody, {
					signal,
					operation: "verifyIdentity",
				}),
		};
	}

	async listAgents(opts?: { includeRevoked?: boolean }) {
		const raw = await this.http.get<unknown>("/agents", {
			params: { include_revoked: opts?.includeRevoked },
			operation: "listAgents",
		});
		return parseCursorPage(AgentReadSchema, raw).items;
	}

	async getAgent(agentId: AgentUuid) {
		const raw = await this.http.get<unknown>(`/agents/${agentId}`, {
			operation: "getAgent",
		});
		return parse(AgentReadSchema, raw);
	}

	async updateAgent(agentId: AgentUuid, patch: UpdateAgentPatch) {
		const raw = await this.http.patch<unknown>(`/agents/${agentId}`, patch, {
			operation: "updateAgent",
		});
		return parse(AgentReadSchema, raw);
	}

	async revokeAgent(agentId: AgentUuid) {
		const raw = await this.http.delete<unknown>(`/agents/${agentId}`, {
			operation: "revokeAgent",
		});
		return parse(AgentReadSchema, raw);
	}

	/**
	 * Rotate this agent to its next key generation and move its seats to it.
	 *
	 * Route: `GET /agents/{id}/keys` (branch and current generation), then
	 * `POST /agents/{id}/keys` with the next generation's keys and a fresh
	 * certificate. The keys derive from the org's custody; the leaf files are
	 * rewritten after the server accepts the body. Only that step can throw:
	 * `key_packages` and `group_seats` report what this host managed to move.
	 */
	async rotateKeys(agentId: AgentUuid, opts?: RotateKeysOptions) {
		requireConfigDir(this.http.configDir, "rotateKeys");
		const call = { signal: opts?.signal, operation: "rotateKeys" } as const;
		const raw = await performKeyRotation(
			{
				get: (path) => this.http.get<unknown>(path, call),
				post: (path, requestBody) =>
					this.http.post<unknown>(path, requestBody, call),
			},
			this.http.custodyDirs(),
			agentId,
		);
		const settlement = await settleRotation({
			configDir: this.http.configDir,
			agentId,
			client: this.http.getCoreHttpClient({ signal: opts?.signal }),
		});
		return { ...parse(AgentReadSchema, raw), ...settlement };
	}

	async getAgentCard(agentId: AgentUuid) {
		const raw = await this.http.get<unknown>(`/agents/${agentId}/card`, {
			unauthenticated: true,
			operation: "getAgentCard",
		});
		return parse(AgentCardSchema, raw);
	}

	/**
	 * Upsert an agent card.
	 *
	 * Body shape: `{name, description, version?, is_public?, skills?, rine?}`
	 * where `categories`, `languages` and `pricing_model` are nested inside
	 * the `rine` sub-object.
	 */
	async setAgentCard(agentId: AgentUuid, card: AgentCardInput) {
		const body = toAgentCardBody(card);
		const raw = await this.http.put<unknown>(`/agents/${agentId}/card`, body, {
			operation: "setAgentCard",
		});
		return parse(AgentCardSchema, raw);
	}

	async deleteAgentCard(agentId: AgentUuid): Promise<void> {
		await this.http.delete(`/agents/${agentId}/card`, {
			operation: "deleteAgentCard",
		});
	}

	/**
	 * Regenerate the agent's poll token.
	 *
	 * Route: `POST /agents/{id}/poll-token` — the old `/poll-token/regenerate`
	 * path never existed on the server.
	 */
	async regeneratePollToken(agentId: AgentUuid) {
		const raw = await this.http.post<unknown>(
			`/agents/${agentId}/poll-token`,
			undefined,
			{ operation: "regeneratePollToken" },
		);
		return parse(PollTokenResponseSchema, raw);
	}

	async revokePollToken(agentId: AgentUuid): Promise<void> {
		await this.http.delete(`/agents/${agentId}/poll-token`, {
			operation: "revokePollToken",
		});
	}

	async getQuotas() {
		const raw = await this.http.get<unknown>("/org/quotas", {
			operation: "getQuotas",
		});
		return parse(OrgQuotasSchema, raw);
	}

	// -----------------------------------------------------------------------
	// Org lifecycle
	// -----------------------------------------------------------------------

	/** Lazy-cached org ID for erase/export URL paths. */
	private cachedOrgId: string | null = null;

	/** Fetch the caller's org UUID, caching on the instance. */
	private async getOrgId(opts?: { signal?: AbortSignal }): Promise<string> {
		if (this.cachedOrgId) return this.cachedOrgId;
		const info = await this.whoami(opts);
		this.cachedOrgId = info.org.id;
		return this.cachedOrgId;
	}

	async updateOrg(
		patch: UpdateOrgPatch,
		opts?: { signal?: AbortSignal },
	): Promise<OrgRead> {
		const body: Record<string, unknown> = {};
		if (patch.name !== undefined) body.name = patch.name;
		if (patch.contact_email !== undefined)
			body.contact_email = patch.contact_email;
		if (patch.country_code !== undefined)
			body.country_code = patch.country_code;
		if (patch.slug !== undefined) body.slug = patch.slug;
		const raw = await this.http.patch<unknown>("/org", body, {
			signal: opts?.signal,
			operation: "updateOrg",
		});
		const org = parse(OrgReadSchema, raw);
		// Warm the org-id cache so subsequent eraseOrg/exportOrg skip whoami.
		this.cachedOrgId = org.id;
		return org;
	}

	async eraseOrg(
		opts: EraseOrgOptions,
	): Promise<ErasureResult> {
		if (opts.confirm !== true) {
			throw new RineError(
				"eraseOrg() permanently destroys all data. " +
				"Pass { confirm: true } to proceed.",
			);
		}
		const orgId = await this.getOrgId({ signal: opts.signal });
		const raw = await this.http.delete<unknown>(`/orgs/${orgId}`, {
			signal: opts.signal,
			operation: "eraseOrg",
		});
		return parse(ErasureResultSchema, raw);
	}

	async exportOrg(
		opts?: { signal?: AbortSignal },
	): Promise<unknown[]> {
		const orgId = await this.getOrgId(opts);
		const res = await this.http.get<unknown>(`/orgs/${orgId}/export`, {
			signal: opts?.signal,
			extraHeaders: { Accept: "application/x-ndjson" },
			operation: "exportOrg",
		});
		// Server returns NDJSON — but the SDK HTTP layer auto-parses JSON.
		// If the response came back as an array, return it directly.
		if (Array.isArray(res)) return res;
		// If it came back as a string (raw NDJSON), parse line-by-line.
		if (typeof res === "string") {
			return res
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as unknown);
		}
		// Single object — wrap in array for consistent return type.
		return [res];
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Guard against the `SDKHttpClient` default `_configDir = ""` footgun: with
 * an empty configDir, `saveAgentKeys` resolves `keys/{agentId}` against
 * `process.cwd()` and silently writes private keys into the caller's working
 * directory. Any method that persists keypairs must call this first.
 */
function requireConfigDir(configDir: string, method: string): void {
	if (configDir === "") {
		throw new Error(
			`${method}() requires a non-empty SDK configDir — pass one via ` +
				"new AsyncRineClient({ configDir }) so private keys persist " +
				"under {configDir}/keys/{agentId}/ instead of the current working directory.",
		);
	}
}

function toAgentCardBody(card: AgentCardInput): Record<string, unknown> {
	const rine: Record<string, unknown> = {};
	if (card.categories !== undefined) rine["categories"] = card.categories;
	if (card.languages !== undefined) rine["languages"] = card.languages;
	if (card.pricing_model !== undefined)
		rine["pricing_model"] = card.pricing_model;

	const body: Record<string, unknown> = {
		name: card.name,
		description: card.description,
	};
	if (card.version !== undefined) body["version"] = card.version;
	if (card.is_public !== undefined) body["is_public"] = card.is_public;
	if (card.skills !== undefined) body["skills"] = card.skills;
	if (Object.keys(rine).length > 0) body["rine"] = rine;
	return body;
}
