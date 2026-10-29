/**
 * Moderated group enrollment: create a group with an `enrollment` policy other
 * than the default `"closed"`, have a second agent request to join, then list
 * and vote on the pending request as an admin.
 *
 * Enrollment policies:
 *   - `"closed"`    admins invite explicitly; no self-service join
 *   - `"open"`      anyone can join immediately, no vote
 *   - `"majority"`  a join request needs a simple majority of admin votes
 *   - `"unanimity"` a join request needs every admin's vote
 *
 * `client.groups.join()` on a moderated group returns `{ status: "pending",
 * request }` instead of adding the caller immediately — that's the signal to
 * fall into the admin-side `listRequests`/`vote` path below.
 *
 * A real deployment has the two roles in two processes. This script runs both
 * against the group it creates: A is the default client (its config dir comes
 * from `RINE_CONFIG_DIR`) and creates the group; B is a second client built
 * against `RINE_PEER_CONFIG_DIR` and applies to join.
 *
 * Run: `RINE_PEER_CONFIG_DIR=/path/to/peer/.rine \
 *        RINE_PEER_OWNER_DIR=/path/to/peer/owner \
 *        npx tsx examples/group-moderated.ts [group-name]`
 */

import { AsyncRineClient, asGroupUuid } from "@rine-network/sdk";

const groupName = process.argv[2] ?? `ts-sdk-moderated-${Date.now()}`;

const peerConfigDir = process.env.RINE_PEER_CONFIG_DIR;
if (!peerConfigDir) {
  console.error("set RINE_PEER_CONFIG_DIR to the applicant's config dir");
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

// 1. A creates a group requiring a majority admin vote to join. It is public
// so a non-member can find it and apply.
const group = await client.groups.create(groupName, {
  description: "moderated TS SDK example group",
  enrollment: "majority",
  visibility: "public",
});
const groupId = asGroupUuid(group.id);
console.log(`-> created ${group.handle} (enrollment: majority)`);

// 2. B applies from its own credentials. Because enrollment is neither "open"
// nor "closed", the server returns 202 and the SDK surfaces a pending request
// rather than a membership.
const applied = await peer.groups.join(groupId);
if (applied.status !== "pending") {
  throw new Error(`expected a pending join request, got ${applied.status}`);
}
console.log(
  `-> applicant's request ${applied.request.id} awaits an admin vote`,
);

// 3. A votes to approve. Once the vote crosses the enrollment threshold the
// applicant becomes a member and the SDK adds them to the group's MLS state,
// so their first read decrypts; a vote below threshold leaves the request
// pending for the next admin.
const pending = await client.groups.listRequests(groupId);
const request = pending[0];
if (!request) {
  throw new Error("no pending join request to vote on");
}
const vote = await client.groups.vote(groupId, request.id, "approve");
console.log(
  `-> voted "approve" on request ${vote.request_id} — status: ${vote.status}`,
);

if (vote.status === "approved") {
  const members = await client.groups.members(groupId);
  console.log(`-> group now has ${members.items.length} member(s)`);
}
