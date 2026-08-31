/**
 * What `groups.resolveRef` answers with, and what handing that answer back
 * to a group verb costs.
 *
 * Three claims, and the third is the boundary on the second:
 *
 *   1. `resolveRef` answers the group's RECORD — id, handle, spelling, row —
 *      and not the bare id it used to. The four fields carry the same meanings
 *      as `rine-core`'s `SeatedGroupTarget` and the Python SDK's
 *      `rine.GroupTarget`, plus this package's two guarantees: the id is
 *      branded and the row has crossed `GroupReadSchema`.
 *   2. A verb that reads the group BEFORE it writes takes that record
 *      (`GroupSelector`) and then reads no group of its own. Handing it `.id`
 *      instead buys the same row a second time — which is exactly what every
 *      caller used to do, because an id was all there was to hand over.
 *   3. 🔴 `invite` and `vote` accept the record and buy the row ANYWAY. Their
 *      read happens after their own POST and exists to see what that POST did,
 *      so serving it from a row read before the POST is not a saving but a
 *      wrong answer — and one no id comparison can catch, because the id is
 *      right and the contents are stale. A post-mutation read is never folded,
 *      and the rule that an invite to a voting group mints no leaf is enforced
 *      on this client alone. The two staleness gates below are the proof, and
 *      they are the ones that go RED if a later change widens the seam onto
 *      them.
 *
 * 🔴 The saving is measured, not asserted structurally: each verb is run twice
 * against a fresh recording client, once with `target.id` and once with
 * `target`, and the `GET /groups/{id}` calls are counted. `target.id` is the
 * call shape callers used before the record existed, byte for byte, so the
 * first run is the BEFORE column and the second is the AFTER.
 *
 * The default group is a sender-key one (`mls_group_id: null`) so the MLS add
 * no-ops and the count is about the group read alone; the staleness gates pick
 * their own rows precisely because that regime is the one in which a stale row
 * cannot be told from a fresh one. The `rine-core` entry points that would
 * touch key material or the network are mocked at the module edge.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const recoverGroupMock = vi.fn();
const resumeMlsGroupAdmissionMock = vi.fn();
const sendGroupInviteNotificationMock = vi.fn();
// 🔴 The MLS commit itself, mocked so that "which row decided the regime" is
// directly observable. `addMembersToMls` gates on `groupIsMls(group)` and
// reaches this the moment that answer is true — so a call here IS the assertion
// that the row the verb read said "MLS", and no call IS the assertion that it
// said "sender key" or that a nomination stopped it short.
// The real `MlsAdmissionResult` shape, because `addMembersToMls` SWALLOWS
// every throw into a console.warn — a wrong-shaped stub makes `warnUnseated`
// die on `outcomes.filter`, the call still counts, and the assertion below
// passes while the seating path did nothing.
const addMlsGroupMembersMock = vi.fn(async (..._a: unknown[]) => ({
	epoch: 1,
	commits: 1,
	added: 1,
	outcomes: [] as { agentId: string; status: string; reason?: string }[],
}));

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		// `resolveGroup` is deliberately NOT mocked: the record under test is the
		// one the real ladder produces.
		recoverGroup: (...a: unknown[]) => recoverGroupMock(...a),
		resumeMlsGroupAdmission: (...a: unknown[]) =>
			resumeMlsGroupAdmissionMock(...a),
		sendGroupInviteNotification: (...a: unknown[]) =>
			sendGroupInviteNotificationMock(...a),
		addMlsGroupMembers: (...a: unknown[]) => addMlsGroupMembersMock(...a),
	};
});

const { GroupsResource } = await import("./groups.js");

type SDKHttpClient = import("../api/http.js").SDKHttpClient;
type MessagesResource = import("./messages.js").MessagesResource;
type GroupSelector = import("./groups-resolve.js").GroupSelector;
type AgentUuid = import("../types.js").AgentUuid;
type GroupUuid = import("../types.js").GroupUuid;

const GROUP_ID = "5f1c9d2e-0000-4000-8000-00000000aaaa";
const OTHER_GROUP_ID = "5f1c9d2e-0000-4000-8000-00000000bbbb";
const HANDLE = "#ops@acme.rine.network";
const ACTING_ID = "5f1c9d2e-0000-4000-8000-00000000cccc";
const APPLICANT_ID = "5f1c9d2e-0000-4000-8000-00000000dddd" as AgentUuid;
const REQUEST_ID = "5f1c9d2e-0000-4000-8000-00000000eeee";
// Never created: `retireLocalState` asks the filesystem whether this agent has
// keys at all, and the answer has to be no for the leave to touch nothing.
const CONFIG_DIR = "/nonexistent/rine-resolved-target";

/** The wire body both the resolver and `groups.get` read. */
const GROUP_ROW = {
	id: GROUP_ID,
	name: "ops",
	handle: HANDLE,
	created_at: "2026-01-01T00:00:00Z",
	enrollment_policy: "closed",
	mls_group_id: null,
};

