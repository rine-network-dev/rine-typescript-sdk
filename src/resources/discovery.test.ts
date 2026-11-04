/**
 * Directory discovery — what a stranger can learn about a group they are not in.
 *
 * `discoverGroups()` is the one call that answers "may I simply join this, or
 * will it make me wait for a vote". The answer is the server's
 * `enrollment_policy`, and a schema that does not declare it parses it away
 * silently: zod's `z.object()` strips unknown keys, so the field arrives, is
 * dropped, and every discovered group looks alike to the caller.
 *
 * These drive the resource rather than the schema so the assertion covers the
 * path a consumer actually takes — a test against `GroupSummarySchema` directly
 * would pass while `discoverGroups()` still handed back a stripped object.
 */

import { describe, expect, it } from "vitest";
import { DiscoveryResource } from "./discovery.js";

type SDKHttpClient = import("../api/http.js").SDKHttpClient;

/** Serves one directory page and records the path and options it was asked with. */
function discoveryStub(items: unknown[]): {
	discovery: DiscoveryResource;
	paths: string[];
	options: Record<string, unknown>[];
} {
	const paths: string[] = [];
	const options: Record<string, unknown>[] = [];
	const http = {
		async get<T>(path: string, opts: Record<string, unknown>): Promise<T> {
			paths.push(path);
			options.push(opts);
			return { items, total: items.length, next_cursor: null } as T;
		},
	} as unknown as SDKHttpClient;
	return { discovery: new DiscoveryResource(http), paths, options };
}

const group = (over: Record<string, unknown> = {}) => ({
	id: "11111111-1111-4111-8111-111111111111",
	name: "Parts Traders",
	handle: "#parts@acme",
	description: null,
	visibility: "public",
	member_count: 12,
	...over,
});

describe("discoverGroups and the enrollment policy", () => {
	it("open_policy_when_discovered_survives_the_parse", async () => {
		const { discovery } = discoveryStub([group({ enrollment_policy: "open" })]);
		const page = await discovery.discoverGroups();
		expect(page.items[0]?.enrollment_policy).toBe("open");
	});

	it("every_policy_the_server_can_send_reaches_the_caller_unchanged", async () => {
		// The four the server declares (`group_schemas.py`). A stranger has to be
		// able to tell the self-joinable one from the three that gate on a
		// decision, which is the whole point of showing the field.
		for (const policy of ["open", "closed", "majority", "unanimity"]) {
			const { discovery } = discoveryStub([
				group({ enrollment_policy: policy }),
			]);
			const page = await discovery.discoverGroups();
			expect(page.items[0]?.enrollment_policy).toBe(policy);
		}
	});

	it("a_policy_this_sdk_predates_degrades_rather_than_dropping_the_page", async () => {
		// Loose `string`, not an enum: a server that adds a fifth policy must not
		// cost this caller the entire directory page.
		const { discovery } = discoveryStub([
			group({ enrollment_policy: "invite-only-v2" }),
		]);
		const page = await discovery.discoverGroups();
		expect(page.items[0]?.enrollment_policy).toBe("invite-only-v2");
	});

	it("an_omitted_policy_defaults_closed_so_the_caller_is_never_told_to_walk_in", async () => {
		// Absent means "ask" — defaulting the other way would invite a stranger to
		// self-join a group that will refuse them.
		const { discovery } = discoveryStub([group()]);
		const page = await discovery.discoverGroups();
		expect(page.items[0]?.enrollment_policy).toBe("closed");
	});

	it("discovery_when_called_reads_the_directory_route", async () => {
		const { discovery, paths } = discoveryStub([]);
		await discovery.discoverGroups();
		expect(paths).toEqual(["/directory/groups"]);
	});

	it("discovery_when_called_asks_for_no_credentials", async () => {
		const { discovery, options } = discoveryStub([]);
		await discovery.discoverGroups();
		expect(options[0]).toMatchObject({ unauthenticated: true });
	});

	it("the_rest_of_the_summary_is_unchanged_by_the_added_field", async () => {
		const { discovery } = discoveryStub([
			group({ enrollment_policy: "majority" }),
		]);
		const page = await discovery.discoverGroups();
		const first = page.items[0];
		expect(first?.handle).toBe("#parts@acme");
		expect(first?.name).toBe("Parts Traders");
		expect(first?.member_count).toBe(12);
		expect(first?.visibility).toBe("public");
	});
});
