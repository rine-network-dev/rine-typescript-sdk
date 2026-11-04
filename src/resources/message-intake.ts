/**
 * The per-envelope step of `client.messages()` that decides what is consumed.
 *
 * The stream runs in peek mode, so nothing is marked delivered as it is sent.
 * A row is acknowledged here, in batches, only when the caller is finished
 * with it: a sender-key distribution the iterator hides, or a row that
 * settled once decrypted. Mail the caller chose not to read here (another
 * `type`, another conversation) is skipped before decrypt and stays new for
 * whoever does read it.
 */
import {
	type AckBatcher,
	type HttpClient,
	ackFailureNotice,
	createAckBatcher,
	markDeliveredAs,
} from "@rine-network/core";
import { RESERVED_MESSAGE_TYPES } from "../types.js";
import type { ParsedDecryptedMessage } from "./decrypt.js";
import { isSettled } from "./settled.js";

export interface MessageIntakeOptions {
	/** The client the acks go through. Built without the caller's signal. */
	core: HttpClient;
	agentId: string;
	type?: string | readonly string[];
	includeReserved?: boolean;
	/** Only rows of this conversation are read; others stay new. */
	conversationId?: string;
}

export interface MessageIntake {
	readonly acks: AckBatcher;
	/**
	 * Whether the iterator passes over this envelope without decrypting it.
	 * A hidden sender-key distribution is acknowledged; a row outside the
	 * `type` filter or the conversation is not.
	 */
	skips(envelope: Pick<ParsedDecryptedMessage, "id" | "type" | "conversation_id">): boolean;
	/** Queue the ack of a decrypted row when it settled. */
	settle(decrypted: Parameters<typeof isSettled>[0] & { id: string }): void;
}

export function createMessageIntake({
	core,
	agentId,
	type,
	includeReserved,
	conversationId,
}: MessageIntakeOptions): MessageIntake {
	const filterTypes = normalizeTypeFilter(type);
	const acks = createAckBatcher({
		ack: (ids) => markDeliveredAs(core, agentId, ids),
		onError: (count, err) => console.warn(ackFailureNotice(count, err)),
	});
	return {
		acks,
		skips(envelope) {
			if (!includeReserved && RESERVED_MESSAGE_TYPES.has(envelope.type)) {
				// Protocol plumbing (`rine.v1.sender_key_distribution`, key material
				// nothing ingests off the stream). `decryptEnvelope({ retrySenderKey })`
				// and the recovery scan read distributions from every status, so
				// marking one delivered loses no key material.
				acks.add(envelope.id);
				return true;
			}
			if (filterTypes && !filterTypes.has(envelope.type)) return true;
			return (
				conversationId !== undefined &&
				envelope.conversation_id !== conversationId
			);
		},
		settle(decrypted) {
			if (isSettled(decrypted)) acks.add(decrypted.id);
		},
	};
}

/**
 * Normalise the public `type` option to a lookup set. An empty array means
 * "no filter", not "match nothing".
 */
function normalizeTypeFilter(
	filter: string | readonly string[] | undefined,
): ReadonlySet<string> | undefined {
	if (filter === undefined) return undefined;
	if (typeof filter === "string") return new Set([filter]);
	if (filter.length === 0) return undefined;
	return new Set(filter);
}
