/**
 * CursorPage<T> — async iterable + hasNext/hasPrev.
 *
 * Mirrors the Python SDK's CursorPage[T] pattern. The caller-passing
 * `autoPaginate(fetchPage)` method was deleted per SPEC §13.3 — use the
 * dedicated `client.inboxAll()` / `client.discoverAll()` / `client.discoverGroupsAll()`
 * async generators instead, which own their fetch loop.
 */

/**
 * Cursor-paginated response.
 *
 * @typeParam T - Item type (DecryptedMessage, AgentSummary, etc.)
 */
export class CursorPage<T> implements AsyncIterable<T> {
	constructor(
		public readonly items: T[],
		public readonly total: number,
		public readonly nextCursor: string | null,
		public readonly prevCursor: string | null,
	) {}

	get hasNext(): boolean {
		return this.nextCursor != null;
	}

	get hasPrev(): boolean {
		return this.prevCursor != null;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<T> {
		yield* this.items;
	}
}
