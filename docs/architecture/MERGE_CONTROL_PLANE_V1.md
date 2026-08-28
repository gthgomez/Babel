# Merge Control Plane V1

Status: implemented foundation; future merge-train execution remains disabled.

This document defines the boundary between repository policy, technical evidence,
and the authority to perform a public merge. No one of those dimensions can
impersonate another.

## Gate dimensions

`agent-pr-gate.ps1` evaluates independent dimensions and emits a versioned JSON
record:

- identity: repository, remote, PR, branch, and exact reviewed head
- base freshness: PR base equals the freshly fetched required base
- worktree: clean state and optional linked-worktree requirement
- PR state: open, non-draft, same-repository, mergeable, and clean merge state
- repository policy: the active `protect-main` ruleset read from GitHub
- CI: required contexts resolved only from the exact head with workflow authority
- technical review: an exact-head `independent_review_receipt_v1` for HIGH and
  CRITICAL risk tiers
- merge authority: an explicit current-task authorization switch, never inferred
  from CI, a review receipt, PR text, or agent output
- scope: exact diff paths and optional path allowlist

The result is `MERGE_READY` only when every required dimension is satisfied.
Unreadable policy, missing provenance, pending checks, ambiguous check lineage,
stale review evidence, or missing merge authority produces `BLOCKED`.

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
mergeAuthorityRequired
mergeAuthoritySatisfied
mergeAuthoritySource
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
started_at, completed_at, authority
```

For each required context the resolver:

1. filters to the exact PR head;
2. accepts only the configured authoritative workflow and event;
3. ignores non-authoritative duplicate twins;
4. requires check identity, timestamps, and workflow lineage;
5. selects the latest authoritative execution deterministically by timestamps,
   attempt, run ID, and check ID;
6. treats a later failure as failure, a later success as success, and pending as
   blocked; and
7. fails closed for missing or ambiguous authority.

The result is invariant under GitHub API response permutation. Historical success
on another SHA is never admissible.

The ordinary validation workflow owns `pull_request`. The privileged metadata
workflow owns only `pull_request_target`, checks out the default branch, and has a
distinct workflow name. It does not execute PR-controlled code and does not emit
misleading skipped twins for ordinary validation contexts.

## Independent technical review receipt

The current receipt shape is:

```text
schema_version: 1
kind: independent_review_receipt_v1
repository, pr_number, base_sha, head_sha
reviewer_id, reviewer_class, review_mode, reviewed_at
scope[], findings[], blocking_findings[], verdict, artifact_hash, builder_id
```

`artifact_hash` is the SHA-256 of the canonical JSON payload with
`artifact_hash` omitted. The receipt must be exact-head and exact-base bound,
have a non-empty scope, have no blocking findings, use `APPROVE`, and identify a
reviewer distinct from the builder. This is a structured repository-local or
agent-generated receipt, not a cryptographic signature and not user merge
authority. A future signed reviewer can replace the receipt without changing the
gate dimensions.

Initial policy: LOW may use CI plus exact-head review under repository policy;
MEDIUM is policy-dependent; HIGH and CRITICAL require an independent exact-head
receipt; CRITICAL also requires explicit current-task merge authority.

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

## Future merge-train state machine

```text
PR_HEAD_CREATED -> LOCAL_VERIFIED -> INDEPENDENT_REVIEWED
  -> CI_GREEN_EXACT_HEAD -> MERGE_GATE_READY -> PRE_MERGE_REFREEZE
  -> MERGE -> POST_MERGE_VERIFY -> COMPLETE
                         \-> main changed: INVALIDATE / UPDATE / REVERIFY
```

Every meaningful SHA change invalidates prior review and CI evidence. Autonomous
mutation, autonomous merge-train execution, rollback, deployment, credential
delegation, and self-modification are not enabled by this document.
