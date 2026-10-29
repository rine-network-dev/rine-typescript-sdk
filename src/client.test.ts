import { afterEach, describe, expect, it, vi } from "vitest";

// Zero-latency sleep so the watch() poll loop advances immediately.
vi.mock("./utils/sleep.js", () => ({
	sleepWithSignal: () => Promise.resolve(),
}));

const { AsyncRineClient } = await import("./client.js");

// Minimal shape the watch() dedup logic reads from each page item.
type TestMessage = { id: string; created_at: string };

type InboxPage = {
	items: TestMessage[];
	total: number;
	next_cursor: null;
	prev_cursor: null;
};

function makePage(items: TestMessage[]): InboxPage {
	return { items, total: items.length, next_cursor: null, prev_cursor: null };
}

// Drive watch() by stubbing `inbox()` on a real client instance. The
// constructor only stashes config — it does not open any network or files —
// so a bare `new AsyncRineClient({})` is safe here.
function makeClientWithPages(pages: InboxPage[]): {
	client: InstanceType<typeof AsyncRineClient>;
} {
	const client = new AsyncRineClient({});
	let idx = 0;
	// biome-ignore lint/suspicious/noExplicitAny: test override of instance method
	(client as any).inbox = async () => {
		if (idx >= pages.length) {
			// After the last real page, keep returning empties so the poll loop
			// can idle until the caller unsubscribes.
			return makePage([]);
		}
		return pages[idx++] ?? makePage([]);
	};
	return { client };
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

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AsyncRineClient.watch() — SeenIds dedup", () => {
	it("fires the handler once per unique id across polls", async () => {
		const { client } = makeClientWithPages([
			makePage([
				{ id: "a", created_at: "2026-04-11T00:00:00Z" },
				{ id: "b", created_at: "2026-04-11T00:00:01Z" },
				{ id: "c", created_at: "2026-04-11T00:00:02Z" },
			]),
			// Same three ids — none should fire again.
			makePage([
				{ id: "a", created_at: "2026-04-11T00:00:00Z" },
				{ id: "b", created_at: "2026-04-11T00:00:01Z" },
				{ id: "c", created_at: "2026-04-11T00:00:02Z" },
			]),
			// One new id — fires once.
			makePage([{ id: "d", created_at: "2026-04-11T00:00:03Z" }]),
		]);

		const seen: string[] = [];
		const unsubscribe = await client.watch<TestMessage>((msg) => {
			seen.push(msg.id);
		});
		await flushUntil(() => seen.length >= 4);
		unsubscribe();

		expect(seen).toEqual(["a", "b", "c", "d"]);
	});

	it("sorts items by created_at ascending before dispatching", async () => {
		// Items arrive out of order within a single page.
		const { client } = makeClientWithPages([
			makePage([
				{ id: "z-third", created_at: "2026-04-11T00:00:03Z" },
				{ id: "x-first", created_at: "2026-04-11T00:00:01Z" },
				{ id: "y-second", created_at: "2026-04-11T00:00:02Z" },
			]),
		]);

		const seen: string[] = [];
		const unsubscribe = await client.watch<TestMessage>((msg) => {
			seen.push(msg.id);
		});
		await flushUntil(() => seen.length >= 3);
		unsubscribe();

		// Despite arrival order, dispatch is chronological.
		expect(seen).toEqual(["x-first", "y-second", "z-third"]);
	});

	it("re-fires an id that has aged out of the 500-slot window", async () => {
		// First page: 500 brand-new ids. Then a fresh id "sentinel" that
		// evicts id-0 from the seen-set. Then id-0 replayed — because it
		// has been evicted, it should fire again.
		const bulk: TestMessage[] = [];
		for (let i = 0; i < 500; i++) {
			bulk.push({
				id: `id-${i}`,
				// Zero-padded to six digits so string sort gives the right order.
				created_at: `2026-04-11T00:00:${String(i).padStart(6, "0")}Z`,
			});
		}

		const { client } = makeClientWithPages([
			makePage(bulk),
			makePage([{ id: "sentinel", created_at: "2026-04-11T01:00:00Z" }]),
			makePage([{ id: "id-0", created_at: "2026-04-11T02:00:00Z" }]),
		]);

		const seen: string[] = [];
		const unsubscribe = await client.watch<TestMessage>((msg) => {
			seen.push(msg.id);
		});
		// Expect 500 + 1 sentinel + 1 id-0 replay = 502 dispatches.
		await flushUntil(() => seen.length >= 502);
		unsubscribe();

		const idZeroHits = seen.filter((s) => s === "id-0").length;
		expect(idZeroHits).toBe(2);
		expect(seen).toContain("sentinel");
	});
});
