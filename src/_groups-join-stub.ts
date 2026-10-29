// Support for the `groups.join()` MLS wiring suites: not part of the published
// surface (see tsconfig.build.json, `src/_*.ts`).
import { vi } from "vitest";
import type { SDKHttpClient } from "./api/http.js";
import { ConflictError } from "./errors-classes.js";
import type { MessagesResource } from "./resources/messages.js";
import type { GroupUuid } from "./types.js";

export const GROUP_ID = "33333333-3333-4333-8333-333333333333" as GroupUuid;
export const AGENT_ID = "11111111-1111-4111-8111-111111111111";
export const CONFIG_DIR = "/tmp/rine-mls-join";

export const MEMBER_ROW = {
	id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	group_id: GROUP_ID,
	agent_id: AGENT_ID,
	role: "member",
	joined_at: "2026-04-12T00:00:00.000Z",
	agent_handle: "bot@acme.rine.network",
};

/** The 409 a join earns when the agent is already seated, as the SDK raises it. */
export function alreadyAMember(): Error {
	const err = new ConflictError("Agent is already a member of this group");
	err.code = "already_a_member";
	return err;
}

export interface Stub {
	http: SDKHttpClient;
	paths: string[];
}

// HTTP stub: records the paths it is asked for. `join` answers the join POST,
// `members` the roster the 409 path reads once.
export function makeHttp(
	join: () => Promise<{ status: number; body: unknown }> = async () => ({
		status: 200,
		body: MEMBER_ROW,
	}),
	members: unknown[] = [MEMBER_ROW],
): Stub {
	const paths: string[] = [];
	const http = {
		configDir: CONFIG_DIR,
		getCoreHttpClient: () => ({ __core: true }),
		async get<T>(p: string): Promise<T> {
			paths.push(p);
			return { items: members } as T;
		},
		async postWithStatus(p: string) {
			paths.push(p);
			return join();
		},
	} as unknown as SDKHttpClient;
	return { http, paths };
}

// Minimal MessagesResource stand-in: only `resolveSenderId` is used by the
// MLS lifecycle hooks. Resolving it is what binds the acting agent.
export function makeMessages(): MessagesResource {
	return {
		resolveSenderId: vi.fn(async () => AGENT_ID),
	} as unknown as MessagesResource;
}

/** What the establishment answers, as its result shape. */
export const outcome = (o: string, extra: Record<string, unknown> = {}) => ({
	outcome: o,
	...extra,
});
