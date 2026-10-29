/**
 * The SDK's typed refusal for a revoked principal.
 *
 * A revoked agent or branch is not a failed login: retrying cannot help and the
 * credentials are not at fault. The server names the scope in the error code on
 * a bearer route and in `reason` on the token mint, and both routes have to
 * surface one class so a caller catches the same thing whichever door refused.
 * These tests pin the mapping from a status and a code to that class, the
 * conversion of the core error the token mint raises, and the two routes end to
 * end through the HTTP client.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the (also-hoisted) vi.mock factory can close over the spy.
const { getTokenSpy } = vi.hoisted(() => ({
	getTokenSpy: vi.fn(async () => "stub-token"),
}));

vi.mock("@rine-network/core", async () => {
	const actual =
		await vi.importActual<typeof import("@rine-network/core")>(
			"@rine-network/core",
		);
	return {
		...actual,
		getOrRefreshToken: getTokenSpy,
	};
});

import {
	PrincipalRevokedError as CorePrincipalRevokedError,
	RineApiError as CoreRineApiError,
	type RevokedScope,
	isPrincipalRevokedError,
} from "@rine-network/core";
import {
	type CustodyFixture,
	makeCustodyFixture,
	seedAgent,
} from "@rine-network/core/testing";
import { SDKHttpClient } from "./api/http.js";
import {
	AuthenticationError,
	AuthorizationError,
	PrincipalRevokedError,
	RineApiError,
	RineError,
	ValidationError,
	raiseForStatus,
	sdkErrorFromCore,
} from "./errors.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

/** The two scopes a revoked principal can be named with, and their codes. */
const REVOKED_CASES: ReadonlyArray<{
	name: string;
	code: string;
	scope: RevokedScope;
}> = [
	{
		name: "test_raise_for_status_when_a_401_names_a_revoked_agent_then_it_throws_the_typed_error_with_the_agent_scope",
		code: "agent_revoked",
		scope: "agent",
	},
	{
		name: "test_raise_for_status_when_a_401_names_a_revoked_branch_then_it_throws_the_typed_error_with_the_branch_scope",
		code: "branch_revoked",
		scope: "branch",
	},
];

/** The object a throwing call raised, or a failure when it did not throw. */
function raisedBy(fn: () => never): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

describe("raiseForStatus for a revoked principal", () => {
	it.each(REVOKED_CASES)("$name", ({ code, scope }) => {
		const raised = raisedBy(() =>
			raiseForStatus(401, "The principal is revoked", undefined, code),
		);

		expect(raised).toBeInstanceOf(PrincipalRevokedError);
		expect(raised).toBeInstanceOf(AuthenticationError);
		expect(raised).toBeInstanceOf(RineApiError);
		expect((raised as PrincipalRevokedError).scope).toBe(scope);
		expect((raised as RineApiError).status).toBe(401);
		expect((raised as RineApiError).code).toBe(code);
	});

	it("test_raise_for_status_when_a_401_has_no_code_then_it_throws_a_plain_authentication_error", () => {
		const raised = raisedBy(() => raiseForStatus(401, "Authentication failed"));

		expect(raised).toBeInstanceOf(AuthenticationError);
		expect(raised).not.toBeInstanceOf(PrincipalRevokedError);
	});

	it("test_raise_for_status_when_a_non_401_carries_a_revoked_code_then_it_is_not_the_typed_error", () => {
		const forbidden = raisedBy(() =>
			raiseForStatus(403, "Permission denied", undefined, "agent_revoked"),
		);
		expect(forbidden).toBeInstanceOf(AuthorizationError);
		expect(forbidden).not.toBeInstanceOf(PrincipalRevokedError);

		const invalid = raisedBy(() =>
			raiseForStatus(422, "Validation error", undefined, "agent_revoked"),
		);
		expect(invalid).toBeInstanceOf(ValidationError);
		expect(invalid).not.toBeInstanceOf(PrincipalRevokedError);
	});
});

describe("sdkErrorFromCore", () => {
	it("test_sdk_error_from_core_when_the_core_error_is_revoked_then_the_sdk_error_carries_scope_detail_and_code", () => {
		const core = new CorePrincipalRevokedError(
			"agent",
			"The principal is revoked",
			undefined,
			"agent_revoked",
		);

		const converted = sdkErrorFromCore(core);

		expect(converted).toBeInstanceOf(PrincipalRevokedError);
		expect((converted as PrincipalRevokedError).scope).toBe("agent");
		expect((converted as RineApiError).detail).toBe("The principal is revoked");
		expect((converted as RineApiError).code).toBe("agent_revoked");
	});

	it("test_sdk_error_from_core_when_the_error_is_not_revoked_then_it_comes_back_unchanged", () => {
		const plain = new Error("unrelated");
		expect(sdkErrorFromCore(plain)).toBe(plain);

		const coreApi = new CoreRineApiError(500, "boom");
		expect(sdkErrorFromCore(coreApi)).toBe(coreApi);
	});
});

describe("SDKHttpClient revoked-principal refusals", () => {
	let fx: CustodyFixture;

	beforeEach(() => {
		getTokenSpy.mockReset();
		getTokenSpy.mockResolvedValue("stub-token");
		fx = makeCustodyFixture();
		seedAgent(fx, AGENT_ID);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		fx.cleanup();
	});

	function client(): SDKHttpClient {
		return new SDKHttpClient({
			apiUrl: "https://api.test",
			configDir: fx.dirs.configDir,
			ownerDir: fx.dirs.ownerDir,
			profile: "agent",
		});
	}

	it("test_fetch_with_auth_when_the_token_mint_names_a_revoked_agent_then_the_request_rejects_with_the_typed_error", async () => {
		getTokenSpy.mockRejectedValue(
			new CorePrincipalRevokedError(
				"agent",
				"The principal is revoked",
				undefined,
				"agent_revoked",
			),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("{}", {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);

		const raised = await client()
			.get("/agents", { operation: "poll" })
			.catch((error: unknown) => error);

		expect(raised).toBeInstanceOf(PrincipalRevokedError);
		expect((raised as PrincipalRevokedError).scope).toBe("agent");
		expect((raised as RineApiError).code).toBe("agent_revoked");
	});

	it("test_fetch_with_auth_when_a_bearer_route_names_a_revoked_branch_then_the_request_rejects_with_the_typed_error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "branch_revoked" }), {
						status: 401,
						headers: { "content-type": "application/json" },
					}),
			),
		);

		const raised = await client()
			.get("/agents", { operation: "poll" })
			.catch((error: unknown) => error);

		expect(raised).toBeInstanceOf(PrincipalRevokedError);
		expect((raised as PrincipalRevokedError).scope).toBe("branch");
		expect((raised as RineApiError).code).toBe("branch_revoked");
	});
});

describe("the two classes of one refusal", () => {
	it("test_is_principal_revoked_error_when_either_stacks_class_is_given_then_both_are_recognised", () => {
		const core = new CorePrincipalRevokedError("agent", "revoked");
		const sdk = new PrincipalRevokedError("agent");

		expect(isPrincipalRevokedError(core)).toBe(true);
		expect(isPrincipalRevokedError(sdk)).toBe(true);
	});

	it("test_rine_error_when_core_raised_the_revoked_refusal_then_it_is_still_a_rine_error", () => {
		const core = new CorePrincipalRevokedError("branch", "revoked");

		expect(core instanceof RineError).toBe(true);
		expect(core instanceof AuthenticationError).toBe(false);
	});
});
