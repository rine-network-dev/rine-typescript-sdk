/**
 * How `RineError` recognises the refusals `rine-core` mints on the SDK's
 * behalf.
 *
 * `MlsDowngradeError` and `MlsInitInFlightError` are thrown out of
 * `messages.send()` and are part of this SDK's contract, but they are declared
 * in `rine-core` because the CLI, the MCP server and this SDK all raise them
 * and one definition is the whole point. `rine-core` cannot extend `RineError`
 * without depending on the SDK, and re-declaring them here would restore the
 * duplication — so `RineError` widens its own `instanceof` instead, and the
 * mechanism lives here rather than inside a file that is otherwise a plain
 * list of error classes.
 *
 * 🔴 `GroupIdentityMismatchError` is the third, and it arrived by a different
 * road: the substitution check lives in `rine-core`'s UUID rung, which
 * `groups.resolveRef` resolves through, so this SDK once threw a core-minted
 * refusal that carried the same NAME as one of its own classes — and a
 * consumer catching `RineError` around `resolveRef` was catching nothing at
 * all. The SDK-local declaration is gone, `errors-classes` re-exports the core
 * class, and `groups.get` and `resolveRef` throw the same one, so
 * `instanceof GroupIdentityMismatchError` is true for both.
 * `isGroupIdentityMismatchError` remains the predicate for a consumer that
 * would rather not name the class, and it is the only thing that answers true
 * for a refusal crossing a package boundary the bundler duplicated.
 *
 * 🔴 `PrincipalRevokedError` is the one that exists twice: the SDK declares a
 * subclass of its `AuthenticationError`, and the operations the SDK delegates to
 * `rine-core` raise core's class, which cannot extend that one. A catch of
 * `RineError` holds for both, and `isPrincipalRevokedError` is the predicate
 * that answers true for either.
 *
 * 🔴 `EscrowGapError`, `OrgMismatchError` and `AgentIdMismatchError` are the
 * last three. Their Python twins are `CryptoError`s, so a catch of `RineError`
 * around a group send, `whoami()` or an agent create holds on both stacks.
 *
 * 🔴 The base-only widening is what keeps this safe. `isRineErrorInstance`
 * answers true for a core-minted refusal when the class asked about IS
 * `RineError`, and never when it is a subclass — otherwise
 * `err instanceof NotFoundError` would be true for a substitution, and
 * narrowing inside the hierarchy would stop meaning anything.
 */

import {
	isAgentIdMismatchError,
	isEscrowGapError,
	isGroupIdentityMismatchError,
	isMlsDowngradeError,
	isMlsInitInFlightError,
	isOrgMismatchError,
	isPrincipalRevokedError,
} from "@rine-network/core";

/** True for a refusal `rine-core` minted, matched on its stable code. */
function isCoreMintedRefusal(value: unknown): boolean {
	return (
		isMlsInitInFlightError(value) ||
		isMlsDowngradeError(value) ||
		isGroupIdentityMismatchError(value) ||
		isEscrowGapError(value) ||
		isOrgMismatchError(value) ||
		isAgentIdMismatchError(value) ||
		isPrincipalRevokedError(value)
	);
}

/** Ordinary `instanceof` semantics: is `ctor.prototype` in `value`'s chain? */
function inheritsFrom(ctor: { prototype: object }, value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.prototype.isPrototypeOf.call(ctor.prototype, value)
	);
}

/**
 * Answer `value instanceof asked` for the `RineError` hierarchy.
 *
 * `asked` is the class the `instanceof` was written against, which is not
 * always `base`: the static that calls this is inherited by every subclass.
 * The `asked === base` guard is what keeps the widening on the base alone —
 * without it `err instanceof NotFoundError` would answer true for a group-send
 * refusal, and narrowing inside the hierarchy would stop meaning anything.
 */
export function isRineErrorInstance(
	base: { prototype: object },
	asked: { prototype: object },
	value: unknown,
): boolean {
	if (inheritsFrom(asked, value)) return true;
	return asked === base && isCoreMintedRefusal(value);
}
