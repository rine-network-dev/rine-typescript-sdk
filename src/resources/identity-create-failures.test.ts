import * as fs from "node:fs";
import * as path from "node:path";
import { AgentIdMismatchError } from "@rine-network/core";
import {
	type CustodyFixture,
	makeCustodyFixture,
} from "@rine-network/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ID, makeHttpStub } from "../_identity-stub.js";
import { IdentityResource } from "./identity.js";

describe("IdentityResource.createAgent refusals", () => {
	let fx: CustodyFixture;
	let prevSpiffe: string | undefined;

	beforeEach(() => {
		fx = makeCustodyFixture();
		prevSpiffe = process.env.SPIFFE_ENDPOINT_SOCKET;
		// biome-ignore lint/performance/noDelete: test-scoped env teardown.
		delete process.env.SPIFFE_ENDPOINT_SOCKET;
	});
	afterEach(() => {
		fx.cleanup();
		if (prevSpiffe !== undefined) {
			process.env.SPIFFE_ENDPOINT_SOCKET = prevSpiffe;
		}
	});

	it("refuses to persist keys when configDir is empty (CWD footgun)", async () => {
		const { http, posts } = makeHttpStub(fx, { configDir: "" });
		const identity = new IdentityResource(http);

		await expect(identity.createAgent("dave")).rejects.toThrow(
			/requires a non-empty SDK configDir/,
		);
		// Guard must run before the POST so no server-side agent is orphaned.
		expect(posts).toHaveLength(0);
	});

	it("test_create_agent_when_the_server_answers_another_id_then_it_throws_and_saves_nothing", async () => {
		const { http, corePosts } = makeHttpStub(fx, { serverId: AGENT_ID });

		const err = await new IdentityResource(http)
			.createAgent("dave")
			.catch((e) => e);

		expect(err).toBeInstanceOf(AgentIdMismatchError);
		expect(err.serverId).toBe(AGENT_ID);
		expect(fs.existsSync(path.join(fx.dirs.configDir, "keys"))).toBe(false);
		expect(fs.existsSync(path.join(fx.dirs.configDir, "profiles.json"))).toBe(
			false,
		);
		expect(corePosts).toEqual([]);
	});

	it("does not save keys when the POST rejects", async () => {
		const { http, posts } = makeHttpStub(fx, {
			postError: new Error("network down"),
		});
		const identity = new IdentityResource(http);

		await expect(identity.createAgent("carol")).rejects.toThrow("network down");

		// The POST was attempted, but no keys directory was created.
		expect(posts).toHaveLength(1);
		expect(fs.existsSync(path.join(fx.dirs.configDir, "keys"))).toBe(false);
	});
});
