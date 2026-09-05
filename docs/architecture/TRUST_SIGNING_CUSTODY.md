# Trust Signing Custody

<!--
status: ACTIVE
last_verified: 2026-09-05
-->

Canonical design for how trust-root signing authority is held, used, and
rotated. Companions:

- [TRUST_CEREMONY_LIFECYCLE.md](./TRUST_CEREMONY_LIFECYCLE.md) — ceremony state
  machine and target-branch binding invariants;
- [TRUST_ROOT_UPGRADE.md](./TRUST_ROOT_UPGRADE.md) — TrustRootUpgradeV1
  protocol and authorization schema;
- [TRUST_ROOT_RECOVERY.md](./TRUST_ROOT_RECOVERY.md) — break-glass rekey
  protocol when authority is lost or compromised.

Core invariants:

> **Private authority may be usable by Babel, but it must never become
> readable by Babel's builder agents.**

> **A key that cannot be lost is a key that was never created; every custody
> design must ship with its recovery story.**

## Current custody state (2026-09-05 audit)

Registered public authorities (public registries on `main`; the registry
files are the authoritative source of the exact public key material):

| Role | Key ID | Registry |
| --- | --- | --- |
| Independent reviewer | `trusted-reviewer-ed25519-v2` | `config/independent-review-keys.json` |
| Supervisor | `trusted-supervisor-ed25519-v1` | `config/trusted-supervisor-keys.json` |

Custody classification for both private authorities: **UNKNOWN** (leaning
unprovisioned). Evidence, from the 2026-09-05 audit:

| Check | Result |
| --- | --- |
| Configured signing service (`BABEL_REVIEW_PROVENANCE_SIGNER`, `BABEL_TRUSTED_REVIEW_ISSUER`, `BABEL_TRUSTED_REVIEW_VERIFIER`) in process, user, and machine scope | all UNSET |
| CI signing secret or environment | none configured (only unrelated metadata-policy secret exists) |
| Signed ceremony artifact ever transported (receipt / authorization comments) | none on any PR |
| Campaign records | signed-review operations recorded PENDING; signed tier recorded `ISSUER_CONFIGURATION_REQUIRED` |
| Key-generation tooling or ceremony record in history | none |
| Private material readable in builder context (standard locations) | none found |

**Interpretation discipline:** the builder's search scope is inherently
bounded — "not found by the builder" cannot be promoted to "lost." The owner
may hold valid keys in an offline location the builder cannot observe. Only
the owner can resolve UNKNOWN to AVAILABLE (produce and use the key) or to
LOST (declare and run recovery). No replacement keys may be generated
automatically; replacement authority changes trust ownership.

Architectural boundary that already exists (code level): authority
construction is confined to a trusted-service-only module
(`babel-cli/src/services/reviewTrustedAuthority.ts`), enforced by
`reviewCustody.test.ts`; the builder-facing issuer accepts an authority
implementation but never key material. This is a *test-enforced* boundary, not
an OS boundary — see the threat model below.

## Custody classification vocabulary

Campaign discipline (do not skip states, do not invent knowledge):

- `CUSTODY_DECISION_REQUIRED` — the campaign-level state while the owner has
  not resolved custody. Used **instead of** `OWNER_UNLOCK_REQUIRED` whenever
  no evidence establishes that an authority exists and merely needs
  unlocking: unknown stays unknown until evidence changes it.
- Custody statuses: `AUTHORITY_AVAILABLE`, `AUTHORITY_LOST`,
  `AUTHORITY_NEVER_PROVISIONED`, `AUTHORITY_STATUS_UNKNOWN`. Current status
  for both registered keys: **`AUTHORITY_STATUS_UNKNOWN`** (leaning
  unprovisioned; see the audit table above).
- `LEGACY_UNPROVEN_AUTHORITY` — a public key registered **before** the
  proof-of-possession mechanism existed. No valid proof-of-possession history
  exists for either registered key (bootstrap-history audit, 2026-09-05), so
  both keys are classified `LEGACY_UNPROVEN_AUTHORITY` for recovery planning:
  they are **not** silently grandfathered as fully provisioned authorities.
  Resolution requires either an owner proof-of-possession ceremony (below) or
  recovery.

