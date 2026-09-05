# Trust Ceremony Lifecycle

<!--
status: ACTIVE
last_verified: 2026-09-05
-->

Canonical mental model for trust-root changes. A trust-root authorization is
valid only for the exact artifact reviewed — any candidate mutation after the
head is frozen invalidates every downstream artifact.

## State machine

```text
ENGINEERING
  ↓ implementation complete; ordinary CI terminal; no pending changes
HEAD_FROZEN
  ↓ exact-head independent engineering review complete (assurance, not authority)
REVIEWED
  ↓ machine-generated ceremony manifest (tools/trust-ceremony.mjs generate)
MANIFEST_GENERATED
  ↓ preflight re-fetches GitHub and compares every binding (tools/trust-ceremony.mjs preflight)
PREFLIGHT_VALID
  ↓ authorized independent reviewer signs a CERTIFIED receipt for the exact candidate
CERTIFIED_RECEIPT_ISSUED
  ↓ supervisor signs TrustRootUpgradeV1 authorization bound to the manifest coordinates
SUPERVISOR_AUTHORIZED
  ↓ artifacts transported via PR comment; base-rooted gate re-evaluates
GATE_GREEN
  ↓ final live coordinate check immediately before merge
FINAL_COORDINATE_CHECK
  ↓ merge
MERGED
  ↓ post-merge behavior proven on the new main (missing evidence → clean BLOCKED;
  ↓ evidence comment → automatic gate re-evaluation)
POST_MERGE_VERIFIED
```

## Invalidation rules

| Event | Effect |
| --- | --- |
| Any candidate source change after `HEAD_FROZEN` | lifecycle returns to `ENGINEERING`; prior review evidence, manifest, and any signatures become invalid |
| Base (`main`) movement after `MANIFEST_GENERATED` | `HEAD_FROZEN` / `REBASE_REQUIRED`; rebase, rerun checks, redo exact-head review, regenerate manifest and all signatures |
| Protected path set or protected diff digest change | manifest stale (`protected_path_set_changed` / `protected_diff_changed`); all signatures invalid |
| PR close/reopen, head force-push, PR number or repository change | manifest stale; regenerate |
| Manifest expiry (24h freshness) | regenerate; do not sign from a stale manifest |

## Tooling

- `node tools/trust-ceremony.mjs generate --repository <repo> --pr <n> [--out FILE]` —
  derive the complete coordinate set from live GitHub state + exact diff +
  the base-rooted gate's protected-path list.
- `node tools/trust-ceremony.mjs preflight --manifest FILE --repository <repo> --pr <n>` —
  immediately before signing; must print `TRUST_ROOT_PREFLIGHT=PASS`.
- `node tools/trust-ceremony.mjs validate-staleness --manifest FILE` —
  fail closed with precise reasons (`STALE_TRUST_ROOT_CEREMONY`), e.g.
  `head_sha_changed`, `base_sha_changed`, `protected_path_set_changed`,
  `protected_diff_changed`, `pr_number_changed`, `repository_mismatch`,
  `manifest_expired`.
- `node tools/trust-ceremony.mjs body-section --manifest FILE` — render the
  marker-delimited PR-body ceremony block
  (`<!-- babel-trust-root-ceremony-generated -->`). PR bodies must never carry
  hand-maintained SHA/digest ceremony values outside that generated block.

Digest semantics replicate the base-rooted gate exactly
(`Get-AgentProtectedDiffDigest`, `Get-AgentNumstatDigest`), so the manifest's
`protected_diff_digest` is byte-comparable with what the gate verifies.

## Review tiers (assurance language)

- **Candidate engineering review** — useful assurance from any reviewer; never
  trusted authorization, never a substitute for a signed receipt.
- **AUTONOMOUS review** — mechanically bound evidence (`autonomous_review_evidence_v1`)
  accepted under ordinary-PR policy; process-isolation properties are asserted
  by policy, not cryptographically proven.
- **CERTIFIED review** — cryptographically authorized independent review using
  trusted custody (registered reviewer key + supervisor-signed challenge).
- **TrustRootUpgradeV1** — CERTIFIED review **plus** supervisor authorization,
  required for any protected trust-root change.

Never describe an "isolated AI reviewer" as cryptographically proven unless the
isolation itself is attested and signed.
