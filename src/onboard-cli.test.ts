/** The shared onboard entry point: parse errors report usage and set a non-zero exit code. */

import { afterEach, describe, expect, it } from "vitest";
import { runOnboardCli } from "./onboard-cli.js";

describe("runOnboardCli", () => {
	afterEach(() => {
		process.exitCode = undefined;
	});

	it("test_runOnboardCli_when_a_flag_is_missing_then_it_reports_usage_on_the_error_channel", async () => {
		const out: string[] = [];
		const err: string[] = [];
		const handle = await runOnboardCli("eve", ["--email", "a@b.co"], [], {
			log: (l) => out.push(l),
			error: (l) => err.push(l),
		});
		expect(handle).toBeUndefined();
		expect(process.exitCode).toBe(1);
		expect(out).toEqual([]);
		expect(err[0]).toContain("Missing required flag(s)");
		expect(err[1]).toContain("npx @rine-network/eve onboard");
	});

	it("test_runOnboardCli_when_no_error_channel_then_usage_goes_to_log", async () => {
		const out: string[] = [];
		await runOnboardCli("mastra", ["--bogus", "x"], [], { log: (l) => out.push(l) });
		expect(out[0]).toContain("Unknown flag: --bogus");
		expect(out[1]).toContain("npx @rine-network/mastra onboard");
	});
});