Bootstrap history (Phase 12 audit): reviewer proof-of-possession history =
`NOT_FOUND`; supervisor proof-of-possession history = `NOT_FOUND`. The
reviewer key was silently re-keyed v1→v2 the same day it was introduced; no
possession ceremony, challenge record, or custody-completion artifact exists
anywhere in history, and the bootstrap documentation itself states private
counterparts still required owner provisioning after the public keys merged.

## Authority lifecycle states

A committed public key is **not** proof that a usable private authority
exists. Registries may carry per-key lifecycle metadata (schema v2 draft —
activates only when an actual activation/recovery writes it; today's
registries stay schema v1 with `LEGACY_UNPROVEN_AUTHORITY` semantics):

```text
PROPOSED                    public material drafted, not yet registered
PROOF_OF_POSSESSION_PENDING challenge issued, signed proof not yet verified
PROVEN                      valid signed proof-of-possession verified
ACTIVE                      proven + custody established + end-to-end exercise
                            completed; may sign artifacts
ROTATING                    replacement in flight; old key still valid
RETIRED                     deliberately withdrawn by the owner
REVOKED                     withdrawn due to compromise or loss
RECOVERY_REQUIRED           key lost/never provisioned; break-glass lane
```

Only `ACTIVE` (or `ROTATING` per rotation policy) keys may be treated as
usable trusted authorities. Gate enforcement of lifecycle metadata is a
deliberate follow-up: it lands together with the owner custody decision, in
the same TrustRootUpgradeV1 change that writes lifecycle metadata — enabling
it now would invalidate the `LEGACY_UNPROVEN_AUTHORITY` keys before a usable
replacement exists.

## Proof-of-possession (authority activation invariant)

New reviewer/supervisor public keys become authorities only through:

```text
repository generates challenge (tools/trust-ceremony.mjs activation-challenge)
        ↓ candidate private authority signs the canonical challenge JSON
        ↓ scripts/verify-authority-activation.mjs validates against the
          proposed public key
        ↓ key becomes PROVEN (and ACTIVE after custody + live exercise)
```

The private key is never exposed to the repository or the builder. The
challenge binds `repository`, `role`, `key_id`, `challenge_id`, a 256-bit
`nonce`, `issued_at`, `expires_at`, and `purpose=authority_activation`; the
signature covers exactly that canonical challenge document, so arbitrary
bytes can never be signed into an activation proof. The verifier rejects —
deterministically, never by crashing — expired challenges, wrong repository,
wrong key, wrong role, replayed `challenge_id` (via the consumed-challenges
ledger), malformed signatures, and key-id mismatches. Regression matrix:
`tools/tests/test-authority-activation.mjs` (includes the RFC 8032
deterministic vector as a canonicalization canary).

## Threat model

For each signing authority:

| Question | Design answer |
| --- | --- |
| Who can invoke signing? | Only the owner trust service, after owner approval, for schema-constrained artifacts |
| Who can read private material? | Only the service process holding it; never builder agents, never the builder user account in the ideal state |
| Same Windows account as coding agents? | Must be NO in the ideal state; a key readable by the agent user is `AVAILABLE_WEAK_CUSTODY`, not secure |
| Exportable? | No — the ideal state uses non-exportable credentials (hardware or TPM) |
| Arbitrary-message signing? | Forbidden — the service signs only exact ceremony artifact schemas |
| User presence required? | Yes for supervisor authorizations (owner approval per act); near-term via interactive approval, ideal via hardware-token touch + PIN |
| Audit logging? | Metadata-only, append-only (see below) |
| Builder can request only schema-constrained artifacts? | Yes — the service validates the full ceremony binding itself and fails closed |
| Can malware as the builder user steal the key? | In the ideal state: no (separate account / hardware boundary); in the near-term: the service account + DPAPI boundary reduces but does not eliminate this — treated honestly as a residual risk |

