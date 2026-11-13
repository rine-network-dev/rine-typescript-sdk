/**
 * The TS SDK send path refuses a group our org's rule has closed to our posts,
 * before anything is sealed.
 *
 * `getOrCreateSenderKey` fans this agent's sender key out to every member, so
 * the placement of the guard is the requirement: every refusal here asserts the
 * typed error AND that no key, no seal and no `POST /messages` happened. The
 * downgrade guard's own file (`messages-send-downgrade.test.ts`) pins the same
 * call site for the other refusal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SENDER_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const GROUP_HANDLE = "#dev@acme.rine.network";

vi.mock("@rine-network/core", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		assertNoMlsDowngrade: vi.fn(),
		getOrCreateSenderKey: vi.fn(async () => ({
			state: { __state: true },
			groupId: GROUP_ID,
		})),
		encryptGroupMessage: vi.fn(async () => ({
			result: {
				encrypted_payload: "ENC(GROUP)",
				encryption_version: "sender-key-v1",
				sender_signing_kid: "sig-kid-grp",
			},
		})),
		encryptMlsGroupMessage: vi.fn(async () => ({
			encrypted_payload: "ENC(MLS)",
			encryption_version: "mls-v1",
			sender_signing_kid: "sig-kid-mls",
		})),
		prepareEscrowForSend: vi.fn(async () => "ESCROW-FP"),
		postWithEscrowRetry: vi.fn(
			async (
				_actor: unknown,
				_groupId: string,
				fp: string,
				post: (fp: string) => Promise<unknown>,
			) => post(fp),
		),
		processMlsWelcomes: vi.fn(async () => undefined),
		syncMlsGroup: vi.fn(async () => undefined),
		fetchAgents: vi.fn(async () => [
			{ id: SENDER_ID, handle: "me@acme.rine.network" },
		]),
		resolveAgent: vi.fn(async () => ({ agentId: SENDER_ID })),
	};
});

const core = await import("@rine-network/core");
const { MessagesResource } = await import("./messages.js");
const { RineError } = await import("../errors.js");

type SDKHttpClient = import("../api/http.js").SDKHttpClient;

interface Harness {
	messages: InstanceType<typeof MessagesResource>;
	posts: string[];
}

/** A send harness whose `/groups` lookup answers one group, recording every POST. */
function makeHarness(
	groupFields: Record<string, unknown>,
	postFields: Record<string, unknown> = {},
): Harness {
	const posts: string[] = [];
	const group = {
		id: GROUP_ID,
		name: "dev",
		handle: GROUP_HANDLE,
		created_at: "2026-06-20T00:00:00.000Z",
		mls_group_id: null,
		mls_pending: false,
		...groupFields,
	};
	const http = {
		configDir: "/tmp/rine-send-refused",
		getCoreHttpClient: () => ({
			get: async () => ({ items: [group] }),
			post: async () => ({}),
		}),
		async post<T>(path: string): Promise<T> {
			posts.push(path);
			return {
				id: "44444444-4444-4444-8444-444444444444",
				conversation_id: "55555555-5555-4555-8555-555555555555",
				from_agent_id: SENDER_ID,
				group_handle: GROUP_HANDLE,
				type: "rine.v1.task_request",
				encrypted_payload: "ENC(GROUP)",
				encryption_version: "sender-key-v1",
				created_at: "2026-06-20T00:00:00.000Z",
				metadata: {},
				...postFields,
			} as T;
		},
	} as unknown as SDKHttpClient;
	return { messages: new MessagesResource(http), posts };
}

const send = (h: Harness) =>
	h.messages.send(GROUP_HANDLE as never, { text: "hi group" });

beforeEach(() => vi.clearAllMocks());

describe("send refuses a group our org may not post in", () => {
	for (const refusal of ["foreign_open_group", "refused_members"]) {
		for (const mls of [false, true]) {
			it(`send_when_the_group_says_${refusal}_on_${mls ? "mls" : "sender_key"}_seals_and_sends_nothing`, async () => {
				const h = makeHarness({
					posting_refused: refusal,
					refused_members: refusal === "refused_members" ? [SENDER_ID] : null,
					mls_group_id: mls ? "mls-latch" : null,
				});

				const err = await send(h).catch((e: unknown) => e);

				expect(err).toBeInstanceOf(core.GroupPostingRefusedError);
				expect((err as { code: string }).code).toBe("group_posting_refused");
				expect(core.getOrCreateSenderKey).not.toHaveBeenCalled();
				expect(core.encryptGroupMessage).not.toHaveBeenCalled();
				expect(core.encryptMlsGroupMessage).not.toHaveBeenCalled();
				expect(h.posts).toEqual([]);
			});
		}
	}

	it("send_when_the_group_is_refused_the_error_is_a_RineError_too", async () => {
		const h = makeHarness({ posting_refused: "foreign_open_group" });

		const err = await send(h).catch((e: unknown) => e);

		expect(err instanceof RineError).toBe(true);
	});

	it("send_when_posting_is_allowed_posts_once", async () => {
		const h = makeHarness({ posting_refused: null });

		await send(h);

		expect(h.posts).toEqual(["/messages"]);
	});

	it("send_when_the_value_is_one_a_newer_server_added_leaves_the_refusal_to_the_server", async () => {
		const h = makeHarness({ posting_refused: "from_the_future" });

		await send(h);

		expect(h.posts).toEqual(["/messages"]);
	});
});

describe("a group post's result carries unreadable_by_orgs", () => {
	it("send_when_the_server_counts_unreadable_orgs_the_result_keeps_the_count", async () => {
		const h = makeHarness({}, { unreadable_by_orgs: 2 });

		const sent = (await send(h)) as { unreadable_by_orgs?: number };

		expect(sent.unreadable_by_orgs).toBe(2);
		expect(core.unreadableByOrgsSentence(sent.unreadable_by_orgs)).toMatch(
			/^2 member organisations may not be able to read this post/,
		);
	});

	it("send_when_nothing_is_unreadable_the_field_is_absent", async () => {
		const sent = (await send(makeHarness({}))) as {
			unreadable_by_orgs?: number;
		};

		expect(sent.unreadable_by_orgs).toBeUndefined();
	});
});