interface Seen {
	/** Paths the SDK client fetched — where a verb's own group read lands. */
	readonly sdk: string[];
	/** Paths the core client fetched — where the resolve lands. */
	readonly core: string[];
}

function groupReads(paths: readonly string[]): string[] {
	return paths.filter((p) => p === `/groups/${GROUP_ID}`);
}

/**
 * The recording client.
 *
 * 🔴 Every route is registered by its WHOLE path and anything else THROWS.
 * A blanket `return row` reads green for a verb that fetched the wrong group
 * entirely — `groupReads()` filters on the exact `/groups/${GROUP_ID}`, so a
 * read of `/groups/${OTHER_GROUP_ID}` or `/groups/undefined` would be both
 * answered and uncounted, and the AFTER column would report a saving that was
 * really a misdirected read. The MCP harness beside it does the same strict
 * thing.
 *
 * `row` is what the RESOLVE sees (so it is the row the record carries);
 * `serverRow` is what the verb's own `GET /groups/{id}` sees. They are the same
 * object unless a test is about the gap between them.
 */
function makeGroups(
	opts: {
		readonly row?: unknown;
		readonly serverRow?: unknown;
		readonly serverGroupReadThrows?: Error;
	} = {},
): {
	groups: InstanceType<typeof GroupsResource>;
	seen: Seen;
} {
	const row = opts.row ?? GROUP_ROW;
	const serverRow = opts.serverRow ?? row;
	const seen: Seen = { sdk: [], core: [] };
	const http = {
		configDir: CONFIG_DIR,
		getCoreHttpClient: () => ({
			// 🔴 The group's OWN route answers a row; `/groups` answers a page.
			// The ladder is split across the two, so a stub that answered one
			// shape to both hands the UUID rung a page where a row belongs.
			get: async (path: string) => {
				seen.core.push(path);
				if (path === `/groups/${GROUP_ID}`) return row;
				if (path === "/groups" || path.startsWith("/groups?")) {
					return { items: [row] };
				}
				throw new Error(`unregistered core route: GET ${path}`);
			},
		}),
		async get<T>(path: string): Promise<T> {
			seen.sdk.push(path);
			if (path === `/groups/${GROUP_ID}`) {
				if (opts.serverGroupReadThrows) throw opts.serverGroupReadThrows;
				return serverRow as T;
			}
			if (path === `/groups/${GROUP_ID}/requests`) {
				return {
					items: [
						{
							id: REQUEST_ID,
							group_id: GROUP_ID,
							agent_id: APPLICANT_ID,
							status: "pending",
							created_at: "2026-01-01T00:00:00Z",
						},
					],
				} as T;
			}
			throw new Error(`unregistered SDK route: GET ${path}`);
		},
		async post<T>(path: string): Promise<T> {
			seen.sdk.push(`POST ${path}`);
			if (path === `/groups/${GROUP_ID}/invite`) return { status: "pending" } as T;
			if (path === `/groups/${GROUP_ID}/requests/${REQUEST_ID}/vote`) {
				return {
					request_id: REQUEST_ID,
					your_vote: "approve",
					status: "approved",
				} as T;
			}
			throw new Error(`unregistered SDK route: POST ${path}`);
		},
		async delete(path: string): Promise<void> {
			seen.sdk.push(`DELETE ${path}`);
			if (!path.startsWith(`/groups/${GROUP_ID}/members/`)) {
				throw new Error(`unregistered SDK route: DELETE ${path}`);
			}
		},
	} as unknown as SDKHttpClient;
	const messages = {
		resolveSenderId: vi.fn(async () => ACTING_ID),
	} as unknown as MessagesResource;
	return { groups: new GroupsResource(http, messages), seen };
}

