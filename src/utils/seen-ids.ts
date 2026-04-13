/**
 * Bounded FIFO seen-ID set.
 *
 * Used by both the SSE stream layer (reconnect replay dedup per SPEC_v2 §12.3.3)
 * and the poll-based `watch()` path (see `client.ts`). On reconnect with
 * `Last-Event-ID`, the server's catch-up phase can race with the NOTIFY
 * delivery and re-emit events already seen; this class is the guard against
 * dispatching them twice.
 *
 * Capacity defaults to 500 (SPEC §12.3.3 N — ~18 KB of RAM, ~10 minutes of
 * traffic at 1 msg/s — comfortably larger than any plausible reconnect
 * replay window, small enough to stay negligible).
 */

export class SeenIds {
	private readonly set = new Set<string>();
	private readonly queue: string[] = [];

	constructor(private readonly capacity: number = 500) {}

	/** Returns true if the id is new (caller should dispatch), false if duplicate. */
	record(id: string): boolean {
		if (this.set.has(id)) return false;
		this.set.add(id);
		this.queue.push(id);
		while (this.queue.length > this.capacity) {
			const evicted = this.queue.shift();
			if (evicted !== undefined) this.set.delete(evicted);
		}
		return true;
	}

	has(id: string): boolean {
		return this.set.has(id);
	}

	get size(): number {
		return this.set.size;
	}
}
