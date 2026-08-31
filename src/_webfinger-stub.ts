/**
 * A WebFinger transport for suites that send to an agent handle.
 *
 * 🔴 Replaces mocking `resolveToUuid` out of `@rine-network/core`, which stopped
 * working — and, more to the point, stopped meaning anything — when `send()`
 * moved onto the recipient contract. `resolveRecipient` calls the agent
 * resolver INSIDE the core bundle, so a `vi.mock` on the exported name is no
 * longer on the path: the mock stayed green as a mock and the product stopped
 * consulting it. A suite that pins how a handle is resolved has to pin it where
 * the resolution actually leaves the process, which is this one request.
 *
 * That is also the stronger test. `normalizeHandle` running before the lookup
 * is a claim about the wire — `acct:bot@acme.rine.network`, never `acct:bot@acme`
 * — and asserting it on {@link WebFingerStub.resources} survives any rearranging
 * of which function calls which.
 *
 * Deliberately free of `vitest`: `src` is emitted as declarations by
 * `tsconfig.build.json`, and a test-only import here would put vitest's types
 * into the published tree.
 */

/** What the stub recorded, and how to put the real `fetch` back. */
export interface WebFingerStub {
	/** Every `acct:` resource asked for, in order. */
	readonly resources: string[];
	restore(): void;
}

/**
 * Answer WebFinger from a fixed handle → agent-id map, and 404 everything else.
 *
 * A handle that is absent is a handle nobody can resolve, which is what the
 * server does and what the refusal path under test needs.
 */
export function stubWebFinger(
	agents: Readonly<Record<string, string>>,
): WebFingerStub {
	const real = globalThis.fetch;
	const resources: string[] = [];

	globalThis.fetch = (async (input: unknown) => {
		const url = new URL(String(input));
		const resource = url.searchParams.get("resource") ?? "";
		resources.push(resource);
		const id = agents[resource.replace(/^acct:/, "").toLowerCase()];
		if (!id) {
			return {
				ok: false,
				status: 404,
				json: async () => ({}),
				text: async () => "",
			};
		}
		return {
			ok: true,
			status: 200,
			json: async () => ({ aliases: [`https://webfinger.test/agents/${id}`] }),
		};
	}) as unknown as typeof fetch;

	return {
		resources,
		restore() {
			globalThis.fetch = real;
		},
	};
}