interface Verb {
	readonly name: string;
	readonly run: (
		groups: InstanceType<typeof GroupsResource>,
		group: GroupSelector,
	) => Promise<unknown>;
}

/**
 * The four verbs whose group read happens BEFORE their own write, so the
 * resolve's row is a correct answer to it.
 *
 * 🔴 The list is the contract `GroupSelector` states in prose. A verb added to
 * the seam without a row here would be measured by nothing, and a verb whose
 * widening is reverted fails on the AFTER column rather than silently going
 * back to paying twice.
 */
const FOLDING_VERBS: readonly Verb[] = [
	{ name: "removeMember", run: (g, s) => g.removeMember(s, APPLICANT_ID) },
	{ name: "leave", run: (g, s) => g.leave(s) },
	{ name: "sync", run: (g, s) => g.sync(s) },
	{ name: "resumeMlsAdmission", run: (g, s) => g.resumeMlsAdmission(s) },
];

/**
 * The two verbs that take a record and buy the row anyway.
 *
 * 🔴 They are here to be pinned as NOT folding, which is the opposite of what
 * the list above asserts and the reason the two lists are separate rather than
 * one list with a flag. Their read runs after their own POST — the invite's
 * nomination filing, the vote's approval — and its whole job is to see what
 * that POST did: never fold a post-mutation read.
 */
const POST_MUTATION_VERBS: readonly Verb[] = [
	{ name: "invite", run: (g, s) => g.invite(s, APPLICANT_ID) },
	{ name: "vote", run: (g, s) => g.vote(s, REQUEST_ID, "approve") },
];

afterEach(() => {
	vi.clearAllMocks();
});

describe("groups.resolveRef answers with the group's record", () => {
	it("carries the id, the handle, the caller's spelling and the row", async () => {
		const { groups, seen } = makeGroups();

		const target = await groups.resolveRef(GROUP_ID);

		expect(target.id).toBe(GROUP_ID);
		expect(target.handle).toBe(HANDLE);
		expect(target.spelling).toBe(GROUP_ID);
		expect(target.row.id).toBe(GROUP_ID);
		// One indexed read of the group's own row, and no roster.
		expect(seen.core).toEqual([`/groups/${GROUP_ID}`]);
	});

	it("quotes the caller's own spelling back, not the handle it matched", async () => {
		// `spelling` is the only string a refusal may echo, so it has to be the
		// argument byte for byte — a short handle stays short here even though the
		// resolve normalised it to ask.
		const { groups } = makeGroups();

		const target = await groups.resolveRef("#ops@acme");

		expect(target.spelling).toBe("#ops@acme");
		expect(target.handle).toBe(HANDLE);
	});

	it("hands back a row that has crossed the SDK's own schema", async () => {
		// Not the wire object: `GroupReadSchema` fills the columns an older server
		// omits, and this row goes on to be the one `getGroup` answers with — so a
		// looser shape here would reach `groupIsMls` and the MLS hooks.
		const { groups } = makeGroups();

		const target = await groups.resolveRef(GROUP_ID);

		expect(target.row.mls_enabled).toBe(false);
		expect(target.row.member_count).toBe(0);
	});

	it("carries these four fields and no others", async () => {
		// 🔴 `ResolvedGroup` is the TypeScript face of `rine-core`'s
		// `SeatedGroupTarget`, whose Python twin is `rine.GroupTarget`. The
		// record gate is name-keyed — `RECIPIENT_RECORDS = ("GroupTarget",
		// "RecipientTarget")` — so it is blind to this type by construction, and
		// adding the name to it would only ask for a Python twin that deliberately
		// does not exist (a branded id and a Zod-parsed row are this package's).
		// What CAN be bound is the field list, here: rename `spelling` on the TS
		// side alone and this dies, which is the drift nothing else in the repo
		// can see.
		const { groups } = makeGroups();

		const target = await groups.resolveRef(GROUP_ID);

		expect(Object.keys(target).sort()).toEqual([
			"handle",
			"id",
			"row",
			"spelling",
		]);
	});
});

