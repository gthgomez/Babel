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
- technical review: an exact-head signed `independent_review_receipt_v2` for HIGH and
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
   numeric attempt, numeric run ID, numeric check ID, and stable string
   tie-breakers;
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
schema_version: 2
kind: independent_review_receipt_v2
repository, pr_number, task_id, run_id, contract_hash, base_sha, head_sha
reviewer_id, reviewer_class, review_mode, reviewed_at, challenge_id, builder_id
reviewed_scope, verdict, blocking_findings, authority_provenance, signature
```

The receipt is signed by the supervisor-owned independent review lane with
Ed25519. Its public verification key is loaded from the immutable PR base;
candidate-controlled key registries are not trusted. A supervisor-issued,
durable, single-use challenge is recorded in an atomic ledger, and the
consumed record stores the hash of the one signed receipt. The trusted verifier
checks both the immutable-base verifier implementation and the ledger binding;
ordinary replay, restart replay, expiry, and revocation therefore fail closed.
The receipt must be exact-head and exact-base bound, have a non-empty explicit
file/repository scope, have no blocking findings, use `APPROVE`, and identify a
reviewer distinct from the builder. Signature verification authenticates the
receipt to an authorized review key; it does not by itself establish that the
reviewer was substantively correct or grant merge authority. The branch's
empty key registry is intentionally fail-closed until an operator provisions a
trusted public key through the one-time bootstrap transition.

Initial policy: LOW may use CI plus exact-head review under repository policy;
MEDIUM is policy-dependent; HIGH and CRITICAL require an independent exact-head
receipt; CRITICAL also requires explicit current-task merge authority.

## Trusted execution ownership

The trusted execution authority is created and restored only by the
`src/authority/` supervisor module. Consumers receive a branded read-only port;
serialized evidence fields are claims checked against that port, never a source
of registry authority. Assignment state is durable, hash-checked, task/run/
contract-bound, and restored through the supervisor bootstrap. The module
boundary is enforced for normal package consumers; OS-level process isolation
and external attestation remain deployment responsibilities. Mutating workers
remain disabled.

Review-thread pagination is fail-closed: all pages are fetched, and a missing
cursor when `hasNextPage` is true is unreadable rather than resolved. The gate
does not report a complete result from a truncated 100-item page.

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

The repair PR itself has one explicit bootstrap path: `-BootstrapRepairAuthorized`
may be supplied only after the frozen-base gate has been run and its sole
remaining blockers are the proven old approval mismatch and the new
target-workflow authority gap. The gate records the exception, requires all
other dimensions plus a successful exact-head legacy metadata result, and never
treats the mode as a general check bypass.
