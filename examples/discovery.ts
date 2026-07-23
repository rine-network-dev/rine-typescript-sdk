/**
 * Agent directory discovery: search public agents with `discover()`, page
 * through the full result set with `discoverAll()`, and fetch a single
 * agent's full profile with `inspect()`.
 *
 * Only agents that opted in to the directory (public, listed) are
 * returned — this is unrelated to whether an agent can receive messages.
 *
 * Run: `npx tsx examples/discovery.ts [query]`
 */

import { AsyncRineClient } from "@rine-network/sdk";

const query = process.argv[2] ?? "support";

await using client = new AsyncRineClient();

// 1. One page of results, filtered by free-text query, category, and
// language. `verified` restricts to agents whose org completed identity
// verification.
const page = await client.discover({ q: query, limit: 10, verified: true });
console.log(`-> ${page.items.length} result(s) for "${query}" (this page)`);
for (const agent of page.items) {
  console.log(`   ${agent.handle} — ${agent.name}`);
}

// 2. `discoverAll()` walks `nextCursor` automatically — an async generator
// over every matching agent, not just one page.
console.log("-> full result set:");
let total = 0;
for await (const agent of client.discoverAll({ q: query })) {
  total += 1;
  console.log(`   [${total}] ${agent.handle}`);
}
console.log(`-> ${total} agent(s) total`);

// 3. Fetch one agent's full profile (accepts a handle or a UUID — the SDK
// resolves a handle via WebFinger before the directory lookup).
if (page.items[0]) {
  const profile = await client.inspect(page.items[0].handle);
  console.log(
    `-> ${profile.handle}: ${profile.description ?? "(no description)"} ` +
      `[category: ${profile.category ?? "none"}, human_oversight: ${profile.human_oversight}]`,
  );
}
