import { afterEach, describe, expect, it, vi } from "vitest";

// Zero-latency sleep so the watch() poll loop advances immediately.
vi.mock("./utils/sleep.js", () => ({
	sleepWithSignal: () => Promise.resolve(),
}));

const { AsyncRineClient } = await import("./client.js");
const { CursorPage } = await import("./utils/cursor-page.js");

// Minimal shape the watch() logic reads from each inbox row.
type TestMessage = { id: string; created_at: string };

type InboxCall = {
	status?: string;
	limit?: number;
	cursor?: string;
	signal?: AbortSignal;
};

// One watch() tick is a run of inbox() calls that starts without a cursor and
// follows `nextCursor` until a page has none. A script entry is the list of
// pages one tick sees; a page is a row list, or an Error to fail that fetch.
type TickScript = (TestMessage[] | Error)[];

function msg(id: string, second: number): TestMessage {
	return {
		id,
		created_at: `2026-04-11T00:00:${String(second).padStart(2, "0")}Z`,
	};
}

function page(items: TestMessage[], nextCursor: string | null) {
	return new CursorPage(items, items.length, nextCursor, null);
}

// Drive watch() by stubbing `inbox()` on a real client instance. The
// constructor only stashes config — it does not open any network or files —
// so a bare `new AsyncRineClient({})` is safe here. After the script runs out
// the stub keeps returning an empty new set so the loop idles.
function makeClient(script: TickScript[]): {
	client: InstanceType<typeof AsyncRineClient>;
	calls: InboxCall[];
	ticksStarted: () => number;
} {
	const client = new AsyncRineClient({});
	const calls: InboxCall[] = [];
	let tick = -1;
	let pageIdx = 0;
	// biome-ignore lint/suspicious/noExplicitAny: test override of instance method
	(client as any).inbox = async (opts: InboxCall) => {
		calls.push({
			status: opts.status,
			limit: opts.limit,
			cursor: opts.cursor,
			signal: opts.signal,
		});
		if (opts.cursor === undefined) {
			tick++;
			pageIdx = 0;
		}
		const pages = script[tick] ?? [[]];
		const current = pages[pageIdx] ?? [];
		if (current instanceof Error) throw current;
		pageIdx++;
		return page(current, pageIdx < pages.length ? `c${pageIdx}` : null);
	};
	return { client, calls, ticksStarted: () => tick + 1 };
}