Explicit same-account warning: a private key stored elsewhere on disk but
readable by the same Windows user that runs autonomous agents is **not
meaningfully isolated**. Living outside `C:\Workspace` is not a control. If
the same user context can read it, the honest classification is
`AVAILABLE_WEAK_CUSTODY` unless another control (ACL-different account,
hardware boundary, DPAPI under a different principal, per-act owner presence)
meaningfully protects it.

## Owner signing lane

```text
Builder agents
   |
   |  unsigned exact ceremony manifest (machine-generated coordinates:
   |  repository, PR, base_ref, base_sha, target_ref_head_sha,
   |  merge_base_sha, head_sha, protected paths + digests)
   v
Owner Trust Service  (small, local, allowlisted interface)
   |
   +-- re-validate current-main binding (base_ref == main;
   |   base_sha == live refs/heads/main; target head is ancestor
   |   of candidate) — the service MUST independently re-run the
   |   ceremony preflight checks, not trust the caller
   +-- validate manifest freshness (generated_at/expires_at)
   +-- validate schema + recomputed protected digest
   +-- require interactive owner approval for each signing act
   |
   +-- Reviewer Authority  -> sign_independent_review_receipt(...)
   +-- Supervisor Authority -> authorize_trust_root_upgrade(...)
   |
   v
Signed artifacts only  (transported as PR comments; base-rooted
                        gate verifies against the base-rooted registries)
```

The builder never receives raw private keys; it receives signed artifacts.

## Signing service requirements

Narrow interface — allowed operations:

```text
prove_authority_possession(challenge, ceremony_manifest)
issue_review_receipt(candidate_receipt, ceremony_manifest)
authorize_trust_root_upgrade(authorization, ceremony_manifest)
```

Forbidden operations:

```text
get_private_key()          export_private_key()
sign_arbitrary_bytes()     run_arbitrary_command()
```

Every operation independently validates, fail-closed:

1. repository allowlist;
2. PR number and PR state (OPEN);
3. PR base ref == the protected target ref (`main`);
4. current target branch head == manifest `target_ref_head_sha` (live re-fetch);
5. recorded base == live target head and target head is an ancestor of the
   candidate (ancestry re-verified, not asserted);
6. manifest freshness (not expired, within policy age);
7. exact protected path set + recomputed protected diff digest;
8. artifact schema conformance (exact field sets of
   `independent_review_receipt_v1`/v2 and
   `trust_root_upgrade_authorization_v1`);
9. expected reviewer ≠ builder identities;
10. artifact expiry windows and authorization intent
    (`intent: "trust_root_upgrade"`,
    `decision: "AUTHORIZE_TRUST_ROOT_UPGRADE"`).

Any validation failure: refuse, log metadata, emit no artifact.

## Reviewer and supervisor separation

The two roles stay separate authorities — different Ed25519 keys and
different authorization operations, never one undifferentiated signing
endpoint:

- **Reviewer Authority** certifies independent review
  (receipts, supervisor-signed challenges);
- **Supervisor Authority** authorizes trust-root mutation.

Both may live in one hardened service process as separate non-exportable
keys, but the ideal state separates the *custody boundary* too: reviewer key
in the local service, supervisor key hardware-backed (owner presence per
authorization). Separate OS accounts are an optional hardening when the
service model grows beyond one owner.

## Deployment options (single-owner Windows environment)

| Option | Security | Setup complexity | Agent usability | Disaster recovery | Secret isolation | Operator friction |
| --- | --- | --- | --- | --- | --- | --- |
| A — encrypted offline signer (key on encrypted removable media, mounted only to sign) | High | Low | Low (manual mount per act) | Medium (media loss → recovery flow) | High (offline when not in use) | High |
| B — separate Windows service account (keys under another local profile, ACL-isolated) | Medium | Medium | Medium | Medium | Medium (same-machine admin compromise defeats it) | Medium |
| C — protected local service + owner approval (per-act interactive consent, DPAPI under a service principal) | Medium-High | Medium | High | Medium | Medium-High | Medium |
| D — GitHub protected-environment signer (Actions environment secret + required reviewers) | Medium | Low | High | Medium (GitHub account = key custody) | Medium (GitHub-side secret store) | Low |
| E — hardware-backed signer (YubiKey PIV Ed25519 / TPM 2.0 non-exportable) | High | Medium | Medium | High (well-understood token-loss rotation) | High (non-exportable) | Medium (touch+PIN per act) |

