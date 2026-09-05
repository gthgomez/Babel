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
sign_independent_review_receipt(candidate_receipt, ceremony_manifest)
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
- **Expiration policy:** keys carry no mandatory crypto expiry (the verifier
  has none today); policy expiry is procedural — rotate on any suspected
  exposure, at minimum annually, and always when an owner device or token
  holding custody is replaced.

Every registry change is itself a protected-path change and must ride the
TrustRootUpgradeV1 ceremony — rotation therefore also serves as a recurring
live exercise of the ceremony, which keeps break-glass from ever being the
first signing act performed with new custody.

## Canonicalization follow-up (recorded trust concern)

Protected-diff ordering currently depends on runtime sort semantics: the gate
sorts with PowerShell `Sort-Object` (culture-sensitive; pinned to pwsh 7 /
ICU today), while the ceremony tooling and signer sort in Node (UTF-16 code
unit order). These coincide for ASCII-only paths and can diverge for non-ASCII
paths — a real, if narrow, trust concern for digest comparability. The future
protected change should pin **ordinal bytewise UTF-8 path ordering** in all
three implementations (PowerShell gate, Node ceremony tooling, signing
service) with shared canonical test vectors. Do not change #144's trust code
casually for this; it is a deliberate follow-up under TrustRootUpgradeV1.
See the parity note in [TRUST_CEREMONY_LIFECYCLE.md](./TRUST_CEREMONY_LIFECYCLE.md).

## Non-goals

- Builder agents never hold reviewer/supervisor custody, never gain arbitrary
  signing APIs, and never receive raw private keys.
- No replacement keys are generated silently; key creation is always an
  explicit owner action through the signing lane or
  [TRUST_ROOT_RECOVERY.md](./TRUST_ROOT_RECOVERY.md).
