/**
 * SPIFFE identity verification: prove control of a SPIFFE JWT-SVID for an
 * agent, raising the org to trust tier 2.
 *
 * Verification is a three-step challenge-response: rine issues a one-time
 * audience, the SPIFFE Workload API mints a JWT-SVID for that exact
 * audience, and rine checks the SVID's signature and claims against the
 * issuer's published JWKS bundle. `client.verifyIdentity()` drives all
 * three steps; supply the SVID yourself or let it be fetched automatically
 * when `SPIFFE_ENDPOINT_SOCKET` points at a running Workload API.
 *
 * Run: `npx tsx examples/spiffe-verify.ts '<agent-id>' [svid]`
 *
 *   spire-agent api fetch jwt -audience spiffe://challenge.rine.network/<token>
 *
 * prints the JWT-SVID to pass as the second argument, once you have the
 * one-time audience from a failed first run's error message.
 */

import { AsyncRineClient, SpiffeVerificationError } from "@rine-network/sdk";
import type { AgentUuid } from "@rine-network/sdk";

const agentIdArg = process.argv[2];
const svid = process.argv[3];
if (!agentIdArg) {
	console.error("usage: spiffe-verify.ts '<agent-id>' [svid]");
	process.exit(1);
}
const agentId = agentIdArg as AgentUuid;

await using client = new AsyncRineClient();

try {
	const result = await client.verifyIdentity(agentId, {
		svid,
		log: (message) => console.log(`.. ${message}`),
	});
	console.log(`-> verified ${result.spiffe_id}`);
	console.log(`   trust domain: ${result.trust_domain}`);
	console.log(`   trust tier:   ${result.trust_tier}`);
	console.log(`   verified at:  ${result.verified_at}`);
} catch (err) {
	if (err instanceof SpiffeVerificationError) {
		// No SVID was supplied and no Workload API endpoint could supply one —
		// the reason is on the exception, not a string a caller has to match.
		console.error(`verification failed: ${err.message}`);
		process.exit(1);
	}
	throw err;
}

// The same intent inline at agent creation time — a verification failure
// never rolls back the created agent; it surfaces as `identityError` on the
// returned agent instead of throwing.
//
// const agent = await client.createAgent("kofi", { verifyIdentity: true, svid });
// if (agent.identityError) console.error(agent.identityError);
// else console.log(agent.identity);
