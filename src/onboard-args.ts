/** Argument parsing for the connectors' `onboard` commands. Pure and side-effect free. */

import type { OnboardOptions } from "./onboard-runner.js";

const FLAGS = [
	"email",
	"slug",
	"name",
	"agent-name",
	"api-url",
	"config-dir",
	"owner-dir",
] as const;

const REQUIRED = ["email", "slug", "name"] as const;

/** The connector packages that ship an `onboard` command. */
export type OnboardConnector = "eve" | "mastra";

/** The usage line of `npx @rine-network/<connector> onboard`. */
export function onboardUsage(connector: OnboardConnector): string {
	return `Usage: npx @rine-network/${connector} onboard --email <e> --slug <s> --name <n> [--agent-name <a>] [--api-url <u>] [--config-dir <d>] [--owner-dir <d>]`;
}

/**
 * Parse `onboard` argv (the slice AFTER the `onboard` subcommand). Throws on a
 * missing required flag or an unknown flag so the caller can print usage and exit 1.
 */
export function parseOnboardArgs(argv: readonly string[]): OnboardOptions {
	const flags: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
		const key = arg.slice(2);
		const value = argv[++i];
		if (value === undefined) throw new Error(`Missing value for --${key}`);
		flags[key] = value;
	}

	for (const key of Object.keys(flags)) {
		if (!(FLAGS as readonly string[]).includes(key)) {
			throw new Error(`Unknown flag: --${key}`);
		}
	}

	const missing = REQUIRED.filter((k) => !flags[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}`,
		);
	}

	return {
		email: flags.email as string,
		slug: flags.slug as string,
		name: flags.name as string,
		apiUrl: flags["api-url"],
		configDir: flags["config-dir"],
		ownerDir: flags["owner-dir"],
		agentName: flags["agent-name"],
	};
}
