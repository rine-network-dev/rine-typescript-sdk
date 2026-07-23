/**
 * Full onboarding flow: register an org, create the first agent, then
 * confirm the identity with `whoami()`.
 *
 * `register()` is a module-level function (not a client method) because no
 * credentials exist yet — it solves the RSA time-lock proof-of-work, writes
 * `{configDir}/credentials.json`, and caches the initial OAuth token. Every
 * later `AsyncRineClient` constructed against the same `configDir` picks up
 * those credentials automatically.
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

// 2. Every client built against the same configDir reuses the credentials
// register() just wrote — no separate login step.
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
