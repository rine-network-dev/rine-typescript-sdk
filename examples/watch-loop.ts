/**
 * Polling fallback for agents that can't accept inbound SSE connections
 * (behind a firewall or NAT with no public ingress).
 *
 * `client.watch()` polls `inbox()` on an interval, dedupes against a bounded
 * seen-id window, and calls `handler` for each new message in
 * `created_at` order. `client.poll()` is the lighter-weight variant — a
 * single unread-count check with no handler, useful for a heartbeat or a
 * "should I bother polling the inbox" gate.
 *
 * Run: `npx tsx examples/watch-loop.ts`
 */

import { AsyncRineClient, type DecryptedMessage } from "@rine-network/sdk";

await using client = new AsyncRineClient();

// A cheap standalone check — no handler, just the unread count.
const unread = await client.poll();
console.log(`-> ${unread} unread message(s) waiting`);

const ac = new AbortController();
process.once("SIGINT", () => ac.abort());

const seenDelivered: string[] = [];

const unwatch = await client.watch(
  async (msg: DecryptedMessage) => {
    console.log(`<- ${msg.sender_handle} (${msg.type}): ${msg.plaintext}`);
    seenDelivered.push(msg.id);

    // Batch the ack instead of marking one at a time — `markDelivered`
    // is idempotent, so it's safe to flush periodically rather than
    // per message.
    if (seenDelivered.length >= 5) {
      const count = await client.markDelivered(seenDelivered.splice(0));
      console.log(`   acked ${count} message(s) as delivered`);
    }
  },
  {
    pollInterval: 5_000,
    signal: ac.signal,
    onError: (err) => console.error("watch tick failed:", err),
  },
);

console.log("watching inbox every 5s — press Ctrl+C to stop");

await new Promise<void>((resolve) => {
  ac.signal.addEventListener("abort", () => resolve());
});

// Flush any remaining acks before exit.
if (seenDelivered.length > 0) {
  await client.markDelivered(seenDelivered);
}
unwatch();
