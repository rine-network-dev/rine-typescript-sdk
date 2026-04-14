/**
 * Unit tests for `utils/schema.ts`.
 *
 * Every test uses a hand-rolled Standard Schema v1 implementation so the
 * SDK has no hidden runtime dependency on Zod / Valibot / ArkType during
 * test runs. Passing a compliant object in exercises the same
 * `~standard.validate` contract every real validator implements.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { SchemaValidationError } from "../errors.js";
import type { DecryptedMessage } from "../types.js";
import {
	parseMessagePlaintext,
	parsePlaintext,
	validateOutbound,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Minimal Standard Schema factories — the shape rine-ts-sdk ships against.
// ---------------------------------------------------------------------------

interface TaskShape {
	query: string;
	maxResults: number;
}

/** Always-valid schema that echoes the input as `TaskShape`. */
function okTaskSchema(): StandardSchemaV1<unknown, TaskShape> {
	return {
		"~standard": {
			version: 1,
			vendor: "rine-test",
			validate: (value) => ({ value: value as TaskShape }),
		},
	};
}

/** Schema that rejects with a single issue referencing `path`. */
function failingSchema(
	message: string,
	path?: readonly PropertyKey[],
): StandardSchemaV1<unknown, unknown> {
	return {
		"~standard": {
			version: 1,
			vendor: "rine-test",
			validate: () => ({
				issues: [{ message, path: path as readonly PropertyKey[] | undefined }],
			}),
		},
	};
}

/** Async-validator schema — exercises the `await` path in `parsePlaintext`. */
function asyncOkSchema<T>(output: T): StandardSchemaV1<unknown, T> {
	return {
		"~standard": {
			version: 1,
			vendor: "rine-test-async",
			validate: async (_value) => {
				await Promise.resolve();
				return { value: output };
			},
		},
	};
}

// ---------------------------------------------------------------------------
// parsePlaintext
// ---------------------------------------------------------------------------

describe("parsePlaintext()", () => {
	it("returns the typed value on a successful validation", async () => {
		const schema = okTaskSchema();
		const out = await parsePlaintext(
			{ query: "weather", maxResults: 5 },
			schema,
		);
		expect(out).toEqual({ query: "weather", maxResults: 5 });
	});

	it("throws SchemaValidationError on a failing schema", async () => {
		const schema = failingSchema("expected object");
		await expect(parsePlaintext({}, schema)).rejects.toBeInstanceOf(
			SchemaValidationError,
		);
	});

	it("includes the first issue path in the error message", async () => {
		const schema = failingSchema("must be a string", ["query"]);
		await expect(parsePlaintext({}, schema)).rejects.toThrow(/at query/);
	});

	it("formats nested array paths as [index]", async () => {
		const schema = failingSchema("must be a number", [
			"items",
			0,
			{ key: "count" } as unknown as PropertyKey,
		]);
		await expect(parsePlaintext({}, schema)).rejects.toThrow(
			/at items\.\[0\]\.count/,
		);
	});

	it("awaits an async validate()", async () => {
		const schema = asyncOkSchema<TaskShape>({
			query: "async",
			maxResults: 1,
		});
		const out = await parsePlaintext({}, schema);
		expect(out).toEqual({ query: "async", maxResults: 1 });
	});

	it("handles a schema that reports zero issues by returning the value", async () => {
		const schema: StandardSchemaV1<unknown, number> = {
			"~standard": {
				version: 1,
				vendor: "rine-test",
				validate: () => ({ value: 42 }),
			},
		};
		expect(await parsePlaintext("anything", schema)).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// validateOutbound
// ---------------------------------------------------------------------------

describe("validateOutbound()", () => {
	it("returns the validated value on success", async () => {
		const schema = okTaskSchema();
		const payload = { query: "out", maxResults: 2 };
		await expect(validateOutbound(payload, schema)).resolves.toEqual(payload);
	});

	it("throws SchemaValidationError on failure, preventing encrypt downstream", async () => {
		const schema = failingSchema("required", ["query"]);
		await expect(
			validateOutbound({ maxResults: 2 }, schema),
		).rejects.toBeInstanceOf(SchemaValidationError);
	});
});

// ---------------------------------------------------------------------------
// parseMessagePlaintext
// ---------------------------------------------------------------------------

function makeMsg(plaintext: string | null | undefined): DecryptedMessage {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		conversation_id: "00000000-0000-0000-0000-000000000002",
		type: "rine.v1.task_request",
		encrypted_payload: "ciphertext",
		encryption_version: "hpke-v1",
		metadata: {},
		created_at: "2026-04-11T00:00:00.000Z",
		verified: true,
		verification_status: "verified",
		plaintext,
		decrypt_error: null,
	};
}

describe("parseMessagePlaintext()", () => {
	it("JSON-parses a string plaintext and narrows to T", async () => {
		const msg = makeMsg(JSON.stringify({ query: "paris", maxResults: 3 }));
		const schema = okTaskSchema();
		const typed = await parseMessagePlaintext(msg, schema);
		expect(typed.plaintext).toEqual({ query: "paris", maxResults: 3 });
		// Non-plaintext fields are preserved verbatim.
		expect(typed.type).toBe(msg.type);
		expect(typed.verified).toBe(true);
	});

	it("leaves messages with null plaintext untouched", async () => {
		const msg = makeMsg(null);
		const schema = okTaskSchema();
		const typed = await parseMessagePlaintext(msg, schema);
		expect(typed.plaintext).toBeNull();
	});

	it("leaves messages with undefined plaintext untouched", async () => {
		const msg = makeMsg(undefined);
		const schema = okTaskSchema();
		const typed = await parseMessagePlaintext(msg, schema);
		expect(typed.plaintext).toBeUndefined();
	});

	it("throws SchemaValidationError when JSON.parse fails", async () => {
		const msg = makeMsg("{ not json");
		const schema = okTaskSchema();
		await expect(parseMessagePlaintext(msg, schema)).rejects.toMatchObject({
			name: "SchemaValidationError",
		});
	});

	it("throws SchemaValidationError when schema validation fails", async () => {
		const msg = makeMsg(JSON.stringify({ query: "ok" })); // missing maxResults
		const schema = failingSchema("maxResults required", ["maxResults"]);
		await expect(parseMessagePlaintext(msg, schema)).rejects.toThrow(
			/at maxResults/,
		);
	});

	it("does not mutate the original message", async () => {
		const msg = makeMsg(JSON.stringify({ query: "x", maxResults: 1 }));
		const snapshot = { ...msg };
		const schema = okTaskSchema();
		await parseMessagePlaintext(msg, schema);
		expect(msg).toEqual(snapshot);
	});
});
