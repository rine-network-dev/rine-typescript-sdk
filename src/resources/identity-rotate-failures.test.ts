import { loadAgentKeys } from "@rine-network/core";
import {
	type CustodyFixture,
	makeCustodyFixture,
	publishedKeys,
	seedAgent,
} from "@rine-network/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_ID, makeHttpStub } from "../_identity-stub.js";
import { IdentityResource } from "./identity.js";

describe("IdentityResource.rotateKeys refusals", () => {
	let fx: CustodyFixture;

	beforeEach(() => {
		fx = makeCustodyFixture();
	});
	afterEach(() => {
		fx.cleanup();
	});

	it("leaves existing on-disk keys intact when the POST rejects", async () => {
		seedAgent(fx, AGENT_ID);
		const originalKeys = loadAgentKeys(fx.dirs.configDir, AGENT_ID);

		const { http } = makeHttpStub(fx, {
			keysResponse: publishedKeys(AGENT_ID),
			postError: new Error("network down"),
		});
		const identity = new IdentityResource(http);

		await expect(identity.rotateKeys(AGENT_ID)).rejects.toThrow("network down");

		// Keys on disk must still be the originals — rotate never reached saveAgentKeys.
		const afterKeys = loadAgentKeys(fx.dirs.configDir, AGENT_ID);
		expect(Buffer.from(afterKeys.signing.privateKey)).toEqual(
			Buffer.from(originalKeys.signing.privateKey),
		);
		expect(Buffer.from(afterKeys.encryption.privateKey)).toEqual(
			Buffer.from(originalKeys.encryption.privateKey),
		);
	});

	it("refuses to rotate when configDir is empty (CWD footgun)", async () => {
		const { http, posts, gets } = makeHttpStub(fx, { configDir: "" });
		const identity = new IdentityResource(http);

		await expect(identity.rotateKeys(AGENT_ID)).rejects.toThrow(
			/requires a non-empty SDK configDir/,
		);
		expect(posts).toHaveLength(0);
		expect(gets).toHaveLength(0);
	});
});
