# Scoped integration contract (draft 2.0.0)

Status: unactivated draft. There is no current production consumer of this profile.
The exact-only 2.0.0 cutover is intentional; this document does not qualify the
contract for production use.

## Negotiation

- Contract: `babel.integration`; version: `2.0.0`; schema SHA-256:
  `b2f1f0f7668dc4557367f6ad85b7a54686491108312dc1f6ab8c0c1bd18e1d49`.
- Operations require the exact contract, version, and schema hash headers.
- `1.0.0` and prior draft hashes are denied. There is no fallback, downgrade, or
  major-version guess.
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

Successful registration, renewal, status, and transport bodies are validated
against their existing strict output schemas before emission. A malformed body is
rejected with the fixed sanitized error
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