// Drive watch() forward until the observer predicate is satisfied. The poll
// loop is driven by microtasks (sleep is mocked to resolve immediately), and
// large pages can require hundreds of microtask turns to fully drain because
// each handler call yields its own microtask.
async function flushUntil(
	predicate: () => boolean,
	maxTurns = 20_000,
): Promise<void> {
	for (let i = 0; i < maxTurns; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(`flushUntil: predicate not met within ${maxTurns} turns`);
}

// Every watcher started here is stopped after the test, pass or fail: a failed
// assertion must not leave a microtask loop spinning behind it.
const stoppers: (() => void)[] = [];

async function startWatch<M>(
	client: InstanceType<typeof AsyncRineClient>,
	handler: (msg: M) => Promise<void> | void,
	opts?: Parameters<InstanceType<typeof AsyncRineClient>["watch"]>[1],
): Promise<() => void> {
	const stop = await client.watch<M>(handler, opts);
	stoppers.push(stop);
	return stop;
}

afterEach(() => {
	for (const stop of stoppers.splice(0)) stop();
	vi.restoreAllMocks();
});

describe("AsyncRineClient.watch() — undelivered mail", () => {
	it("lists status new with the server maximum page size", async () => {
		const { client, calls } = makeClient([[[msg("a", 0)]]]);

		const seen: string[] = [];
		const unsubscribe = await startWatch<TestMessage>(client, (m) => {
			seen.push(m.id);
		});
		await flushUntil(() => seen.length >= 1);
		unsubscribe();

		expect(calls[0]).toMatchObject({
			status: "new",
			limit: 100,
			cursor: undefined,
		});
	});

	it("passes the per-watch signal to every listing call", async () => {
		const { client, calls } = makeClient([[[msg("a", 0)]]]);
		const controller = new AbortController();

		const seen: string[] = [];
		await startWatch<TestMessage>(
			client,
			(m) => {
				seen.push(m.id);
			},
			{ signal: controller.signal },
		);
		await flushUntil(() => seen.length >= 1);

		expect(calls[0]?.signal).toBe(controller.signal);
	});

	it("stops dispatching the rest of a tick once unsubscribed", async () => {
		const { client } = makeClient([[[msg("a", 0), msg("b", 1), msg("c", 2)]]]);

		const seen: string[] = [];
		const unsubscribe = await startWatch<TestMessage>(client, (m) => {
			seen.push(m.id);
			unsubscribe();
		});
		await flushUntil(() => seen.length >= 1);
		for (let i = 0; i < 200; i++) await Promise.resolve();

		expect(seen).toEqual(["a"]);
	});

	it("fires the handler once per id while it stays in the new set", async () => {
		const abc = [msg("a", 0), msg("b", 1), msg("c", 2)];
		const { client, ticksStarted } = makeClient([
			[abc],
			// Same three ids — none should fire again.
			[abc],
			// One new id — fires once.
			[[...abc, msg("d", 3)]],
		]);

		const seen: string[] = [];
		const unsubscribe = await startWatch<TestMessage>(client, (m) => {
			seen.push(m.id);
		});
		await flushUntil(() => ticksStarted() >= 4);
		unsubscribe();

		expect(seen).toEqual(["a", "b", "c", "d"]);
	});

	it("sorts by created_at then id before dispatching", async () => {
		const { client } = makeClient([
			[
				[
					msg("z-third", 3),
					msg("b-tie", 1),
					msg("y-second", 2),
					msg("a-tie", 1),
				],
			],
		]);

		const seen: string[] = [];
		const unsubscribe = await startWatch<TestMessage>(client, (m) => {
			seen.push(m.id);
		});
		await flushUntil(() => seen.length >= 4);
		unsubscribe();

		expect(seen).toEqual(["a-tie", "b-tie", "y-second", "z-third"]);
	});

	it("follows the cursor across pages and dispatches every row", async () => {
		const { client, calls } = makeClient([
			[[msg("a", 0)], [msg("b", 1)], [msg("c", 2)]],
		]);

		const seen: string[] = [];
		const unsubscribe = await startWatch<TestMessage>(client, (m) => {
			seen.push(m.id);
		});
		await flushUntil(() => seen.length >= 3);
		unsubscribe();

		expect(seen).toEqual(["a", "b", "c"]);
		expect(calls.slice(0, 3).map((c) => c.cursor)).toEqual([
			undefined,
			"c1",
			"c2",
		]);
	});

	it("dispatches a burst larger than one page in order", async () => {
		const burst = Array.from({ length: 25 }, (_, i) => msg(`m${i}`, i));
		const { client } = makeClient([
			[burst.slice(0, 10), burst.slice(10, 20), burst.slice(20)],
		]);

		const seen: string[] = [];
		const unsubscribe = await startWatch<TestMessage>(client, (m) => {
			seen.push(m.id);
		});
		await flushUntil(() => seen.length >= 25);
		unsubscribe();

		expect(seen).toEqual(burst.map((m) => m.id));
	});

	it("dispatches nothing and calls onError when a later page fails", async () => {
		const boom = new Error("page 2 down");
		const { client, ticksStarted } = makeClient([
			[[msg("a", 0)], boom],
			[[msg("a", 0)], [msg("b", 1)]],
		]);

		const seen: string[] = [];
		const errors: unknown[] = [];
		const unsubscribe = await startWatch<TestMessage>(
			client,
			(m) => {
				seen.push(m.id);
			},
			{ onError: (err) => errors.push(err) },
		);
		await flushUntil(() => ticksStarted() >= 2 && errors.length >= 1);
		expect(seen).toEqual([]);
		expect(errors).toEqual([boom]);

		await flushUntil(() => seen.length >= 2);
		unsubscribe();
		expect(seen).toEqual(["a", "b"]);
	});

	it("keeps dispatched ids seen when a later fetch fails midway", async () => {
		const boom = new Error("page 2 down");
		const { client, ticksStarted } = makeClient([
			[[msg("a", 0)]],
			[[msg("a", 0)], boom],
			[[msg("a", 0)]],
		]);

		const seen: string[] = [];
		const unsubscribe = await startWatch<TestMessage>(
			client,
			(m) => {
				seen.push(m.id);
			},
			{ onError: () => {} },
		);
		await flushUntil(() => ticksStarted() >= 4);
		unsubscribe();

		expect(seen).toEqual(["a"]);
	});

	it("fires an id again after it left the new set and came back", async () => {
		const { client, ticksStarted } = makeClient([
			[[msg("a", 0)]],
			// "a" was acked, so it is absent from the new set.
			[[]],
			// The server redelivers it.
			[[msg("a", 0)]],
		]);

		const seen: string[] = [];
		const unsubscribe = await startWatch<TestMessage>(client, (m) => {
			seen.push(m.id);
		});
		await flushUntil(() => ticksStarted() >= 4);
		unsubscribe();

		expect(seen).toEqual(["a", "a"]);
	});

	it("ends the tick when a handler throws and does not retry that row", async () => {
		const all = [msg("a", 0), msg("b", 1), msg("c", 2)];
		const { client, ticksStarted } = makeClient([[all], [all]]);

		const seen: string[] = [];
		const errors: unknown[] = [];
		const unsubscribe = await startWatch<TestMessage>(
			client,
			(m) => {
				seen.push(m.id);
				if (m.id === "b") throw new Error("handler failed");
			},
			{ onError: (err) => errors.push(err) },
		);
		await flushUntil(() => ticksStarted() >= 2);
		// Tick 1 stopped at "b": "c" has not run yet.
		expect(seen).toEqual(["a", "b"]);
		expect(errors).toHaveLength(1);

		await flushUntil(() => ticksStarted() >= 3);
		unsubscribe();
		// Tick 2 skips a and b, which were recorded, and runs c.
		expect(seen).toEqual(["a", "b", "c"]);
	});
});
