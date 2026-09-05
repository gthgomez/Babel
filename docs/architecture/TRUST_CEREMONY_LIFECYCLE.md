# Trust Ceremony Lifecycle

<!--
status: ACTIVE
last_verified: 2026-09-05
-->

Canonical mental model for trust-root changes. A trust-root authorization is
valid only for the exact artifact reviewed — any candidate mutation after the
head is frozen invalidates every downstream artifact. Since ceremony manifest
schema v2, the authorization is bound not only to the candidate but also to
the **live merge target**: a frozen PR is not a frozen world.

## State machine

```text
ENGINEERING
  ↓ implementation complete; ordinary CI terminal; no pending changes
HEAD_FROZEN
  ↓ exact-head independent engineering review complete (assurance, not authority)
REVIEWED
  ↓ machine-generated ceremony manifest (tools/trust-ceremony.mjs generate);
  ↓ target-binding invariants A–C hold at generation
MANIFEST_GENERATED
  ↓ preflight re-fetches GitHub and compares every binding, including the live
  ↓ target branch head (tools/trust-ceremony.mjs preflight)
PREFLIGHT_VALID
  ↓ authorized independent reviewer signs a CERTIFIED receipt for the exact candidate
CERTIFIED_RECEIPT_ISSUED
  ↓ supervisor signs TrustRootUpgradeV1 authorization bound to the manifest coordinates
SUPERVISOR_AUTHORIZED
  ↓ artifacts transported via PR comment; base-rooted gate re-evaluates
GATE_GREEN
  ↓ final live coordinate check immediately before merge (invariant D)
FINAL_COORDINATE_CHECK
  ↓ merge
MERGED
  ↓ post-merge behavior proven on the new main (missing evidence → clean BLOCKED;
  ↓ evidence comment → automatic gate re-evaluation)
POST_MERGE_VERIFIED
```

## Target-branch binding invariants (manifest schema v2)

The PR object's `base.sha` is a historical snapshot: GitHub does not update it
when the target branch advances. A manifest that binds only `base.sha` can
therefore report PASS while `main` has moved past the candidate (observed for
PRs #144/#145: preflight PASS with a stale candidate). Ceremony manifests are
schema v2 and bind, distinctly:

- `base_ref` — the protected merge target ref (`main`);
- `base_sha` — the PR object's recorded base (what receipts/authorizations
  bind; the base-rooted gate compares against this exact value);
- `target_ref_head_sha` — the live `refs/heads/<base_ref>` head at generation;
- `merge_base_sha` — the effective three-dot diff base
  (`git merge-base base_sha head_sha`); in a ceremony-ready state all three
  SHAs are equal;
- `head_sha` — the frozen candidate.

A preflight must satisfy all of:

- **Invariant A** — PR base ref == the expected protected target ref (`main`).
- **Invariant B** — `base_sha == target_ref_head_sha` at generation: the
  candidate is based on the *current* target head, not a historical snapshot.
- **Invariant C** — `target_ref_head_sha` is an ancestor of (or equal to)
  `head_sha`: the candidate incorporates the current target.
- **Invariant D** — the target head must not move between manifest generation,
  CERTIFIED review, supervisor authorization, and the final merge preflight.
  Each preflight re-resolves the live target head; movement fails closed.

Failure of any invariant invalidates every downstream ceremony artifact.

### Stale-state reason codes

| Code | Meaning |
| --- | --- |
| `target_ref_changed` | PR no longer targets the ref the manifest bound |
| `base_ref_mismatch` | PR does not target the protected branch (`main`) at all |
| `target_branch_advanced` | live target head differs from the manifest's `target_ref_head_sha` |
| `candidate_not_based_on_current_target` | live target head is not an ancestor of the candidate (undeterminable ancestry also fails closed here) |
| `target_head_changed_after_review` | target head moved after a review artifact recorded its target binding (`--artifact-target-head` + `--stage review`) |
| `target_head_changed_after_authorization` | same, for a supervisor authorization (`--stage authorization`) |
| `missing_target_binding` | pre-v2 manifest without target binding fields |

Legacy codes are unchanged and still enforced: `head_sha_changed`,
`base_sha_changed`, `protected_path_set_changed`, `protected_diff_changed`,
`manifest_expired`, `pr_not_open`, `pr_number_changed`, `repository_mismatch`,
`schema_version_changed`.

Pre-v2 manifests are rejected wholesale (`schema_version_changed` +
`missing_target_binding`): schema migration is fail-closed, and every
ceremony artifact generated before this change is void.

