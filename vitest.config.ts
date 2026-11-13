import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		maxWorkers: 4, // tank OOMs at one worker per CPU; `--maxWorkers=N` still overrides
		minWorkers: 1, // vitest <4 rejects maxWorkers below its default minimum
		globals: true,
		environment: "node",
		include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/index.ts",
			],
			thresholds: {
				lines: 70,
				statements: 70,
				functions: 70,
				branches: 70,
			},
		},
	},
});
