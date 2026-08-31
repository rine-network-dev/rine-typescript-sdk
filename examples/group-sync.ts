/**
 * `groups.sync()` — catch an agent's group encryption state up after it falls
 * behind.
 *
 * New groups are MLS groups on the post-quantum X-Wing ciphersuite. An MLS
 * group moves forward one epoch at a time, and every member has to apply every
 * commit to keep decrypting. An agent that was offline, or whose last attempt
 * to commit was rolled back, ends up behind. `sync()` is the recovery verb: it
 * catches this agent up on the cheapest rung that works and reports what that
 * cost.
 *
 *   replay  applies the commits the server still holds. Reads only, posts
 *           nothing, costs nobody else anything.
 *   resync  posts a single external commit that re-seats this agent's existing
 *           leaf at the current epoch. It is O(N): every member of the group
 *           downloads and processes it. Reached only when replay cannot bridge
 *           the gap.
 *
 * An open group runs Sender Keys and has no epoch chain, so `sync()` answers it
 * differently: what a member can be missing there is other members' keys,
 * waiting as distribution DMs in its own inbox, and the recovery installs them
 * and posts nothing. `regime` on the result says which recovery ran, and it is
 * the only thing to branch on — the two arms share no other field.
 *
 * Two things worth knowing before reaching for it:
 *
 * - A resync recovers stale or corrupt local state, never absent state. If this
 *   agent's state is gone there is nothing to re-seat: an admin has to remove
 *   the agent from the group and invite it again, which mints a new leaf and a
 *   fresh Welcome. `sync()` says so by throwing rather than silently doing
 *   nothing.
 * - A group's epoch state lives on the machine that holds it. The config dir is
 *   live cryptographic state, not a file to snapshot, copy between machines or
 *   restore from a backup — a restored copy is stale the moment the group moves.
 *
 * A and B are two onboarded identities. A is the default client (its config dir
 * comes from `RINE_CONFIG_DIR`); B is a second client built against
 * `RINE_PEER_CONFIG_DIR`.
 *
 * Run: `RINE_PEER_CONFIG_DIR=/path/to/peer/.rine \
 *        npx tsx examples/group-sync.ts '<peer-handle>' [group-name]`
 */

import {
  AsyncRineClient,
  type GroupRecoveryResult,
  asAgentUuid,
  asGroupUuid,
  isAgentHandle,
} from "@rine-network/sdk";

/**
 * Read a recovery the way a caller has to: on `regime`, never on which fields
 * the answer happens to carry. The two arms share no other field, because the
 * two recoveries share no events — an open group has no epoch, no commit and no
 * leaf, and an MLS group has no distribution DMs to install.
 */
const syncLine = (r: GroupRecoveryResult): string =>
  r.regime === "mls"
    ? `rung=${r.rung} epoch ${r.fromEpoch}->${r.epoch} behind=${r.behind} ` +
      `applied=${r.processed} evicted=${r.evicted}`
    : `installed ${r.ingested} sender key(s) retired=${r.retired}`;

const peerArg = process.argv[2];
const groupName = process.argv[3] ?? `ts-sdk-sync-${Date.now()}`;

if (!peerArg || !isAgentHandle(peerArg)) {
  console.error(
    "usage: group-sync.ts '<agent>@<org>.rine.network' [group-name]",
  );
  process.exit(1);
}

const peerConfigDir = process.env.RINE_PEER_CONFIG_DIR;
if (!peerConfigDir) {
  console.error("set RINE_PEER_CONFIG_DIR to agent B's config dir");
  process.exit(1);
}

await using client = new AsyncRineClient();
await using peer = new AsyncRineClient({ configDir: peerConfigDir });

// 1. A creates a private MLS group and invites B.
const group = await client.groups.create(groupName, {
  description: "TS SDK sync example group",
  visibility: "private",
});
const groupId = asGroupUuid(group.id);
console.log(`-> created ${group.handle} (${group.id})`);

const peerProfile = await client.inspect(peerArg);
await client.groups.invite(groupId, asAgentUuid(peerProfile.id));

// 2. B joins from its own credentials. That join advances the group by one
// epoch, and A has not seen the commit yet — so A is now behind, which is the
// ordinary way a member falls behind, at the smallest possible scale.
const joined = await peer.groups.join(groupId);
console.log(`-> ${peerArg} joined (${joined.status})`);

// 3. Catch A up. This is the cheap rung: the server still holds B's commit, so
// replaying it is enough and nothing is posted. A failure here is raised, never
// swallowed — an agent that believes it is current when it is not will fail to
// decrypt everything the group sends next.
const first = await client.groups.sync(groupId);
console.log(`<- sync: ${syncLine(first)}`);

// 4. Running it again is safe and cheap: already current, so replay applies
// nothing. `sync()` is idempotent, so a wake-up path can call it blindly.
const again = await client.groups.sync(groupId);
console.log(`<- sync again: ${syncLine(again)}`);
