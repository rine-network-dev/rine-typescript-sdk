/**
 * `groups.leave()` — depart a group under its own name, and see what departure
 * costs.
 *
 * Leaving and being thrown out used to be the same call: a member left by
 * aiming `removeMember` at itself, so an operator searching this SDK for
 * "leave" found nothing. `leave()` is that departure verb. The mechanics are
 * unchanged — it resolves the acting agent and removes it — so there is one
 * removal path, not two.
 *
 * New groups are MLS groups on the post-quantum X-Wing ciphersuite, and that is
 * what makes departure more than a database row: an MLS group is a ratchet
 * tree, and a member's place in it outlives the membership row.
 *
 * Three things worth knowing before an agent departs:
 *
 * - A leave posts NO Remove commit. MLS gives nobody a way to commit their own
 *   removal, so the departing member's leaf stays in the group's ratchet tree
 *   until some member runs the reclamation pass (`resumeMlsAdmission` with
 *   `reclaim`). Nothing does that on its own — the server holds no MLS keys and
 *   cannot mint the commit. Any member can run it; it costs one commit per
 *   reclaimed leaf and every member of the group downloads each one, which is
 *   why it is asked for rather than automatic.
 * - What the leave DOES take is this agent's local key material for the group:
 *   the MLS store for a closed group, the sender-key material for an open one,
 *   and with them the message keys already delivered. A message delivered
 *   before the leave and never opened does not open afterwards.
 * - An org with more than one active agent has to name who is leaving, with
 *   `{ agent }`. A leave the server cannot attribute is read as a kick, and an
 *   MLS group refuses a kick until a Remove commit is posted — which nobody can
 *   mint for their own removal.
 *
 * Print `result.message` rather than composing a sentence: the true one differs
 * between the two group types, and every surface that guessed got it wrong for
 * open groups.
 *
 * A and B are two onboarded identities. A is the default client (its config dir
 * comes from `RINE_CONFIG_DIR`); B is a second client built against
 * `RINE_PEER_CONFIG_DIR`.
 *
 * Run: `RINE_PEER_CONFIG_DIR=/path/to/peer/.rine \
 *        RINE_PEER_OWNER_DIR=/path/to/peer/owner \
 *        npx tsx examples/group-leave.ts '<peer-handle>' [group-name]`
 */

import {
  AsyncRineClient,
  asAgentUuid,
  asGroupUuid,
  isAgentHandle,
} from "@rine-network/sdk";

const peerArg = process.argv[2];
const groupName = process.argv[3] ?? `ts-sdk-leave-${Date.now()}`;

if (!peerArg || !isAgentHandle(peerArg)) {
  console.error(
    "usage: group-leave.ts '<agent>@<org>.rine.network' [group-name]",
  );
  process.exit(1);
}

const peerConfigDir = process.env.RINE_PEER_CONFIG_DIR;
if (!peerConfigDir) {
  console.error("set RINE_PEER_CONFIG_DIR to agent B's config dir");
  process.exit(1);
}

// The peer needs its own owner dir; falling back to the default would put the
// peer's files in the operator's own owner dir.
const peerOwnerDir = process.env.RINE_PEER_OWNER_DIR;
if (!peerOwnerDir) {
  console.error("set RINE_PEER_OWNER_DIR to agent B's owner dir");
  process.exit(1);
}

await using client = new AsyncRineClient();
await using peer = new AsyncRineClient({
  configDir: peerConfigDir,
  ownerDir: peerOwnerDir,
});

// 1. A creates a private MLS group and invites B.
const group = await client.groups.create(groupName, {
  description: "TS SDK leave example group",
  visibility: "private",
});
const groupId = asGroupUuid(group.id);
console.log(`-> created ${group.handle} (${group.id})`);

const peerProfile = await client.inspect(peerArg);
await client.groups.invite(groupId, asAgentUuid(peerProfile.id));

// 2. B joins from its own credentials.
const joined = await peer.groups.join(groupId);
console.log(`-> ${peerArg} joined (${joined.status})`);
console.log(
  `-> members before: ${(await client.groups.members(groupId)).items.length}`,
);

// 3. B departs. `left: true` is what distinguishes this from a kick — the
// acting agent and the removed agent are the same one.
const departure = await peer.groups.leave(groupId);
console.log(
  `<- left=${departure.left} encryption=${departure.encryption} ` +
    `localStateRetired=${departure.localStateRetired}`,
);
// No commit was posted, so there is no epoch to report. `mlsRemovalEpoch` is
// undefined on every leave; it carries a number only for a kick.
console.log(`<- mlsRemovalEpoch: ${departure.mlsRemovalEpoch}`);
console.log(`<- ${departure.message}`);

// 4. A sees the roster shrink. B's ratchet-tree leaf is still there: the
// server's roster and the group's tree are two different things, and only a
// reclamation pass reconciles them.
console.log(
  `-> members after: ${(await client.groups.members(groupId)).items.length}`,
);
