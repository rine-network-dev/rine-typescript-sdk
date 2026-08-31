/**
 * `GroupsResource.get` refuses a read that is about another group.
 *
 * This is the read every MLS flow starting from a bare group id comes through,
 * and `installMlsWelcomesIfMls` scopes its Welcome pass by what it returns.
 * Before the check, a server answering `GET /groups/X` with a body naming Y made
 * that scope match no refusal at all: `pickRefusal` returned `undefined`, a
 * Welcome this client had REFUSED was withheld instead of raised, and the join
 * reported success holding no MLS state and printing no message.
 *
 * The honest direction is tested too, and it is the one that matters more — a
 * check that refuses legitimate reads is worse for every user than the answer
 * it rejects.
 */

import { describe, expect, it } from "vitest";
import { GroupIdentityMismatchError } from "../errors.js";
import { GroupsResource } from "./groups.js";

type SDKHttpClient = import("../api/http.js").SDKHttpClient;
type GroupUuid = import("../types.js").GroupUuid;

const GROUP_ID = "33333333-3333-4333-8333-333333333333" as GroupUuid;
const OTHER_GROUP_ID = "66666666-6666-4666-8666-666666666666";

/** An HTTP stub whose `GET /groups/{id}` answers with the id it is given. */
function makeHttp(answeredId: string): SDKHttpClient {
	return {
		configDir: "/tmp/rine-groups-identity",
		async get<T>(): Promise<T> {
			return {
				id: answeredId,
				name: "dev",
				handle: "#dev@acme.rine.network",
				created_at: "2026-08-03T00:00:00.000Z",
				mls_group_id: null,
				mls_pending: false,
			} as T;
		},
	} as unknown as SDKHttpClient;
}

describe("GroupsResource.get checks the identity of what it read", () => {
	it("test_get_when_the_response_names_another_group_then_it_is_refused", async () => {
		const groups = new GroupsResource(makeHttp(OTHER_GROUP_ID));

		const err = await groups.get(GROUP_ID).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(GroupIdentityMismatchError);
		expect((err as GroupIdentityMismatchError).requestedGroupId).toBe(GROUP_ID);
		expect((err as GroupIdentityMismatchError).answeredGroupId).toBe(
			OTHER_GROUP_ID,
		);
	});

	it("test_get_when_the_response_names_the_group_asked_for_then_it_is_returned", async () => {
		const groups = new GroupsResource(makeHttp(GROUP_ID));

		const group = await groups.get(GROUP_ID);

		expect(group.id).toBe(GROUP_ID);
	});

	it("test_get_when_the_response_differs_only_in_case_then_it_is_returned", async () => {
		// A UUID is case-insensitive, and refusing on case alone would break honest
		// servers for nothing. `pickRefusal` compares the same way downstream.
		const groups = new GroupsResource(makeHttp(GROUP_ID.toUpperCase()));

		const group = await groups.get(GROUP_ID);

		expect(group.id.toLowerCase()).toBe(GROUP_ID.toLowerCase());
	});
});
