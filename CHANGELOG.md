# Changelog

All notable changes to `@rine-network/sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> 🔴 **BREAKING — this release is a MAJOR version bump.** `groups.resolveRef()`
> answers with a different type. The entry below is the change; the version in
> `package.json` is bumped by the release train, not here.

### Changed — 🔴 BREAKING: `groups.resolveRef()` answers with the group, not its id

`groups.resolveRef()` returned the group's UUID. It now returns the group:

```ts
const group = await client.groups.resolveRef("#ops@acme.rine.network");
group.id; // the UUID it used to return, branded
group.handle; // the handle the send path addresses
group.spelling; // the reference you passed, byte for byte
group.row; // the group's record, as groups.get() answers it
```

To migrate a call that wanted the id, read `.id` off the answer:

```diff
- const id = await client.groups.resolveRef(ref);
+ const id = (await client.groups.resolveRef(ref)).id;
```

Reading the reference always cost a request that returned the whole group, and
the id was all of it that survived — so a caller that then acted on the group
paid for the same row again. Hand the answer itself to `removeMember()`,
`leave()`, `sync()` or `resumeMlsAdmission()` and the verb reads no group of its
own. `invite()` and `vote()` accept it too but still read: their read happens
after their own POST, precisely to see what it did, so an earlier row is not a
saving there. Every one of these verbs still takes a plain UUID, so no call site
has to change to keep working.

> 🔴 **The row is spent exactly as you hand it over.** It is as current as the
> `resolveRef()` that produced it, which is the point when the two calls are
> adjacent and a hazard when the record is stored: `enrollment_policy` is
> editable and `mls_group_id` latches once, so a long-lived record can tell
> `removeMember()` that an MLS group runs sender keys — and it will act on that
> and post no Remove commit. A record whose group can no longer be read also
> answers the read, so the degraded-read warning those verbs print on the id
> path never appears. Re-resolve rather than cache, or pass `.id` and buy the
> fresh row.

The two new types are exported: `ResolvedGroup` is what `resolveRef()` answers
with, and `GroupSelector` — `GroupUuid | ResolvedGroup` — is what those six
verbs accept.

`groups.resolveRefForJoin()` is unchanged and still answers a UUID. Its target
is a group this org holds no seat in, so no rung of it has a group record to
answer with.

### Fixed — one `GroupIdentityMismatchError`, so `instanceof` catches both throws

`GroupIdentityMismatchError` was declared twice — once here and once in
`@rine-network/core`, which mints the refusal `groups.resolveRef()` raises. The
two composed the same sentence, so a consumer narrowing with
`catch (e) { if (e instanceof GroupIdentityMismatchError) … }` caught
`groups.get()`'s throw and silently missed `resolveRef()`'s. This package now
re-exports the one class. `instanceof RineError` was already true for both and
stays true; `instanceof` on any other error class is unaffected.

The refusal thrown by `groups.get()` now also carries
`code === GROUP_IDENTITY_MISMATCH_CODE`, so `isGroupIdentityMismatchError()` —
which has always been true for `resolveRef()`'s throw — is now true for that one
too.

### Changed — sending to a group by name costs one request instead of two

`send()` resolved a bare name (`ops`) or a sigiled one (`#ops`) to the group's
handle, then resolved that handle back to the group — so naming a group by
anything other than its whole handle read the group twice. It resolves once
now, through the same recipient contract the CLI and the MCP server use. No
refusal, no message body and no request URL changes; the second
`GET /groups?handle=…` is simply gone.

### Fixed — the MLS-initialising refusal names the group the send addressed

A `send()` to a group whose MLS init has not latched yet is refused with
`MlsInitInFlightError`. When the handle it was given carried an org half that
does not exist — `#board@wrong.example` for a group resolved as
`#board@acme.rine.network` — the refusal quoted the fabrication, naming a group
nobody could look up. It now names the group the message was addressed to,
which is what `err.groupHandle` and `to_handle` already meant and what the same
refusal on the MCP server has always said. A correctly spelled handle, a bare
name and a sigiled name are unaffected.

### Changed — resolving a group by id checks the group that answers

`groups.resolveRef()` reads the group a UUID names before it answers. That read is
now refused when the server replies with a different group, or with a body carrying
no group id at all, and it raises `GroupIdentityMismatchError` — the same error
`groups.get()` has always raised for the same body. A read that is not about the
group it named cannot establish that group's MLS state, so it is not used for one.

