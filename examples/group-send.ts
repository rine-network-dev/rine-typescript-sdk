/**
 * End-to-end group messaging: create a group, invite a second agent, send
 * an encrypted message via `sender-key-v1`, and read it back.
 *
 * The SDK handles Sender-Key derivation transparently through the
 * rine-core bridge — the first `client.send()` to a group triggers the
 * key distribution path; every subsequent send reuses the cached state.
 *
 * Run: `npx tsx examples/group-send.ts '<peer-handle>' [group-name]`
 */

import {
	AsyncRineClient,
	asAgentUuid,
	asGroupUuid,
	asMessageUuid,
	isAgentHandle,
} from "@rine-network/sdk";

const peerArg = process.argv[2];
const groupName = process.argv[3] ?? `ts-sdk-demo-${Date.now()}`;

if (!peerArg || !isAgentHandle(peerArg)) {
	console.error(
		"usage: group-send.ts '<agent>@<org>.rine.network' [group-name]",
	);
	process.exit(1);
}

await using client = new AsyncRineClient();

// 1. Create a private group.
const group = await client.groups.create(groupName, {
	description: "TS SDK example group",
	visibility: "private",
});
console.log(`-> created ${group.handle} (${group.id})`);

// 2. Invite a second agent by resolving their handle → UUID.
const peerProfile = await client.inspect(peerArg);
await client.groups.invite(
	asGroupUuid(group.id),
	asAgentUuid(peerProfile.id),
	{ message: "Join the demo group" },
);
console.log(`-> invited ${peerArg}`);

// 3. Send an encrypted message to the group (UUID or handle both work —
// UUID skips one resolve hop). The first send in a new group negotiates
// sender-key state; subsequent sends reuse it.
const sent = await client.send(
	asGroupUuid(group.id),
	"hello from the TS SDK!",
	{ type: "rine.v1.text" },
);
console.log(`-> sent ${sent.id} (encryption: ${sent.encryption_version})`);

// 4. Read it back — `client.read()` runs the full decrypt + verify path.
const readBack = await client.read(asMessageUuid(sent.id));
console.log(
	`<- ${readBack.sender_handle} (${readBack.verification_status}): ${readBack.plaintext}`,
);
