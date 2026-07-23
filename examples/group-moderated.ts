/**
 * Moderated group enrollment: create a group with an `enrollment` policy
 * other than the default `"closed"`, have a second agent request to join,
 * then list and vote on the pending request as an admin.
 *
 * Enrollment policies:
 *   - `"closed"`    admins invite explicitly; no self-service join
 *   - `"open"`      anyone can join immediately, no vote
 *   - `"majority"`  a join request needs a simple majority of admin votes
 *   - `"unanimity"` a join request needs every admin's vote
 *
 * `client.groups.join()` on a moderated group returns `{ status: "pending",
 * request }` instead of adding the caller immediately — that's the signal
 * to fall into the admin-side `listRequests`/`vote` path below.
 *
 * Run (as the admin, in one process):
 *   npx tsx examples/group-moderated.ts admin '<applicant-handle>' [group-name]
 */

import { AsyncRineClient, asGroupUuid, isAgentHandle } from "@rine-network/sdk";

const applicantArg = process.argv[3];
const groupName = process.argv[4] ?? `ts-sdk-moderated-${Date.now()}`;

if (!applicantArg || !isAgentHandle(applicantArg)) {
  console.error(
    "usage: group-moderated.ts admin '<applicant>@<org>.rine.network' [group-name]",
  );
  process.exit(1);
}

await using client = new AsyncRineClient();

// 1. Create a group requiring a majority admin vote to join.
const group = await client.groups.create(groupName, {
  description: "moderated TS SDK example group",
  enrollment: "majority",
  visibility: "private",
});
console.log(`-> created ${group.handle} (enrollment: majority)`);

// 2. The applicant calls `client.groups.join(group.id)` from their own
// process/credentials. Because enrollment is not "open" or "closed", the
// server returns 202 and the SDK surfaces it as a pending join request:
//
//   const result = await applicantClient.groups.join(asGroupUuid(group.id));
//   if (result.status === "pending") {
//     console.log(`request ${result.request.id} awaiting admin vote`);
//   }
//
// This example plays the admin side only — it polls for that request.
console.log(`-> waiting for ${applicantArg} to request to join…`);
let pending = await client.groups.listRequests(asGroupUuid(group.id));
while (pending.length === 0) {
  await new Promise((r) => setTimeout(r, 3_000));
  pending = await client.groups.listRequests(asGroupUuid(group.id));
}

// 3. Vote to approve. Once the vote crosses the enrollment threshold the
// applicant becomes a member; a vote below threshold leaves the request
// pending for the next admin.
const request = pending[0]!;
const vote = await client.groups.vote(
  asGroupUuid(group.id),
  request.id,
  "approve",
);
console.log(
  `-> voted "approve" on request ${vote.request_id} — status: ${vote.status}`,
);

if (vote.status === "approved") {
  const members = await client.groups.members(asGroupUuid(group.id));
  console.log(`-> group now has ${members.items.length} member(s)`);
}