An unreadable id is still refused locally with the caller's own roster, and a group
the caller owns but holds no seat in still resolves. A server fault is reported as a
server fault: a 500 on that read fails the call rather than becoming "no such group".

`GroupIdentityMismatchError.answeredGroupId` is now `string | null`. It is `null`
when the answering body carried no id to name. Code that read it as a `string`
needs to handle that.

### Added — `groups.resolveRefForJoin()`

Resolves the reference `groups.join()` takes to a group id, through the ladder a
join needs rather than the one every other group verb uses. `resolveRef()` asks
`GET /groups`, the groups this org is already seated in — the one set a join
cannot be aimed at. This walks that, then this agent's invitations, then the
public directory, matching the whole handle exactly at each rung. A bare name
walks a single rung, this agent's own pending invitations, and is refused when
none of them or more than one of them answers to it; the ambiguous refusal
prints every candidate handle. A UUID costs no round trip.

### Fixed — a group handle written without its `#` resolves

`groups.resolveRef()`, and every verb that resolves a reference through it
including `thread()`, carry the sigil the server stores a group handle with.
`ops@acme.rine.network` resolved to nothing where `#ops@acme.rine.network`
resolved to the group.

### Fixed — a group reference written with a doubled `#` resolves

A reference carrying the sigil twice — `##ops` against an invitation to
`#ops@acme.rine.network` — was refused here and accepted by the Python SDK, so
one join answered differently depending on which stack ran it. Both now read
every leading `#` as the sigil. The match stays bounded to groups that have
already invited this agent, and `#ops@acme.rine.network` and
`##ops@acme.rine.network` remain different handles.

### Added — `groups.create()` sets the vote window

`voteDurationHours` (1–72, default 72) is accepted at create under the same
wire name `update()` already used, so a group whose enrollment policy is
`majority` or `unanimity` no longer has to be created and then amended to
shorten the window its first applicant will wait out.

### Added — a decrypted group row reports the catch-up its read ran

`catch_up` (`GroupCatchUpSchema`: `processed`, `epoch`, `evicted`) is present on
a closed-group message whose read ran a catch-up, including one that found
nothing to apply and reports `processed: 0`. It is absent when no catch-up ran
at all — a 1:1 or open-group row, a re-read served from the memo, or an attempt
the one-minute floor declined or that failed — which is not the claim that this
agent is current. `evicted` is the load-bearing one: the row still opens, and it
is the next send that will be refused. Mirrors the Python SDK's `GroupCatchUp`.

### Changed — a group message whose sender key never arrived says so in words

The `decrypt_error` on that row was rine-core's internal control string
(`unknown sender key id: <uuid>`). It is now the sentence that names what was
refused, what rine already tried, what to ask the sender for, and what is not
coming back. Any other decrypt failure is passed through unchanged.

### Documentation — how a second read of a group message is answered

`messages.read()` now states the mechanism: both group regimes spend a one-time
key at the first decrypt, so a re-read is served from a local cache of the
newest 256 messages per group (≤1 MiB, 0600 in a 0700 directory, deleted when
this agent leaves the group itself — being removed by somebody else deletes
nothing here). It is plaintext at rest, every replay is re-verified against the
sender the server names on the current read, and a replayed row carries no
`catch_up`, because a read answered from the memo applies no commits. There is
no off switch.

## [0.10.0] - 2026-07-25

### Changed — `verified` binds the signature to the sender the server authenticated

A decrypted message is `verified` only when its envelope signature checks out
**and** the signing key it names belongs to the agent the server reports as the
sender. Content signed by a different agent reports the new
`verification_status` value `"sender-mismatch"` with `verified: false`, and a
thread turn in that state renders `"[unavailable]"` like a tampered one. A row
listed without a sender is not decrypted at all: it comes back with
`decrypt_error` set and `verification_status: "unverifiable"`.

**Breaking behaviour change.** A 1:1 message that fails this check is refused,
not reported. Content that 0.9.x returned as readable with `verified: false`
now comes back with no `plaintext` at all and a `decrypt_error` naming the
failure — the shape group messages have always had, and the shape the Python
SDK returns. Both authenticity verdicts behave this way: `"sender-mismatch"`,
and `"invalid"` for a signature that does not check out against the sender's
key. Code that reads `plaintext` without checking `verified` no longer receives
text it cannot attribute; read `verification_status` and `decrypt_error` to
report why a row is closed. `"unverifiable"` is unchanged — it is a transient
outcome rather than a finding against the message, and a row that opened before
the signature check could run still carries its plaintext.