describe("a resolved group is acted on without buying its row again", () => {
	for (const verb of FOLDING_VERBS) {
		it(`${verb.name} reads the group once from an id and not at all from the record`, async () => {
			const byId = makeGroups();
			const target = await byId.groups.resolveRef(GROUP_ID);
			await verb.run(byId.groups, target.id);
			// BEFORE: the id call shape. The resolve paid for the row and the
			// verb bought it again one call later.
			expect(groupReads(byId.seen.core)).toHaveLength(1);
			expect(groupReads(byId.seen.sdk)).toHaveLength(1);

			const byRecord = makeGroups();
			const resolved = await byRecord.groups.resolveRef(GROUP_ID);
			await verb.run(byRecord.groups, resolved);
			// AFTER: the same one read, spent through the seam.
			expect(groupReads(byRecord.seen.core)).toHaveLength(1);
			expect(groupReads(byRecord.seen.sdk)).toHaveLength(0);
		});
	}

	for (const verb of POST_MUTATION_VERBS) {
		it(`${verb.name} buys the row anyway, because its read is after its own POST`, async () => {
			const byRecord = makeGroups();
			const resolved = await byRecord.groups.resolveRef(GROUP_ID);
			await verb.run(byRecord.groups, resolved);

			// One read for the resolve, and one the verb makes for itself. Handing
			// the record over buys nothing here and must not: see the two staleness
			// gates below for what it would cost.
			expect(groupReads(byRecord.seen.core)).toHaveLength(1);
			expect(groupReads(byRecord.seen.sdk)).toHaveLength(1);
		});
	}

	it("still answers what it always answered when handed an id", async () => {
		// The saving may not change the outcome: an id and the record naming the
		// same group are the same call.
		const byId = makeGroups();
		const target = await byId.groups.resolveRef(GROUP_ID);
		const fromId = await byId.groups.removeMember(target.id, APPLICANT_ID);

		const byRecord = makeGroups();
		const resolved = await byRecord.groups.resolveRef(GROUP_ID);
		const fromRecord = await byRecord.groups.removeMember(
			resolved,
			APPLICANT_ID,
		);

		expect(fromRecord).toEqual(fromId);
	});
});

describe("the seam refuses to answer about a group it is not a row of", () => {
	it("reads the group when the row handed in names another one", async () => {
		// 🔴 A record's id and row come out of one resolve and cannot
		// disagree — but the type does not say so, and a hand-built one can. The
		// seam is what makes that harmless: it spends `known` only for the group
		// it is a row OF, so a mismatched row costs the read it was meant to save
		// rather than answering about the wrong group. `groups.get`'s identity
		// check exists to refuse exactly that substitution; the seam must not be
		// the way around it.
		const { groups, seen } = makeGroups();
		const forged = {
			id: GROUP_ID as GroupUuid,
			handle: HANDLE,
			spelling: GROUP_ID,
			row: { ...GROUP_ROW, id: OTHER_GROUP_ID },
		} as unknown as GroupSelector;

		await groups.sync(forged);

		expect(groupReads(seen.sdk)).toHaveLength(1);
	});

	it("spends the row on a uuid spelled in another case", async () => {
		// The seam compares ids the way `get` does. An uppercase id naming the
		// same group is the same group, and re-reading it would be a saving lost
		// to a comparison nobody meant to make.
		const upper = GROUP_ID.toUpperCase();
		const { groups, seen } = makeGroups();
		const resolved = await groups.resolveRef(GROUP_ID);

		await groups.sync({ ...resolved, id: upper as GroupUuid });

		expect(groupReads(seen.sdk)).toHaveLength(0);
		expect(seen.sdk).toEqual([]);
	});
});

