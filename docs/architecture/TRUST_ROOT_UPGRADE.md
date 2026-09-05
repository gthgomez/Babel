<!---
status: ACTIVE
last_verified: 2026-09-05
-->

# TrustRootUpgradeV1 — safe post-bootstrap trust-root upgrades

## Problem being solved

The trusted GitHub workflow evaluates every pull-request candidate with the
gate code and key registries materialized from the **immutable base commit**
(`pull_request_target` checks out `base.sha`; the candidate is attached only
as a data-only worktree). That is what makes candidate self-verification
impossible — and it also means a candidate that *modifies the trust root*
(e.g. the gate itself) can never be certified by the verifier it is replacing.

Before this document, the only escape hatch was hard-coded: the base-rooted
gate permitted a trust-root modification **only for PR #121**, the original
one-time trust-root bootstrap, and `scripts/bootstrap-trust-root.ps1` refused
to run once the trust root existed. Every later trust repair therefore
required an out-of-band, ad-hoc ruleset exception (PRs #127, #131–#135), which
is exactly the pattern the reconciliation campaign was chartered to end.

TrustRootUpgradeV1 replaces the hard-code with a general, cryptographically
authorized upgrade protocol while keeping every other protection intact.

## Invariants (unchanged)

1. **Immutable-base verification.** The workflow still runs only base-rooted
   gate code. Candidate code is data.
2. **Candidate self-authorization is impossible.** The upgrade authorization
   is an Ed25519 signature from a supervisor key in the *base-rooted*
   `config/trusted-supervisor-keys.json`. No candidate content can forge it.
3. **Exact-SHA binding.** An authorization binds one repository, one PR
   number, one base SHA, one head SHA.
4. **Protected-path-set and protected-diff-digest binding.** The
   authorization enumerates the exact protected paths changed and the exact
   digest of their head blobs; any additional trust-root edit invalidates it.
5. **Independent reviewer authority.** A trust-root change also requires a
   signed independent review receipt (never the autonomous review tier).
6. **No permanent bypasses.** No bypass actors; no reduced required checks.
7. **Current-target binding** (ceremony manifests schema v2). A frozen PR is
   not a frozen world: the PR object's `base.sha` is a historical snapshot
   GitHub never updates when the target branch advances. A trust-root
   candidate may therefore not be signed unless the live
   `refs/heads/<base_ref>` head equals the recorded base and is an ancestor
   of the candidate. See "Current-target binding" below and
   [TRUST_CEREMONY_LIFECYCLE.md](./TRUST_CEREMONY_LIFECYCLE.md).

## Current-target binding (ceremony preflight, manifest schema v2)

PRs #144/#145 exposed a second-order trust flaw: a ceremony manifest that
binds only the PR object's `base.sha` can report
`TRUST_ROOT_PREFLIGHT=PASS` while `main` has advanced past the candidate's
base, because GitHub keeps `base.sha` at its creation-time snapshot. The
ceremony tooling (`tools/trust-ceremony.mjs`) now emits schema-v2 manifests
that additionally bind `base_ref`, the live `target_ref_head_sha` at
generation, and the effective `merge_base_sha`, and its preflight fails
closed with deterministic reasons (`target_branch_advanced`,
`candidate_not_based_on_current_target`, `base_ref_mismatch`,
`target_ref_changed`, `target_head_changed_after_review`,
`target_head_changed_after_authorization`) when the candidate no longer
incorporates the current target head, or when the target moved after a
review or authorization artifact was issued.

Enforcement is layered: ceremony preflight (mandatory immediately before
every signing act) plus the base-rooted gate's `BASE_NOT_INVALIDATED` check
(`pr_base_sha_is_stale`) at merge time. The authorization schema itself is
unchanged — v1 receipts and authorizations bind base/head/digest as before;
target binding lives in the ceremony manifest and the preflight discipline,
so this repair required no protected-path change.

Future work (TrustRootUpgradeV2 candidate, not part of the current schema):
bind the *prospective integration state* rather than only the delta — a
`git merge-tree --write-tree` OID of the resulting tree, so an authorization
certifies the exact integrated tree that will land, immune to merge-order
drift. Rejected for now: changing the protected verifier schema mid-flight
would invalidate the existing ceremony chain for marginal benefit over the
target-head + ancestry binding.

## Authorization schema (`trust_root_upgrade_authorization_v1`)

```json
{
  "schema_version": 1,
  "kind": "trust_root_upgrade_authorization_v1",
  "intent": "trust_root_upgrade",
  "decision": "AUTHORIZE_TRUST_ROOT_UPGRADE",
  "repository": "gthgomez/Babel",
  "pr_number": 138,
  "base_sha": "<40-hex>",
  "head_sha": "<40-hex>",
  "protected_paths": ["...exact changed protected paths..."],
  "protected_diff_digest": "<sha256 hex>",
  "issued_at": "<ISO-8601>",
  "expires_at": "<ISO-8601, after issued_at, checked against verification time>",
  "signature": { "algorithm": "ed25519", "key_id": "<registry key id>", "value": "<base64url>" }
}
```

The signature covers the canonical JSON (recursively key-sorted) of all
fields except `signature`, exactly like the independent-review verifier.

Timestamp format constraint: every timestamp that participates in a signed
artifact hash (`reviewed_at` in receipts) must use `YYYY-MM-DDTHH:mm:ssZ`
(UTC, no fractional seconds). The base-rooted gate re-serializes parsed JSON
when recomputing the artifact hash, and PowerShell's JSON round-trip
normalizes timestamps in exactly that format; fractional-second or
offset-bearing timestamps would fail hash verification.

### Protected diff digest

Computed by the base-rooted gate over the candidate head tree:

```text
lines  = for each changed path in sorted(protected_paths):
           path + "\t" + git rev-parse head_sha:path   (blob SHA)
digest = SHA256( sorted(lines) joined with "\n" )
```

The signer must recompute this identically from an equivalent checkout.

### Transport

The authorization is posted as a normal PR comment:

```html
<!-- babel-trust-root-upgrade-authorization-v1 -->
```json
{ ...authorization... }
```
```

Comments are **transport only**. `scripts/materialize-independent-review-receipt.ps1`
paginates through *all* comment pages, extracts marker-delimited JSON,
requires the embedded base/head bindings, and fails closed on zero or
multiple distinct documents. Authority comes exclusively from signature
verification against the base-rooted registry.

## Gate behavior (`scripts/agent-pr-gate.ps1`)

- The protected trust-root path set is: `config/independent-review-keys.json`,
  `config/trusted-supervisor-keys.json`, `scripts/verify-independent-review.mjs`,
  `scripts/verify-trust-root-upgrade.mjs`,
  `scripts/materialize-independent-review-receipt.ps1`,
  `scripts/trusted-merge-gate.ps1`, `scripts/bootstrap-trust-root.ps1`,
  `scripts/agent-pr-gate.ps1`, `scripts/agent-pr-gate-common.psm1`,
  `scripts/agent-git-common.psm1`.
- If none changed: nothing is required; the PR proceeds normally.
- If any changed, the audit passes only with **all** of:
  1. a valid signed independent review receipt (autonomous review evidence is
     explicitly *not* accepted — `signedReviewRequired`);
  2. exactly one distinct, valid, unexpired authorization whose every binding
     matches this PR, verified by the base-rooted
     `scripts/verify-trust-root-upgrade.mjs`;
  3. all ordinary gates (exact head, clean isolated worktree, peer required
     checks, resolved review threads) still green.

Failures are recorded in the audit JSON under `trustRoot.*` and block the
merge with `protected_trust_root_modified`.

## Workflow integration fixes in this change

These were the reasons `trusted-control-plane` had never been green for any
PR, and they are fixed without weakening any check:

1. **Detached candidate worktree.** The workflow materializes the candidate
   as a detached worktree by design, but the gate unconditionally required an
   on-branch checkout (`detached_head`). A detached head is now accepted only
   when `-RequireIsolatedWorktree` is set, the worktree is isolated, and its
   HEAD equals the exact reviewed head; canonical operator checkouts must
   still be on-branch.
2. **Line-ending normalization.** `.gitattributes` normalizes text files, but
   `scripts/bootstrap-trust-root.ps1` (CRLF) and `scripts/trusted-merge-gate.ps1`
   (mixed) carried non-normalized blobs, so every Linux checkout — including
   the workflow's candidate worktree — reported those files as permanently
   dirty (`dirty_worktree`). Both blobs are renormalized (content-identical).
3. **Self-check merge state.** While the trusted job runs, the PR's merge
   state is `BLOCKED` because this very check is pending. Inside the trusted
   job the gate now accepts `MERGEABLE` + peer-check authority (conflicts are
   still caught by `MERGEABLE`, drafts by `NO_DRAFT`, peers by their own
   authoritative resolution). Outside the trusted job, `CLEAN` is still
   required.
4. **Null-safety.** `$requiredChecks` could become `$null` when the ruleset
   was unreadable (empty `@()` unrolls to nothing from an if-expression),
   causing a `pr_gate_exception`; the assignment is now explicit.
5. **Cleanup hardening.** Temporary-file cleanup in `finally` blocks can hit
   transient AV/index locks on Windows; it is now best-effort and can never
   mask an audit result.

## Review tiers for ordinary (non-trust-root) PRs

Per `.agents/rules/10-independent-review-policy.md`, ordinary PRs satisfy
independent review with either:

- **CERTIFIED** — a signed `independent_review_receipt_v1` bound to a
  supervisor-signed consumed challenge (unchanged verification path); or
- **AUTONOMOUS** — structured `autonomous_review_evidence_v1` from an
  isolated read-only AI reviewer (reviewer ≠ builder, exact base/head,
  `diff_numstat_digest` binding over `git diff --numstat base...head`),
  transported the same way as receipts.

Trust-root changes never accept the AUTONOMOUS tier. The repository owner can
force the CERTIFIED tier for **all** PRs by setting the repository variable
`BABEL_REQUIRE_SIGNED_REVIEW=1` (read by the workflow from `vars`), which is
the supported steady state once signing custody is provisioned to CI.

## One-time migration record (this PR)

This PR itself modifies the trust root, so it cannot be authorized by the
pre-upgrade verifier it replaces — the pre-upgrade gate has no
TrustRootUpgradeV1 verification and the retired PR-121 hard-code cannot be
reused. The merge therefore used the repository's established bounded
exception (same mechanism as PR #127): only `trusted-control-plane` was
temporarily removed from the `protect-main` required checks, with:

- exactly one PR: #138;
- exactly one candidate head SHA: recorded in the PR merge comment and
  `docs/reconciliation/BABEL_CANONICAL_RECONCILIATION_FINAL.md`;
- all five other required checks green at that exact head;
- the ruleset restored immediately after the merge, verified byte-for-byte
  against the pre-exception snapshot, with zero bypass actors throughout;
- post-merge re-certification: the next PR based on the new main must obtain a
  green `trusted-control-plane` with **no** exception — that run is the proof
  the new trust plane works end-to-end.

This is the last out-of-band trust transition. All future trust-root changes
must use TrustRootUpgradeV1.
