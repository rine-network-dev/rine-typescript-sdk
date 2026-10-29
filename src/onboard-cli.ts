/** The shared entry point behind the connectors' `onboard` commands: parse, report, run. */

import { type OnboardConnector, onboardUsage, parseOnboardArgs } from "./onboard-args.js";
import { type OnboardIO, runOnboardFlow, stdoutOnboardIO } from "./onboard-runner.js";

/**
 * Parse `argv` (the slice AFTER the `onboard` subcommand) and run the flow. A parse
 * error prints the message and the connector's usage line, sets a non-zero exit
 * code and returns `undefined`; otherwise returns the new agent's handle.
 */
export async function runOnboardCli(
	connector: OnboardConnector,
	argv: readonly string[],
	closingLines: readonly string[],
	io: OnboardIO = stdoutOnboardIO,
): Promise<string | undefined> {
	let opts: ReturnType<typeof parseOnboardArgs>;
	try {
		opts = parseOnboardArgs(argv);
	} catch (err) {
		const report = io.error ?? io.log;
		report(err instanceof Error ? err.message : String(err));
		report(onboardUsage(connector));
		process.exitCode = 1;
		return undefined;
	}
	return runOnboardFlow(opts, closingLines, io);
}
