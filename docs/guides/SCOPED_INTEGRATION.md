# Scoped integration contract (draft 2.0.0)

Status: unactivated draft. There is no current production consumer of this profile.
The exact-only 2.0.0 cutover is intentional; this document does not qualify the
contract for production use.

## Negotiation

- Contract: `babel.integration`; version: `2.0.0`; schema SHA-256:
  `a0a5f8d89701055bd4b2b4934a22490d4c1051f62c5e93632cb2e30b15003e36`.
- Operations require the exact contract, version, and schema hash headers.
- `1.0.0` and prior draft hashes (including
  `b2f1f0f7668dc4557367f6ad85b7a54686491108312dc1f6ab8c0c1bd18e1d49`) are
  denied. There is no fallback, downgrade, or major-version guess. A companion
  must use the exact hash above.
- Migration for this unactivated draft requires no data rewrite and no client
  activation; native thread identities are unchanged.
- Capability advertisements remain gated exactly as before; this draft adds no
  capability activation. Integration credentials still cannot reach `/rpc`.

## Cutover and legacy state

- A required `/renew` body change is breaking; deploy the companion client
  upgrade with the gateway.
- A legacy principal without verifiable provenance must be freshly registered or
  requalified under 2.0.0. Do not destructively delete rows or attempt a live
  rewrite of legacy credentials.
- There is no supported live downgrade to the v4 writer. Schema triggers reject
  credential issuance/rotation that is not backed by a durable issuance row;
  reopening with v5 restores the version and replay state.
- Still-recorded v4 IDs (initial registration and last renewal) are reserved as
  tombstones. Older v4 history that was already discarded is not reconstructed.
- Prior free-form renewal labels remain retained as tombstones. New renewal IDs
  use the disjoint canonical namespace below.

## Legacy `workspace.changes`

The existing remote `workspace.changes` JSON-RPC method is a legacy host-side
Git inspection, not a scoped integration route. It reports only tracked changes
(staged and unstaged); untracked files are always omitted, and its `reason`
states that limitation even when there are no tracked edits. It must not be
read as a complete or clean workspace snapshot. The scoped integration surface
listed in this draft still does not expose `workspace.changes`.

## Endpoints

### Initial registration — `POST /integrations/acp-sessions`

Returns `201` with a credential. An exact, current, unexpired replay returns the
same credential, generation, and expiry. Initial replay never rotates. Conflicting
intent, revocation, expiry, and reserved/superseded state fail without a credential.

### Renewal — `POST /integrations/acp-sessions/:principalId/renew`

Returns `200` with a credential.

- `request_id` must be canonical: `renewal:<principal-uuid>:<sequence>`.
- `request_sequence` is monotonic per principal and must advance the durable
  high-water mark.
- `expected_registration_generation` must equal the observed generation.
- Exact replay is available only for the retained current issuance.
- Stale, retired, conflicting, expired, revoked, or cross-principal/sequence
  labels never rotate.

### Status / reconciliation — `POST /integrations/acp-sessions/:principalId/status`

Parent-authenticated, exact-profile, project/launch-bound, read-only. It returns
no credential and performs no rotation. It reconciles renewals only; it is not an
initial-registration replay channel.

`disposition` is one of:

- `issued`: the retained current renewal issuance is unexpired.
- `superseded`: a retained older generation.
- `expired`: the retained current renewal issuance is past expiry.
- `revoked`.
- `reserved`: a retained legacy/v4 tombstone.
- `retired`: the sequence is at or below the durable high-water mark with no
  retained matching row. It may have been skipped or its row may have been
  pruned. Either way, it cannot rotate again.
- `not_issued`: no renewal is visible for the supplied label in this scope.
  For a canonical label with an unused sequence above the durable high-water
  mark, no issuance had committed at the time of the read. This is not an
  answer about initial registrations or another scope.

The reply also carries `renewal_sequence` (the current high-water mark) and
`host_instance_id` (the serving incarnation). A restarted client can use the
next sequence above that mark for a new renewal after it has reconciled the
pending request. It must stop if there is no next safe integer; do not jump
sequences during normal operation.

### Transport — `POST /sessions`

Returns `201`. The response is validated against the strict transport schema
before emission.

## JSON-RPC envelopes, authority, and replay

- HTTP status and the JSON-RPC envelope are distinct. Authentication,
  negotiation, payload, availability, response-validation, and transport
  failures are non-200 JSON errors; they can occur after authentication and
  negotiation as well. A non-200 reply after admission does not establish that
  the native effect was skipped. Once a `/rpc` request is authenticated and
  negotiated, a successful HTTP response is `200` and the body is a strict
  JSON-RPC 2.0 envelope validated against the negotiated RPC response schema
  before emission.
  A malformed internal envelope becomes the fixed sanitized `500` transport
  error, not a partial success.
