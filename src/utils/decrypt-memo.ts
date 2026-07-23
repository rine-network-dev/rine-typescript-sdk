/**
 * Bounded per-client memo of successful GROUP decrypt results.
 *
 * Group decryption is not repeatable. A sender-key envelope consumes the
 * ratchet step it was encrypted at: `openGroup` derives the message key for
 * `messageIndex`, advances the chain, and does NOT retain the consumed key
 * (rine-core `crypto/sender-keys.ts`). The advanced state is then persisted
 * to disk, so a *second* decrypt of the same row lands in the
 * `messageIndex < state.messageIndex` branch with no cached key and throws
 * `"message key expired or already consumed"`. MLS behaves the same way — the
 * receiving ratchet moves past the generation once it is used.
 *
 * That makes any receive surface that can see the same row twice
 * (`inbox()` re-poll, `read()` after `inbox()`, `thread()` over a group
 * conversation) return plaintext exactly once and an error forever after.
 * Memoizing the successful decrypt result keyed by `(agentId, messageId)`
 * makes those surfaces idempotent for the message's in-process lifetime
 * without touching the ratchet's forward-secrecy accounting.
 *
 * Scope and limits, on purpose:
 *   - One memo per client (`SDKHttpClient`), cleared by `client.close()`, so
 *     decrypted plaintext never outlives the client that fetched it.
 *   - Bounded LRU (default 256 entries) — a cache, never a store. A hit
 *     refreshes recency, matching the Python SDK's `DecryptMemo` so both
 *     languages evict the same victim under an identical read workload.
 *   - Only the group path writes to it. 1:1 HPKE decrypt is already
 *     repeatable (the recipient's private key does not change), so caching
 *     DM plaintext would add retention for no benefit.
 *   - A re-read after the process exits still fails. That is inherent forward
 *     secrecy, not a regression: the message was already delivered once.
 */

import type { DecryptResult } from "@rine-network/core";

const DEFAULT_CAPACITY = 256;

export class GroupDecryptMemo {
  private readonly entries = new Map<string, DecryptResult>();

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  get(agentId: string, messageId: string): DecryptResult | undefined {
    const k = key(agentId, messageId);
    const entry = this.entries.get(k);
    if (entry === undefined) return undefined;
    // A hit refreshes recency (true LRU). Re-inserting moves the key to the
    // newest position of the insertion-ordered Map, so a recently re-read
    // row is not the next eviction victim. This matches the Python SDK's
    // `DecryptMemo` (OrderedDict.move_to_end on hit) so both languages evict
    // the same entry under identical read workloads.
    this.entries.delete(k);
    this.entries.set(k, entry);
    return entry;
  }

  set(agentId: string, messageId: string, result: DecryptResult): void {
    const k = key(agentId, messageId);
    // Re-insert so a refreshed entry is treated as newest by the
    // insertion-ordered eviction below.
    this.entries.delete(k);
    this.entries.set(k, result);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Drop every memoized plaintext. Called from `client.close()`. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

function key(agentId: string, messageId: string): string {
  // NUL separator — neither a UUID nor an agent id can contain one, so the
  // composite key is unambiguous.
  return `${agentId}\u0000${messageId}`;
}
