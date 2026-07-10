/**
 * Identity resource — whoami, createAgent, listAgents, getAgent, updateAgent,
 * revokeAgent, rotateKeys, agent cards, poll tokens, quotas.
 */

import {
	encryptionPublicKeyToJWK,
	generateAgentKeys,
	generatePqKeyPair,
	hasSpiffeEndpoint,
	loadAgentKeys,
	loadCredentials,
	pqPublicKeyToJWK,
	publishMlsKeyPackages,
	saveAgentKeys,
	saveCredentials,
	savePqEncryptionKey,
	signingPublicKeyToJWK,
	verifyIdentitySpiffe,
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

export interface AddPostQuantumKeyOptions {
	signal?: AbortSignal;
}

export type UpdateAgentPatch = {
	name?: string;
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
	 * Fetch the current org identity, agent list, and trust tier.
	 *
	 * Routes: `GET /agents` + `GET /org` — the server does not expose a
	 * single `/agents/whoami` endpoint, so the SDK composes the `WhoAmI`
	 * response client-side.
	 */
	async whoami(opts?: { signal?: AbortSignal }) {
		const agentsRaw = await this.http.get<unknown>("/agents", {
			signal: opts?.signal,
			operation: "whoami",
		});
		const agentsList = unwrapAgentsList(agentsRaw);
		const agents = agentsList.map((a) => parse(AgentReadSchema, a));
		const orgRaw = await this.http.get<unknown>("/org", {
			signal: opts?.signal,
			operation: "whoami",
		});
		const org = parse(OrgReadSchema, orgRaw);
		return parse(WhoAmISchema, {
			org,
			agents,
			trust_tier: org.trust_tier ?? 0,
		});
	}

	/**
	 * Create a new agent with locally generated E2EE keypairs.
	 *
	 * Flow:
	 *   1. Generate Ed25519 + X25519 keypairs via rine-core `generateAgentKeys()`.
	 *   2. POST `/agents` with `{name, human_oversight, unlisted, signing_public_key,
	 *      encryption_public_key}` (public keys as JWKs). The server's `AgentCreate`
	 *      schema is `extra="forbid"`, so no other fields may be sent on creation.
	 *   3. Persist private keys under `{configDir}/keys/{agentId}/` via
	 *      rine-core `saveAgentKeys()` so the new agent can immediately participate
	 *      in E2EE send/receive without any manual key setup.
	 *
	 * Partial failure: if the POST succeeds but `saveAgentKeys` throws, the
	 * server-side agent exists but the caller has no private keys — surfaced
	 * as the raw I/O error. Callers must treat this as a partial failure.
	 */
	async createAgent(
		name: string,
		opts?: CreateAgentOptions,
	): Promise<CreateAgentResult> {
		const { signal, verifyIdentity, svid, ...body } = opts ?? {};
		requireConfigDir(this.http.configDir, "createAgent");
		const keys = generateAgentKeys();
		const agentBody: Record<string, unknown> = {
			name,
			...body,
			signing_public_key: signingPublicKeyToJWK(keys.signing.publicKey),
			encryption_public_key: encryptionPublicKeyToJWK(
				keys.encryption.publicKey,
			),
		};
		if (keys.pqEncryption) {
			agentBody.pq_encryption_public_key = pqPublicKeyToJWK(
				keys.pqEncryption.publicKey,
			);
		}
		const raw = await this.http.post<unknown>(
			"/agents",
			agentBody,
			{ signal, operation: "createAgent" },
		);
		const agent = parse(AgentReadSchema, raw);
		saveAgentKeys(this.http.configDir, agent.id, keys);

		// Publish an initial batch of MLS KeyPackages so the agent can be added to
		// MLS groups from birth (parity with rine-core's performAgentCreation —
		// without this, a freshly SDK-created agent has no KeyPackages and any MLS
		// group invite fails 409 "No key packages available"). Best-effort: a
		// failure must never abort agent creation — the agent still works on
		// sender-key groups and KeyPackages can be republished later.
		try {
			const core = this.http.getCoreHttpClient({ signal });
			await publishMlsKeyPackages(this.http.configDir, agent.id, core);
		} catch {
			// non-fatal — agent is usable; KeyPackages can be published later
		}

		// REQ-04: persist poll_url to credentials if returned by server.
		if (agent.poll_url) {
			try {
				const creds = loadCredentials(this.http.configDir);
				if (creds.default) {
					creds.default.poll_url = agent.poll_url;
					saveCredentials(this.http.configDir, creds);
				}
			} catch {
				// Non-fatal — mirrors rine-core's performAgentCreation.
			}
		}

		// Auto-verify hook (parity with rine-core's performAgentCreation): run
		// SPIFFE verification when explicitly requested, when a SVID is supplied,
		// or when a Workload API endpoint is present. A verification failure must
		// never undo the already-created agent — capture it in `identityError`.
		if (verifyIdentity || svid || hasSpiffeEndpoint()) {
			try {
				const identity = await this.verifyIdentity(agent.id as AgentUuid, {
					svid,
					signal,
				});
				return { ...agent, identity };
			} catch (err) {
				return {
					...agent,
					identityError: err instanceof Error ? err.message : String(err),
				};
			}
		}
		return agent;
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
			{
				post: (path, requestBody) =>
					this.http.post<unknown>(path, requestBody, {
						signal: opts?.signal,
						operation: "verifyIdentity",
					}),
			},
			agentId,
			{ svid: opts?.svid, log: opts?.log },
		);
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
	 * Rotate this agent's signing + encryption keypairs.
	 *
	 * Route: `POST /agents/{id}/keys`.
	 *
	 * Generates fresh Ed25519 + X25519 keypairs locally, uploads the public
	 * halves to the server (JWK-encoded), then overwrites the on-disk private
	 * keys via `saveAgentKeys()`.
	 *
	 * Key rotation is visible to future peers immediately; messages encrypted
	 * to the previous encryption key can still be decrypted as long as the
	 * caller retains a copy of the old private key out-of-band (the SDK does
	 * not keep a history of rotated-out keys).
	 *
	 * Partial failure: if the POST succeeds but `saveAgentKeys` throws mid-write,
	 * the server has the new public keys while the on-disk state may be
	 * inconsistent (`saveAgentKeys` writes signing.key then encryption.key as
	 * two separate file ops, not atomically). Senders will encrypt to the new
	 * keys the server advertises but the client may still hold the old private
	 * half — silent decryption failure. Track as rine-core follow-up.
	 */
	async rotateKeys(agentId: AgentUuid, opts?: RotateKeysOptions) {
		requireConfigDir(this.http.configDir, "rotateKeys");
		const keys = generateAgentKeys();
		const keysBody: Record<string, unknown> = {
			signing_public_key: signingPublicKeyToJWK(keys.signing.publicKey),
			encryption_public_key: encryptionPublicKeyToJWK(
				keys.encryption.publicKey,
			),
		};
		if (keys.pqEncryption) {
			keysBody.pq_encryption_public_key = pqPublicKeyToJWK(
				keys.pqEncryption.publicKey,
			);
		}
		const raw = await this.http.post<unknown>(
			`/agents/${agentId}/keys`,
			keysBody,
			{ signal: opts?.signal, operation: "rotateKeys" },
		);
		const agent = parse(AgentReadSchema, raw);
		saveAgentKeys(this.http.configDir, agentId, keys);
		return agent;
	}

	async addPostQuantumKey(agentId: AgentUuid, opts?: AddPostQuantumKeyOptions) {
		requireConfigDir(this.http.configDir, "addPostQuantumKey");
		const existingKeys = loadAgentKeys(this.http.configDir, agentId);
		if (existingKeys.pqEncryption) {
			throw new RineError(
				`Agent ${agentId} already has a post-quantum key. Use rotateKeys() to replace all keys.`,
			);
		}
		const pqKeyPair = generatePqKeyPair();
		const keysBody: Record<string, unknown> = {
			signing_public_key: signingPublicKeyToJWK(existingKeys.signing.publicKey),
			encryption_public_key: encryptionPublicKeyToJWK(existingKeys.encryption.publicKey),
			pq_encryption_public_key: pqPublicKeyToJWK(pqKeyPair.publicKey),
		};
		const raw = await this.http.post<unknown>(
			`/agents/${agentId}/keys`,
			keysBody,
			{ signal: opts?.signal, operation: "addPostQuantumKey" },
		);
		const agent = parse(AgentReadSchema, raw);
		savePqEncryptionKey(this.http.configDir, agentId, pqKeyPair);
		return agent;
	}

	async getAgentCard(agentId: AgentUuid) {
		const raw = await this.http.get<unknown>(`/agents/${agentId}/card`, {
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
	// Org lifecycle — REQ-05, REQ-06, REQ-07, REQ-09
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

/**
 * `GET /agents` sometimes returns a bare array (paginated list default) and
 * sometimes a `{items: [...]}` envelope depending on version. Accept both.
 */
function unwrapAgentsList(raw: unknown): unknown[] {
	if (Array.isArray(raw)) return raw;
	if (
		typeof raw === "object" &&
		raw !== null &&
		"items" in raw &&
		Array.isArray((raw as { items: unknown }).items)
	) {
		return (raw as { items: unknown[] }).items;
	}
	return [];
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
