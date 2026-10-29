/** Argument parsing for the connectors' `onboard` commands. Pure, no proof-of-work. */

import { describe, expect, it } from "vitest";
import { onboardUsage, parseOnboardArgs } from "./onboard-args.js";
import { agentNameFromOrgName } from "./onboard-runner.js";

describe("parseOnboardArgs", () => {
	it("parses the three required flags", () => {
		const args = parseOnboardArgs([
			"--email",
			"a@b.co",
			"--slug",
			"acme",
			"--name",
			"Acme",
		]);
		expect(args).toEqual({
			email: "a@b.co",
			slug: "acme",
			name: "Acme",
			apiUrl: undefined,
			configDir: undefined,
			ownerDir: undefined,
			agentName: undefined,
		});
	});

	it("parses the optional --agent-name override", () => {
		const args = parseOnboardArgs([
			"--email",
			"a@b.co",
			"--slug",
			"acme",
			"--name",
			"Acme Inc",
			"--agent-name",
			"coordinator",
		]);
		expect(args.agentName).toBe("coordinator");
	});

	it("parses the optional --owner-dir override", () => {
		const args = parseOnboardArgs([
			"--email",
			"a@b.co",
			"--slug",
			"acme",
			"--name",
			"Acme",
			"--owner-dir",
			"/tmp/owner",
		]);
		expect(args.ownerDir).toBe("/tmp/owner");
	});

	it("parses the optional --api-url and --config-dir overrides", () => {
		const args = parseOnboardArgs([
			"--email",
			"a@b.co",
			"--slug",
			"acme",
			"--name",
			"Acme",
			"--api-url",
			"https://test.rine",
			"--config-dir",
			"/tmp/cfg",
		]);
		expect(args.apiUrl).toBe("https://test.rine");
		expect(args.configDir).toBe("/tmp/cfg");
	});

	it("throws on a missing required flag", () => {
		expect(() =>
			parseOnboardArgs(["--email", "a@b.co", "--slug", "acme"]),
		).toThrow(/Missing required flag\(s\): --name/);
	});

	it("throws on an unknown flag", () => {
		expect(() =>
			parseOnboardArgs([
				"--email",
				"a@b.co",
				"--slug",
				"acme",
				"--name",
				"Acme",
				"--bogus",
				"x",
			]),
		).toThrow(/Unknown flag: --bogus/);
	});

	it("throws on a flag with no value", () => {
		expect(() => parseOnboardArgs(["--email"])).toThrow(
			/Missing value for --email/,
		);
	});

	it("throws on a non-flag positional argument", () => {
		expect(() => parseOnboardArgs(["onboard", "--email", "a@b.co"])).toThrow(
			/Unexpected argument: onboard/,
		);
	});
});

describe("agentNameFromOrgName — handle-safe derivation (regression: server 422 on display names)", () => {
	it("lowercases and hyphenates a spaced display name", () => {
		expect(agentNameFromOrgName("My Org", "my-org-slug")).toBe("my-org");
		expect(agentNameFromOrgName("E2E Driver", "drv")).toBe("e2e-driver");
	});

	it("folds runs of specials to a single interior hyphen and trims edges", () => {
		expect(agentNameFromOrgName("  Acme,  Inc!! ", "acme")).toBe("acme-inc");
		expect(agentNameFromOrgName("a@@@b", "fallback")).toBe("a-b");
	});

	it("falls back to the slug when nothing usable remains", () => {
		expect(agentNameFromOrgName("---", "acme")).toBe("acme");
		expect(agentNameFromOrgName("！！！", "acme")).toBe("acme");
	});

	it("only ever yields a server-valid agent name (1–200 lowercase alnum + interior hyphens)", () => {
		const valid = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
		for (const [name, slug] of [
			["My Org", "s1"],
			["E2E Driver", "s2"],
			["Acme, Inc.", "s3"],
			["x", "s4"],
		] as const) {
			const derived = agentNameFromOrgName(name, slug);
			expect(derived).toMatch(valid);
			expect(derived.length).toBeGreaterThanOrEqual(1);
			expect(derived.length).toBeLessThanOrEqual(200);
		}
	});
});

describe("onboardUsage", () => {
	it("names the connector the command runs under", () => {
		expect(onboardUsage("eve")).toContain("npx @rine-network/eve onboard");
		expect(onboardUsage("mastra")).toContain("npx @rine-network/mastra onboard");
	});
});