- Authority is unchanged: execution owner is `protocol_host`, `native_only` is
  true, and turns remain lease-gated. This surface accepts no prompt, provider,
  model, adapter, or execution-profile input.
- `thread.create` requires `id === params.command_id`. A mismatch returns a `200`
  JSON-RPC error with `command_fingerprint_conflict` and admits no effect.
- Capability gates: `transport.create` requires a registry; `command.lookup`
  requires a registry and a command journal; `thread.create` additionally
  requires the native gateway and explicit `enableNativeThreadCreate`. This draft
  activates no new effect or active profile.
- `command.lookup` is read-only. It returns the durable admission record
  (`admitted`, `settled`, or `unknown`); a missing record is reported as
  `unknown` with `no_admission_record`.
- Native thread IDs are validated exactly as the canonical allocator produces
  them: `chat-` followed by exactly 12 lowercase hexadecimal characters. There
  is no UUID projection, generic-string fallback, or second identity. An invalid
  ID is rejected by the strict output emitter with the sanitized `500` error.
- The current scoped surface only creates/looks up IDs from that allocator.
  Fork APIs accept caller-supplied IDs outside this draft; exposing forks or
  saved threads here would require extending the validator by contract decision.
- Before journal settlement, a native create success must satisfy the full
  strict integration success envelope and bind `jsonrpc: "2.0"`,
  `id === command_id`, and exactly `result.thread_id ===` the reserved canonical
  planned native ID. Extra, malformed, or ambiguous results are marked `unknown`
  and return `reconcile_required`; they are never settled, replayed, retried, or
  treated as proof that no effect occurred.
- Once a command has been admitted, a lost or ambiguous reply does **not** mean
  “not dispatched.” The effect may have committed. Do not retry the effect;
  reconcile with `command.lookup`. A settled record may replay its durable
  response without dispatch only after the stored envelope passes the same
  strict binding; admitted/unknown records and malformed settled rows are never
  replayed automatically.

## Journal ownership and lifecycle

- A journal passed directly is borrowed. The TLS server never closes it.
- A journal created by a factory is owned by the TLS server: it is created when
  listening is attempted, closed on listen failure, and closed after terminal
  shutdown once admitted handlers have settled. A never-started server creates
  no factory journal.
- A same-instance `close()` followed by `listen()` reacquires a factory-owned
  journal. Callers must serialize **all** start/stop cycles, including
  `listen()`/`close()`, with no overlap on the same instance; `listen()` while
  already listening is idempotent, and `close()` without a running listener is
  safe.
- On a failed listen, owned-journal cleanup is best effort. A cleanup error must
  not mask the listen failure; the caller should treat the store as requiring
  process-level cleanup rather than assume the journal is closed.
- Terminal close drains admitted handlers indefinitely before closing the store.
  This indefinite drain is explicitly **unqualified for activation**; do not
  claim completion or bound it by closing a journal under an active handler. An
  external supervisor may terminate the process, but must not close the store
  underneath a live admission.

## Durable IDs and bounded storage

- The durable renewal identity is `(principal, request_sequence)`, encoded in
  the canonical `request_id`. The expected generation is part of the intent
  bound to that identity, not a way to reuse it.
- The principal generation rejects delayed messages from older generations.
- At most `ACP_SESSION_RENEWAL_HISTORY` renewal rows are retained per principal;
  the registration row and legacy tombstones are retained. Storage is
  O(principals), not O(renewals), and there is no lifetime issuance cap.
- Retired sequences are unusable without unbounded tombstones. Pruned rows are
  never reissued and are reported as `retired`, not `not_issued`.

## Expiry and serving incarnation semantics

- Boot identity is random per gateway start; prior session credentials do not
  authenticate after a restart.
- Status names the serving incarnation, not the principal's stale stored host.
- Status reports the current principal row's expiry, not the expiry of a
  superseded credential. `issued` describes the stored renewal, not whether a
  credential issued by an earlier host can authenticate to the current host.
- Live credential and transport expiry values are strictly positive. Status may
  report `expires_at_ms: 0` only as the documented sentinel for a legacy row
  disabled by pre-expiry migration.
- Expired or revoked status replies still carry no credential.

## Output validation and credential safety

Successful registration, renewal, status, transport, and every HTTP `200` `/rpc`
JSON-RPC envelope are validated against their existing strict output schemas
before emission. A malformed body is rejected with the fixed sanitized error
`integration_response_contract_violation`; the invalid body and schema
diagnostics are neither logged nor returned. A credential is only returned in a
successful credential response, and never written to logs or diagnostics.

## Verification

Run from the repository root:

```powershell
npm --prefix babel-cli run typecheck
```

Focused integration and registry tests are colocated in
`babel-cli/src/bridge/integrationRegistry.test.ts`,
`babel-cli/src/bridge/integrationContract.test.ts`, and
`babel-cli/src/bridge/integrationTls.test.ts`. TLS tests require OpenSSL for a
synthetic loopback identity and fail closed if it is unavailable.