describe("a stale row never decides what a post-mutation read is for", () => {
	// 🔴 These two are the gates the seam has to stay off. Each hands in a
	// record whose row is a plausible EARLIER state of the same group — same id,
	// so the seam's identity check cannot tell them apart — and asserts the verb
	// acted on the server's current row instead. Widen `invite` or `vote` back
	// onto `mlsContext(row)` and both go RED.

	it("invite files a nomination the resolve could not have known about", async () => {
		// Enforced on this client alone: an invite to a
		// VOTING group must mint no ratchet-tree leaf, because the electorate may
		// deny the nominee and only the manual reclamation pass retires a leaf.
		// The policy is editable, so a record resolved while the group was
		// `closed` says `closed` forever.
		const { groups } = makeGroups({
			row: { ...GROUP_ROW, enrollment_policy: "closed", mls_group_id: "mls-1" },
			serverRow: {
				...GROUP_ROW,
				enrollment_policy: "majority",
				mls_group_id: "mls-1",
			},
		});
		const resolved = await groups.resolveRef(GROUP_ID);
		expect(resolved.row.enrollment_policy).toBe("closed");

		await groups.invite(resolved, APPLICANT_ID);

		// The fresh row says `majority`, so this is a nomination and nothing is
		// seated. Spending the record's row would read `closed`, take the seating
		// arm, and Welcome an agent the vote has not admitted.
		expect(addMlsGroupMembersMock).not.toHaveBeenCalled();
	});

	it("vote seats the member it just approved into a group that latched MLS", async () => {
		// `mls_group_id` is a one-way latch set by the MLS founding, and the
		// founding can land between a caller's resolve and its vote. A record from
		// before it says "sender key", and a sender-key group gets no Add commit —
		// so the member this vote just approved would hold a seat and no leaf.
		const { groups } = makeGroups({
			row: { ...GROUP_ROW, mls_group_id: null },
			serverRow: { ...GROUP_ROW, mls_group_id: "mls-1" },
		});
		const resolved = await groups.resolveRef(GROUP_ID);
		expect(resolved.row.mls_group_id).toBeNull();

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await groups.vote(resolved, REQUEST_ID, "approve");
		} finally {
			warn.mockRestore();
		}

		expect(addMlsGroupMembersMock).toHaveBeenCalledTimes(1);
		// `addMembersToMls` catches everything it throws, so a call alone proves
		// only that the branch was taken. This proves the branch COMPLETED.
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("what spending a pre-mutation row does cost", () => {
	// 🔴 Disclosed, not hidden. The four folding verbs answer their read from
	// the record, so a record a caller STORED can be arbitrarily old — bounded by
	// the caller's own gap between `resolveRef` and the verb, which is why the
	// record's docblock says "re-resolve rather than cache, or pass `.id`". These
	// two tests pin the consequence so it is a documented property with a name
	// rather than a surprise a later reader has to re-derive.

	it("removeMember believes a stored row that says sender-key", async () => {
		const { groups } = makeGroups({
			row: { ...GROUP_ROW, mls_group_id: null },
			serverRow: { ...GROUP_ROW, mls_group_id: "mls-1" },
		});
		const resolved = await groups.resolveRef(GROUP_ID);

		const fromRecord = await groups.removeMember(resolved, APPLICANT_ID);
		const fromId = await groups.removeMember(resolved.id, APPLICANT_ID);

		// The record path reports the regime its row named; the id path re-reads
		// and reports the current one. Both removals happen either way — what
		// differs is whether this client knows to post a Remove commit.
		expect(fromRecord.encryption).toBe("sender-key");
		expect(fromId.encryption).toBe("mls");
	});

	it("removeMember cannot reach the degraded-read note from a record", async () => {
		// The note stays alive on the id path: a group whose row
		// will not re-read gets the removal AND a warning that no Remove commit
		// was posted. A record answers the read, so the note is unreachable —
		// correctly, since the client does know the regime, but it is a different
		// action on a path no test drove before this one.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { groups } = makeGroups({
				serverGroupReadThrows: new Error("404: Group not found"),
			});
			const resolved = { ...(await groups.resolveRef(GROUP_ID)) };

			const fromRecord = await groups.removeMember(resolved, APPLICANT_ID);
			expect(fromRecord.encryption).toBe("sender-key");
			expect(warn).not.toHaveBeenCalled();

			const fromId = await groups.removeMember(resolved.id, APPLICANT_ID);
			expect(fromId.encryption).toBeNull();
			expect(warn.mock.calls.map(String).join("\n")).toContain(
				"could not be read before the removal",
			);
		} finally {
			warn.mockRestore();
		}
	});
});