### Added — `sender_kid` on `DecryptedMessage`

The signing key id read off the envelope during verification. On a `verified`
message it is the key of `from_agent_id`, so callers can record the
cryptographic identity behind a turn instead of only the server's account of it.

### Added — `key_changed` on `DecryptedMessage`

A decrypted message reports when the sender's signing key changed between the
cached copy and the key fetched during verification, carrying the agent id and
the previous and current key fingerprints.

### Changed — peer signing keys are cached when verifying, never when sending

Verification reads peer signing keys from a short-lived cache; sending always
fetches a fresh key, so a peer's key rotation is visible to the next send.

## [0.9.0] - 2026-07-23

### Changed — MLS groups move to a new core; existing groups must be recreated

The SDK's group engine is now the native `@rine-network/mls` core (via
`@rine-network/core`) instead of `ts-mls`, and new groups use the post-quantum
X-Wing ciphersuite. The public API is unchanged, but **the old and new cores do
not interoperate — this is a hard cutover.** A group whose members are not all on
the new core does not work; there is no fallback.

- **Every agent's MLS key packages are replaced.** The old published pool is
  unreadable by the new core. An agent carried over from `ts-mls` drains and
  republishes automatically on its next MLS operation (recorded once in
  `keys/<agent>/mls-cutover.json`); `drainAndRepublishMlsKeyPackages()` does it on
  demand for keys copied into a fresh config directory.
- **Every existing MLS group must be recreated.** Old local state under
  `keys/<agent>/mls/` is left inert; the new core stores under
  `keys/<agent>/mls2/`. Sender-key groups and 1:1 messages are unaffected.

## [0.8.1] - 2026-07-21

### Security

- x402 payee reconciliation binds a settlement to the exact quote tier the
  payer names and validates the amount against the signed EIP-3009
  authorization value rather than the payer-echoed `accepted.amount`. A payment
  that overstates the accepted amount above a quoted tier is refused.
- Facilitator requests carry only the standard x402 settlement fields; rine
  message `extensions` are never forwarded to an external facilitator.
- Payments in a token whose on-chain decimals cannot be verified are rejected
  rather than assumed. Facilitator endpoints must be reached over HTTPS.

## [0.3.2] - 2026-06-14

### Added

- `MessageType.Webhook` (`"rine.v1.webhook"`) — the named constant for inbound
  Funnel webhook messages. A relayed external HTTP request arrives in the
  agent's own inbox as a self-addressed message (`from == to`) with the
  cleartext hook name in `metadata["rine.hook_name"]`. Receiving already worked
  (`MessageRead.type` is an open string); this lets consumers filter on the
  constant instead of a literal.

## [0.3.0] - 2026-06-11

### Added

- `client.markDelivered(messageIds, { agent? })` — mark inbox messages as
  delivered (idempotent). Resolves the acting agent internally and returns the
  server's newly-marked count. POSTs `{ message_ids }` to
  `/agents/{agentId}/messages/mark-delivered`. The TS sibling of the Python
  SDK's `mark_delivered`; lets a poller acknowledge messages so a subsequent
  `inbox({ status: "new" })` returns only newer mail.
- `inbox({ status })` filter — `status?: "new" | "delivered" | "read"` on
  `InboxOptions` threads through to `GET /agents/{agentId}/messages?status=…`.
  Omitting `status` sends no query param (back-compat).

### Changed

- Bumped the `zod` dependency floor from `^3.24.0` to `^3.25.0` so a single
  hoisted `zod` satisfies both this SDK and downstream integrations that peer
  `zod >=3.25.0 || >=4.0.0`.

### Fixed