## Invalidation rules

| Event | Effect |
| --- | --- |
| Any candidate source change after `HEAD_FROZEN` | lifecycle returns to `ENGINEERING`; prior review evidence, manifest, and any signatures become invalid |
| Target branch (`main`) advancement after `MANIFEST_GENERATED` | preflight fails (`target_branch_advanced`); rebase onto the current target head, regenerate manifest (invariant B restores `base_sha == target_ref_head_sha`), redo exact-head review, re-issue all signatures |
| Candidate does not contain the current target head | preflight fails (`candidate_not_based_on_current_target`); rebase required |
| Target head movement after review/authorization artifact recorded its target binding | artifact void (`target_head_changed_after_review` / `target_head_changed_after_authorization`) |
| PR retargeted away from `main` | preflight fails (`base_ref_mismatch` / `target_ref_changed`) |
| Protected path set or protected diff digest change | manifest stale (`protected_path_set_changed` / `protected_diff_changed`); all signatures invalid |
| PR close/reopen, head force-push, PR number or repository change | manifest stale; regenerate |
| Manifest expiry (24h freshness) | regenerate; do not sign from a stale manifest |

## Refresh workflow (target drift recovery)

When preflight reports target drift:

1. Rebase the candidate onto the current target head; force-push the PR
   branch. If the PR object's recorded `base.sha` still trails the target
   head (GitHub keeps it historical), retarget the PR base away from and back
   to `main` so the recorded base resets to the live head.
2. Rerun ordinary checks and the trust regression matrix.
3. Redo the exact-head independent engineering review (the old head is void).
4. Regenerate the manifest (`generate` prints
   `PR_BASE_EQUALS_TARGET_HEAD` / `TARGET_HEAD_IS_ANCESTOR_OF_CANDIDATE`;
   both must be `true`) and the PR-body ceremony block.
5. Mark all prior ceremony artifacts in the PR body/comments
   **SUPERSEDED — DO NOT SIGN**.
6. Rerun preflight immediately before any signing act and again immediately
   before merge (invariant D).

## Tooling

- `node tools/trust-ceremony.mjs generate --repository <repo> --pr <n> [--out FILE]` —
  derive the complete coordinate set from live GitHub state + exact diff +
  the base-rooted gate's protected-path list + the live target branch head.
  Readiness flags are printed to stderr; `NOT READY` means rebase, regenerate.
- `node tools/trust-ceremony.mjs preflight --manifest FILE --repository <repo> --pr <n>` —
  immediately before signing and before merge; must print
  `TRUST_ROOT_PREFLIGHT=PASS`. Accepts `--artifact-target-head SHA --stage
  review|authorization` to also enforce a recorded artifact target binding.
- `node tools/trust-ceremony.mjs validate-staleness --manifest FILE` —
  fail closed with precise reasons (`STALE_TRUST_ROOT_CEREMONY`). Offline mode
  (`--expect-base`/`--expect-head`, plus `--expect-target-head`,
  `--expect-base-ref`, `--expect-ancestry true|false`, `--expect-digest`,
  `--expect-state`) compares against explicitly provided coordinates;
  omitted ancestry fails closed for v2 manifests.
- `node tools/trust-ceremony.mjs body-section --manifest FILE` — render the
  marker-delimited PR-body ceremony block
  (`<!-- babel-trust-root-ceremony-generated -->`). PR bodies must never carry
  hand-maintained SHA/digest ceremony values outside that generated block.

Digest semantics replicate the base-rooted gate exactly
(`Get-AgentProtectedDiffDigest`, `Get-AgentNumstatDigest`), so the manifest's
`protected_diff_digest` is byte-comparable with what the gate verifies. Parity note: the gate sorts
with PowerShell `Sort-Object`, whose ordering is runtime-culture-dependent —
all gate invocations are pinned to pwsh 7 (ICU ordering), which matches this
tool; a Windows PowerShell 5.1 invocation would order differently (recorded as
a trust-plane follow-up to pin ordinal sorting in the gate).

## Merge-time enforcement (defense in depth)

The ceremony preflight enforces target binding before signing. The
base-rooted gate independently enforces the same property at merge time:
`BASE_NOT_INVALIDATED` requires the PR object's recorded base to equal the
live target head (`pr_base_sha_is_stale` otherwise), and the
TrustRootUpgradeV1 authorization must match the exact base/head/digest
coordinates. Signing flows must never rely on the merge-time check to catch
drift — preflight is mandatory before every signing act.

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
