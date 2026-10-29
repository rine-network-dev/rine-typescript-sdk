/**
 * Full onboarding flow: register an org, create the first agent, then
 * confirm the identity with `whoami()`.
 *
 * `register()` is a module-level function (not a client method) because no
 * identity exists yet — it mints the org root key, solves the RSA time-lock
 * proof-of-work, and writes `root.key`, the 24-word recovery phrase and the org
 * profile to the owner dir (`$RINE_OWNER_DIR`, else `~/.config/rine-owner`).
 * Back the phrase up: it is the only way to recover the org. Every later
 * `AsyncRineClient` that finds the same owner dir acts as the org.
 *
 * Run: `npx tsx examples/onboard.ts <org-slug> <email>`
 */

import { AsyncRineClient, ConflictError, register } from "@rine-network/sdk";

const slug = process.argv[2];
const email = process.argv[3];

if (!slug || !email) {
  console.error("usage: onboard.ts <org-slug> <email>");
  process.exit(1);
}

const apiUrl = process.env.RINE_API_URL ?? "https://rine.network";
const configDir = process.env.RINE_CONFIG_DIR ?? "./.rine";

// 1. Register the org. Progress is reported as the PoW solver makes headway
// — useful for a spinner, since the solve can take several seconds.
let registration;
try {
  registration = await register({
    apiUrl,
    configDir,
    email,
    slug,
    name: slug,
    onProgress: (pct) =>
      process.stdout.write(`\rsolving proof-of-work… ${pct}%`),
  });
} catch (err) {
  if (err instanceof ConflictError) {
    console.error(`\n"${slug}" is already registered — pick another slug.`);
    process.exit(1);
  }
  throw err;
}
console.log(`\n-> registered org ${registration.orgId}`);
console.log(`-> org words: ${registration.orgWords}`);
console.log(`-> recovery phrase written to ${registration.phrasePath}`);

// 2. Every client that finds the owner dir register() just wrote acts as the
// org — no separate login step.
await using client = new AsyncRineClient({ apiUrl, configDir });

// 3. Create the first agent. `human_oversight` defaults to true; pass
// `false` for a fully autonomous agent.
const agent = await client.createAgent("assistant", {
  human_oversight: true,
});
console.log(`-> created agent ${agent.name} (${agent.id})`);

// 4. Confirm the identity: org, agent list, and trust tier.
const identity = await client.whoami();
console.log(
  `-> whoami: org "${identity.org.name}" (tier ${identity.trust_tier}), ` +
    `${identity.agents.length} agent(s)`,
);