- `createAgent()` now publishes an initial batch of MLS KeyPackages (parity
  with `rine-core`'s agent-creation path). Previously an SDK-created agent had
  no KeyPackages, so any MLS group **invite** of it failed `409 No key packages
  available` — silently breaking MLS group membership for SDK consumers. The
  publish is best-effort: a failure never aborts agent creation (the agent
  still works on sender-key groups and KeyPackages can be republished later).
  Surfaced by the `@rine-network/mastra` live MLS-group e2e.

## [0.1.1] - 2026-04-13

### Fixed

- Corrected `package.json` `repository.url` and `bugs.url` to point at the
  renamed Codeberg repo `rine-typescript-sdk` (was `rine-ts-sdk`, now 404).

## [Unreleased]

### Changed

- **Breaking (runtime)**: `DecryptedMessage.plaintext` is now automatically
  `JSON.parse`d when `content_type` is `application/json` (the default). The
  static type was already `unknown` through the `DecryptedMessage<T>` generic,
  so this is a runtime-only break — callers doing a manual `JSON.parse` on
  `msg.plaintext` should remove that step. For non-JSON content types the
  plaintext is still returned as the raw decrypted string. Malformed JSON
  falls back to the raw string; `decrypt_error` stays null because the
  cryptography succeeded.

### Added

- `client.groups.create({ name, ... })` options-bag overload. The positional
  `create(name, opts)` form still works.
- `client.inspect(handle)` now resolves agent handles via WebFinger (UUIDs
  still pass through untouched).
- `defineAgent({ ... })` auto-starts by default. Pass `autoStart: false` to
  restore the explicit-`start()` discipline tests rely on.
- `client.conversation(msg)` overload that pre-wires the peer from a
  decrypted message; `scope.send(payload)` then sends to the same peer
  without a recipient argument. The existing `client.conversation(id)`
  overload still works (and still throws a clear error when `send` is
  called without an explicit recipient).

### Fixed

- `whoami()` now accepts `warnings: null` on agent records (server emits
  this verbatim; the previous schema rejected it).
- `reply()` no longer fails with "agent not owned by current org" when the
  original message's `to_agent_id` belongs to the peer. The fallback chain
  now skips foreign `to_agent_id` hints and falls through to the caller's
  default agent, surfacing the clearer "cannot reply to your own message"
  guard when applicable.
- `discover()` / `groups.list()` / any `CursorPage`-returning call now
  report the server's real total count. The paginated-response schema
  was expecting a `total` field but the server ships `total_estimate`;
  both are now accepted, with `total_estimate` preferred.
- `AsyncRineClient({ timeout })` now surfaces `RineTimeoutError` when the
  per-op timer fires, instead of leaking a generic `AbortError`.
  `anySignal()` was dropping the firing input's `reason` during signal
  composition, which erased the `RineTimeoutError` the op-timer attached.

### Docs

- `client.messages()` JSDoc now explicitly states that abort exits the
  iterator silently — check `signal.aborted` after the `for await` loop
  to distinguish cancellation from natural end.

## [0.1.0] - 2026-04-11

Initial public release of the TypeScript SDK for Rine E2E-encrypted messaging.

### Added
- `AsyncRineClient` — async-only client covering the full Rine API surface:
  messaging, identity, groups, discovery, and webhooks.
- End-to-end encryption wired through `send`, `reply`, `sendAndWait`, `inbox`,
  `read`, `messages`, and `stream` by bridging to `@rine-network/core`
  (HPKE for 1:1, Sender Keys for groups).
- Agentic layer: `defineAgent({ client, onMessage, onError, ... })` actor loop
  with `start` / `stop` / `[Symbol.asyncDispose]` lifecycle and per-message
  error isolation.
- `client.messages()` — `AsyncIterable<DecryptedMessage>` stream that filters,
  fetches, and decrypts inbound events end-to-end.
- `client.conversation(convId)` scoped builder with `send`, `reply`, `messages`,
  and `history` methods.
- Typed payload generics: `send<T>`, `reply<T>`, `read<T>`, `conversation(id).send<T>`,
  and `defineAgent<T>` with Standard Schema v1 parse slots.
- Middleware stack: `RineMiddleware` functional chain composed around every
  `SDKHttpClient.request()` call, plus a built-in `loggingMiddleware`.
- SSE stream fixes: `Bearer` auth header, blank-line dispatch, disconnect
  event, seen-id dedup bounded to the last 500 messages, `Last-Event-ID`
  resume with capped exponential backoff.
- `AbortSignal` support across every resource and the rine-core HTTP bridge.
- Regression test suite covering SSE, cancellation, crypto interop
  (round-trip DM and group), and Standard Schema wiring.
- Runnable examples: `defineAgent-quickstart`, `messages-loop`, `group-send`,
  `conversation-turntaking`, `typed-task`, `vercel-ai-interop`.
- README with install, 30-second quickstart, and compatibility notes.

### Removed
- `SyncRineClient` and the worker-thread sync shim — Node 22+ ESM only.

### Notes
- Requires Node 22+.
- ESM only.
