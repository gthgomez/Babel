# Merge Control Plane V1

Status: active exact-head merge gate; normal task-authorized merge execution is enabled through the protected GitHub path.

This document defines the boundary between repository policy, technical evidence,
and the authority to perform a public merge. No one of those dimensions can
impersonate another.

## Gate dimensions

`agent-pr-gate.ps1` evaluates independent dimensions and emits a versioned JSON
record:

- identity: repository, remote, PR, branch, and exact reviewed head
- base freshness: PR base equals the freshly fetched required base
- worktree: observed state and optional linked-worktree requirement; unrelated dirty bytes do not invalidate an exact remote PR head
- PR state: open, non-draft, same-repository, mergeable, and clean merge state
- repository policy: the active `protect-main` ruleset read from GitHub
- CI: required contexts resolved only from the exact head, expected workflow/event, and the GitHub Actions producer identity pinned by the active ruleset
- technical review: exact-head `autonomous_review_evidence_v1` records reviewer-separation provenance for ordinary HIGH/CRITICAL candidates; a signed `independent_review_receipt_v2` is the certified tier for protected trust-root changes or when `BABEL_REQUIRE_SIGNED_REVIEW=1`
- task authority: deliberately not evaluated by this repository-controlled gate;
  normal checked merge inherits from the trusted active shipping task (or an exact-PR runtime lease), while CI, receipts, PR text, and agent output cannot expand it
- scope: exact diff paths and optional path allowlist

The result is `MERGE_READY` only when every required dimension is satisfied.
Unreadable policy, missing provenance, pending checks, ambiguous check lineage,
or stale review evidence produces `BLOCKED`. The gate reports technical
eligibility and never performs the merge itself.

## GitHub policy versus Babel policy

The gate records these fields separately:

```text
githubRequiredApprovalCount
githubApprovalSatisfied
reviewThreadsRequired
reviewThreadsSatisfied
independentReviewRequired
independentReviewSatisfied
independentReviewReceipt
gateScope
taskAuthorityEvaluated
taskAuthoritySource
```

GitHub's required approval count is discovered from the active ruleset. A ruleset
with zero required approvals satisfies only the GitHub approval dimension; it does
not waive Babel's independent technical review policy for high-risk changes.
Review-thread resolution is queried separately through GitHub's review-thread
API. The gate never treats `reviewDecision` as a substitute for these dimensions.

## Exact-head CI resolution

Required status contexts are read from the active ruleset, then normalized to:

```text
name, head_sha, status, conclusion, workflow_id, workflow_name,
workflow_run_id, workflow_run_attempt, event, check_suite_id, check_run_id,
started_at, completed_at, authority, app_id
```

For each required context the resolver:

1. filters to the exact PR head;
2. accepts only the configured authoritative workflow and event;
3. requires the producer app ID pinned for that context in `protect-main`;
4. ignores non-authoritative or wrong-producer duplicate twins;
5. requires check identity, timestamps, and workflow lineage;
6. selects the latest authoritative execution deterministically by timestamps,
   attempt, run ID, and check ID;
7. treats a later failure as failure, a later success as success, and pending as
   blocked; and
8. fails closed for missing or ambiguous authority.

The result is invariant under GitHub API response permutation. Historical success
on another SHA is never admissible.

The ordinary validation workflow owns `pull_request`. The privileged metadata
workflow owns only `pull_request_target`, checks out the default branch, and has a
distinct workflow name. It does not execute PR-controlled code and does not emit
misleading skipped twins for ordinary validation contexts.

## Technical review evidence tiers

The ordinary autonomous evidence shape is:

```text
schema_version: 1
kind: autonomous_review_evidence_v1
repository, pr_number, base_sha, head_sha, builder_id
reviewer_id, reviewer_class, review_mode, reviewed_at
scope, findings, blocking_findings, verdict, diff_numstat_digest
```

This artifact is deterministic, exact-head analysis provenance. It requires a
reviewer identity distinct from the recorded builder, but it is not a
cryptographic identity proof and must not be described as one. It is accepted
only when no protected trust-root path changed.

The certified receipt is `schema_version: 2`,
`kind: independent_review_receipt_v2`. It is exact-base/head bound, has a
non-empty `reviewed_scope` (or the explicit repository scope), no blocking
findings, uses `APPROVE`, identifies a reviewer distinct from the builder, and
carries the signature fields validated by
`scripts/verify-independent-review.mjs`. Protected trust-root changes also need
a supervisor-signed `TrustRootUpgradeV1` authorization binding repository, PR,
base, head, protected paths, and protected diff digest. Neither evidence tier
creates task authority.

The trusted `pull_request_target` workflow checks out immutable base code and
uses `scripts/materialize-independent-review-receipt.ps1` to extract exactly one
head-matching receipt from PR comments. Missing or multiple handoffs are
materialized as verifier-visible transport errors. Comment text is untrusted
transport data, not authority.

Initial policy: LOW may use CI plus exact-head review under repository policy;
MEDIUM is policy-dependent; HIGH and CRITICAL require independent exact-head
evidence. Protected trust-root changes additionally require the CERTIFIED tier
and TrustRootUpgradeV1 authorization. None of these technical tiers creates or
replaces task authority.

## Trusted execution ownership

The `TrustedExecutionRegistryV1` used by V1 completion evaluation is an
orchestrator-owned capability. Candidate or builder execution may submit evidence
through a narrow interface, but may not create, populate, replace, or mutate the
authoritative registry. Serialized evidence fields are claims to be checked
against that registry, never a source of registry authority. The current V1
implementation keeps mutating workers disabled; the ownership boundary is
documented so later sandbox work cannot accidentally reverse it.

## Closure reporting

High-risk closure reports use this matrix:

```text
ID | SEVERITY | ROOT_CAUSE | IMPLEMENTATION | ADVERSARIAL_TEST |
EVIDENCE | REMAINING_LIMITATION | STATUS
```

Statuses distinguish `FIXED`, `MITIGATED`, `PRIMITIVE_FIXED_INTEGRATION_PENDING`,
`BASELINE_INHERITED`, `EXTERNAL_BLOCKER`, `NOT_IMPLEMENTED`, and `NOT_VERIFIED`.
An inherited classification is valid only when the exact command has been run on
both the feature head and the frozen base.

## Protected merge state machine

```text
PR_HEAD_CREATED -> LOCAL_VERIFIED -> INDEPENDENT_REVIEWED
  -> CI_GREEN_EXACT_HEAD -> MERGE_GATE_READY -> PRE_MERGE_REFREEZE
  -> MERGE -> POST_MERGE_VERIFY -> COMPLETE
                         \-> main changed: INVALIDATE / UPDATE / REVERIFY
```

Every meaningful SHA change invalidates prior review and CI evidence. Once the
exact PR target reaches `MERGE_GATE_READY`, the trusted active shipping task may
invoke GitHub's normal protected merge or auto-merge path without a second owner
confirmation. If Babel's runtime PDP executes that command, its externally
supplied task lease must include `merge` plus the same exact positive PR number
in `constraints.allowedPullRequests`; generic defaults do not grant it. The
repository gate itself never claims to authenticate the task or mint that lease.
This does not enable force-push, release/deploy, credential delegation,
trust-root self-modification, or protection bypass.

The repair PR itself has one explicit bootstrap path: `-BootstrapRepairAuthorized`
may be supplied only after the frozen-base gate has been run and its sole
remaining blockers are the proven old approval mismatch and the new
target-workflow authority gap. The gate records the exception, requires all
other dimensions plus a successful exact-head legacy metadata result, and never
treats the mode as a general check bypass.
