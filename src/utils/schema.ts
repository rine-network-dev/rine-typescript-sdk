/**
 * Standard Schema v1 integration helpers.
 *
 * The SDK accepts user-supplied schemas on `send<T>`, `read<T>`, `reply<T>`,
 * `messages<T>`, `sendAndWait<Req, Rep>`, `conversation(id).{send,reply,messages,history}<T>`,
 * and `defineAgent<T>`. `@standard-schema/spec` is a type-only package — no
 * validator runtime ships with the SDK. Users bring Zod, Valibot, ArkType,
 * Effect Schema, or any other compliant library and pass a schema object via
 * the `schema` option slot.
 *
 * Two exported helpers:
 *
 * - `parsePlaintext<T>(value, schema)` — validates an arbitrary plaintext
 *   value against a Standard Schema v1 and returns the typed output. Throws
 *   `ValidationError` on the first issue reported by the schema.
 *
 * - `parseMessagePlaintext<T>(msg, schema)` — wraps `parsePlaintext` with
 *   the JSON-parse step specific to `DecryptedMessage.plaintext` (which is
 *   a string coming out of rine-core's `decryptMessage` / `decryptGroupMessage`
 *   helpers) and returns a `DecryptedMessage<T>` with the typed plaintext
 *   folded back in. If `msg.plaintext` is `null` (decrypt failed upstream)
 *   the message is returned untouched — the schema is not applied to a
 *   `decrypt_error` envelope.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { SchemaValidationError } from "../errors.js";
import type { DecryptedMessage } from "../types.js";

export type { StandardSchemaV1 };

/**
 * Validate an arbitrary value against a Standard Schema v1 and return the
 * typed output. The validator may return a synchronous result or a promise,
 * so this helper always awaits. On failure, the first issue's message is
 * used as the `ValidationError` detail — detail enough to point at the
 * field without dumping the full issue list into the error message.
 */
export async function parsePlaintext<T>(
	value: unknown,
	schema: StandardSchemaV1<unknown, T>,
): Promise<T> {
	const result = await schema["~standard"].validate(value);
	if (result.issues !== undefined) {
		const first = result.issues[0];
		const path =
			first?.path && first.path.length > 0
				? ` at ${formatPath(first.path)}`
				: "";
		const reason = first?.message ?? "(no message)";
		throw new SchemaValidationError(
			`Plaintext failed schema validation${path}: ${reason}`,
		);
	}
	return result.value;
}

/**
 * JSON-parse a `DecryptedMessage.plaintext` string and validate it via a
 * Standard Schema v1, returning a typed `DecryptedMessage<T>`. Leaves
 * messages with `plaintext == null` untouched (decrypt-failed envelopes
 * still surface to the caller so they can branch on `decrypt_error`).
 *
 * The JSON-parse step is mandatory: Standard Schemas like Zod's `z.object`
 * validate structured input, not raw strings. If a caller's payload is
 * already a plain string, they can use `z.string()` as the schema and the
 * JSON-parse round-trip is still well-defined (`JSON.parse('"hi"') === "hi"`).
 */
export async function parseMessagePlaintext<T>(
	msg: DecryptedMessage,
	schema: StandardSchemaV1<unknown, T>,
): Promise<DecryptedMessage<T>> {
	if (msg.plaintext == null) {
		return msg as DecryptedMessage<T>;
	}

	let candidate: unknown;
	try {
		candidate =
			typeof msg.plaintext === "string"
				? JSON.parse(msg.plaintext)
				: msg.plaintext;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new SchemaValidationError(`Plaintext is not valid JSON: ${reason}`);
	}

	const value = await parsePlaintext(candidate, schema);
	return { ...msg, plaintext: value } as DecryptedMessage<T>;
}

/**
 * Validate an outbound payload against a Standard Schema v1 before it is
 * handed to the encryption layer. Outbound schemas run *before* encrypt so
 * a shape failure rejects without sending any ciphertext.
 *
 * This helper returns the validated (possibly transformed — schemas may
 * parse / coerce) value so the caller can encrypt the narrowed form rather
 * than the raw input. For schemas that are pure type guards (no transforms)
 * the returned value is reference-equal to the input.
 */
export async function validateOutbound<T>(
	payload: T,
	schema: StandardSchemaV1<unknown, T>,
): Promise<T> {
	return parsePlaintext(payload, schema);
}

function formatPath(
	path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>,
): string {
	return path
		.map((seg) => {
			const key = typeof seg === "object" && seg !== null ? seg.key : seg;
			return typeof key === "number" ? `[${key}]` : String(key);
		})
		.join(".");
}
