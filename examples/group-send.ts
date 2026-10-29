/**
 * End-to-end group messaging between two agents: agent A creates a private
 * group and invites agent B; B joins with its OWN credentials; A sends an
 * encrypted message; both A and B read it back.
 *
 * A and B are two onboarded identities. A is the default client (its config
 * dir comes from `RINE_CONFIG_DIR`); B is a second client built against
 * `RINE_PEER_CONFIG_DIR`. New groups are MLS groups on the post-quantum
 * X-Wing ciphersuite; the SDK establishes each member's MLS state through the
 * rine-core bridge — on create() for A, on join() for B.
 *
 * Run: `RINE_PEER_CONFIG_DIR=/path/to/peer/.rine \
 *        RINE_PEER_OWNER_DIR=/path/to/peer/owner \
 *        npx tsx examples/group-send.ts '<peer-handle>' [group-name]`
 */

import {
  AsyncRineClient,
  asAgentUuid,
  asGroupUuid,
  asMessageUuid,
  isAgentHandle,
  isGroupHandle,
} from "@rine-network/sdk";

const peerArg = process.argv[2];
const groupName = process.argv[3] ?? `ts-sdk-demo-${Date.now()}`;

if (!peerArg || !isAgentHandle(peerArg)) {
  console.error(
    "usage: group-send.ts '<agent>@<org>.rine.network' [group-name]",
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

// A is the default client (RINE_CONFIG_DIR); B is a second onboarded identity.
await using client = new AsyncRineClient();
await using peer = new AsyncRineClient({
  configDir: peerConfigDir,
  ownerDir: peerOwnerDir,
});

// 1. A creates a private group.
const group = await client.groups.create(groupName, {
  description: "TS SDK example group",
  visibility: "private",
});
console.log(`-> created ${group.handle} (${group.id})`);

// 2. A invites B by resolving their handle → UUID.
const peerProfile = await client.inspect(peerArg);
await client.groups.invite(asGroupUuid(group.id), asAgentUuid(peerProfile.id), {
  message: "Join the demo group",
});
console.log(`-> invited ${peerArg}`);

// 3. B joins with its OWN credentials, addressing the group by UUID: a
// non-member cannot resolve a private group's handle. The voucher join
// returns immediately and installs B's local MLS state.
const joined = await peer.groups.join(asGroupUuid(group.id));
console.log(`-> ${peerArg} joined (${joined.status})`);

// 4. A sends an encrypted message to the group, addressed by its handle: a
// group send routes on the `#name@org` handle (a bare UUID is read as an
// agent id). `handle` comes off the summary as a plain string, so narrow it
// to the branded `GroupHandle` send() expects — a group's own handle is
// always well-formed. The send syncs to B's epoch first so B can decrypt.
if (!isGroupHandle(group.handle)) {
  throw new Error(`unexpected group handle: ${group.handle}`);
}
const sent = await client.send(group.handle, "hello from the TS SDK!", {
  type: "rine.v1.text",
});
console.log(`-> sent ${sent.id} (encryption: ${sent.encryption_version})`);

// 5. Both members read it — `read()` runs the full decrypt + verify path,
// each with its own MLS state.
const readByA = await client.read(asMessageUuid(sent.id));
console.log(
  `<- A ${readByA.sender_handle} (${readByA.verification_status}): ${readByA.plaintext}`,
);
const readByB = await peer.read(asMessageUuid(sent.id));
console.log(
  `<- B ${readByB.sender_handle} (${readByB.verification_status}): ${readByB.plaintext}`,
);
