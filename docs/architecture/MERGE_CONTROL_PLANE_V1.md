# Merge Control Plane V1

Status: authorization simplification migration in progress. The base-rooted gate is authoritative; custom owner signing is no longer part of normal merges.

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
- technical review: optional advisory evidence from any harness; no custom certificate grants merge permission
- task authority: the original task authorizes routine Git/PR actions; no
  separate per-merge switch exists
- scope: exact diff paths and optional path allowlist

The result is `MERGE_READY` only when every required dimension is satisfied.
Unreadable policy, pending required checks, ambiguous check lineage, or a stale
verified head produces `BLOCKED`. Optional review evidence never becomes a false approval.

## Risk lanes

The immutable base derives a minimum path-based lane; callers may raise, never lower it.
Risk lanes guide review effort and diagnostics. They do not require a vendor,
supervisor or custom certificate for GitHub merge authorization. BLACK remains
an owner-decision boundary for a genuinely unclassified action or scope.

## GitHub policy versus Babel policy

The gate records these fields separately:

```text
githubRequiredApprovalCount
githubApprovalSatisfied
reviewThreadsRequired
reviewThreadsSatisfied
independentReviewRequired
independentReviewSatisfied
independentReviewEvidence
taskAuthorization
```

GitHub's required approval count is discovered from the active ruleset. Custom
Babel independent evidence is advisory. The gate reports evidence validity
truthfully and queries review-thread resolution separately. Actual merge
permission is enforced by GitHub, not inferred from CI or metadata access.

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

The required producer map is explicit: `trusted-control-plane` is produced by
`pull_request_target / Trusted Control Plane`; `public-pr-metadata` is produced by
`pull_request_target / Public PR Metadata`; and `security`,
`public-content-policy`, `linux-validation`, and `windows-portability` are
produced by `pull_request / Public Release Gate`. Each ruleset entry must also
retain its GitHub Actions integration identity (currently integration `15368`).
The ordinary validation workflow owns `pull_request`. The privileged workflows
check out the default branch, have distinct workflow names, do not execute
PR-controlled code, and cannot satisfy a differently bound same-name check.

## Independent technical review

Use a reviewer from any harness and publish actual findings against the exact
head in a normal comment or native review. Separate executions improve review
quality; no supervisor or custom receipt is an authorization prerequisite.
Optional V3 certification continues to validate its own stronger assertions.
Missing or invalid custom evidence remains visible and does not block readiness.

Privileged workflows execute immutable base only and do not require the optional
evidence materializer. GitHub requires an up-to-date branch, closing the
base-change race after an audit. Task authority survives repairs; changed heads
require fresh checks.

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

Every meaningful SHA change invalidates prior review and CI evidence, not the
original task's routine-action authority. The dispatcher handles the authorized
repair/review/merge loop; GitHub required checks remain the final enforcement.

The older main workflow still enforces the previous custom-certification policy
until this change is promoted. Its replacement is a deliberate maintainer policy
migration, not a claim that a candidate can change the immutable evaluator.
Normal merge paths never use admin bypass or skip required implementation CI.
