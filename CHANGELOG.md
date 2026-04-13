# Changelog

All notable changes to `@rine-network/sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
