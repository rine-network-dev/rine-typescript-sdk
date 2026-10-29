/**
 * Polling resource — lightweight count check + callback-based watch().
 */

import { getProfile } from "@rine-network/core";
import { ConfigError } from "../errors.js";
import type { SDKHttpClient } from "../api/http.js";
import { sleepWithSignal } from "../utils/sleep.js";

// ---------------------------------------------------------------------------
// PollingResource
// ---------------------------------------------------------------------------

export class PollingResource {
	constructor(private readonly http: SDKHttpClient) {}

	/**
	 * Lightweight poll — returns message count for the authenticated agent.
	 * No auth required, firewall-friendly.
	 *
	 * Route: reads `poll_url` from the active profile (a full path
	 * like `/poll/<token>` stamped in at agent-create time). The server does
	 * NOT expose a bare `/poll` endpoint — always read the token-scoped URL
	 * out of the profile.
	 *
	 * @example
	 * ```ts
	 * const count = await client.polling.poll();
	 * ```
	 */
	async poll(opts?: { signal?: AbortSignal }): Promise<number> {
		const entry = getProfile(this.http.configDir, this.http.profile);
		const pollUrl = entry?.poll_url;
		if (!pollUrl) {
			throw new ConfigError(
				"No poll URL. Create an agent first with client.createAgent().",
			);
		}
		const raw = await this.http.get<unknown>(pollUrl, {
			unauthenticated: true,
			signal: opts?.signal,
			operation: "poll",
		});
		if (typeof raw === "number") return raw;
		if (typeof raw === "object" && raw !== null && "count" in raw) {
			return (raw as { count: number }).count;
		}
		return Number(raw);
	}

	/**
	 * watchPoll — call a callback each time the poll count increases.
	 *
	 * Returns an unsubscribe function.
	 *
	 * @example
	 * ```ts
	 * const unsubscribe = await client.polling.watchPoll((newCount) => {
	 *   console.log('New message count:', newCount);
	 * });
	 * // Later: unsubscribe()
	 * ```
	 */
	watchPoll(
		onCountChange: (newCount: number) => void,
		opts: { interval?: number; signal?: AbortSignal } = {},
	): () => void {
		const { interval = 5_000, signal } = opts;
		let lastCount = 0;
		let stopped = false;

		const tick = async () => {
			while (!stopped) {
				if (signal?.aborted) break;
				try {
					const count = await this.poll();
					if (count > lastCount) {
						lastCount = count;
						onCountChange(count);
					}
				} catch {
					// Ignore polling errors — will retry on next interval
				}
				await sleepWithSignal(interval, signal);
			}
		};

		tick();
		return () => {
			stopped = true;
		};
	}
}