**Near-term recommendation: Option C** — a minimal local signing service
holding the two keys under a dedicated, least-privilege Windows account
(DPAPI-protected at rest), exposing only the two schema-constrained
operations, requiring interactive owner approval per signing act, and writing
metadata-only audit logs. It closes the configured-service gap that keeps the
signed tier at `ISSUER_CONFIGURATION_REQUIRED`, works entirely on the current
single-owner machine, and imposes no cloud dependency.

**Ideal-state recommendation: Option E** — supervisor key hardware-backed
(owner touch + PIN per trust-root authorization), reviewer key TPM-resident
or in the Option C service. Combined with the rotation protocol below, this
minimizes both the compromise window and the recovery blast radius.

Options A and D are acceptable fallbacks; A is the fallback when no always-on
service is wanted, D when the owner wants GitHub to hold the custody burden —
with the explicit caveat that in D, GitHub account compromise equals signing
authority compromise.

## Audit logging

The signer records metadata only — never key material, never artifact
secrets:

```text
request_id, key_id, artifact_kind, repository, pr_number,
base_sha, target_ref_head_sha, candidate_head_sha, digest,
issued_at, expires_at, decision
```

Append-only storage (JSON-lines with hash-chained records is sufficient at
this scale); tamper-evidence by chaining, not by hiding.

## Key rotation protocol

Routine rotation happens **before** keys are lost. The registries are maps of
key ID → public key, so multiple keys can coexist natively:

```text
old key valid + new key introduced
  → overlap window (both verify; only new key signs new artifacts)
  → new key exercised successfully (one full challenge+receipt /
    authorization cycle)
  → old key retired (removed from registry)
```

- **Reviewer rotation:** new reviewer key via the owner signing lane; add to
  `config/independent-review-keys.json` through an ordinary protected-path PR
  (TrustRootUpgradeV1 ceremony with the *current* keys); exercise; retire old.
- **Supervisor rotation:** same shape; the authorization that *adds* the new
  supervisor key is signed by the current supervisor key.
- **Compromise rotation:** no overlap window — immediately retire the
  compromised key, add the replacement, file the incident report, and
  re-certify any trust state resting on artifacts signed by the compromised
  key.
- **Expiration policy:** keys carry no mandatory crypto expiry at the key
  level (the registry has none; the verifiers do enforce per-artifact
  `expires_at`); policy expiry is procedural — rotate on any suspected
  exposure, at minimum annually, and always when an owner device or token
  holding custody is replaced.

Every registry change is itself a protected-path change and must ride the
TrustRootUpgradeV1 ceremony — rotation therefore also serves as a recurring
live exercise of the ceremony, which keeps break-glass from ever being the
first signing act performed with new custody.

## Canonicalization (resolved)

Resolved in the PR-C trust change (PR #144): protected-diff and numstat
ordering is pinned to **ordinal bytewise UTF-8** in all three implementations
(PowerShell gate `Get-AgentCanonicalOrderUtf8`, Node ceremony tooling
`compareUtf8`, upgrade verifier `compareUtf8`), with shared canonical test
vectors in `tools/tests/fixtures/canonical-ordering-vectors.json`. The
signing service must adopt the same comparison when recomputing digests; the
shared vectors are its acceptance test. See
[TRUST_ROOT_UPGRADE.md — Canonical ordering](./TRUST_ROOT_UPGRADE.md#canonical-ordering-ordinal-bytewise-utf8).

## Non-goals

- Builder agents never hold reviewer/supervisor custody, never gain arbitrary
  signing APIs, and never receive raw private keys.
- No replacement keys are generated silently; key creation is always an
  explicit owner action through the signing lane or
  [TRUST_ROOT_RECOVERY.md](./TRUST_ROOT_RECOVERY.md).
