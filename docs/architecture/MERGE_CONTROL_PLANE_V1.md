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
- technical review: controller-owned exact-head independent AI evidence when
  the base-derived risk lane requires it
- task authority: the original task authorizes routine Git/PR actions; no
  separate per-merge switch exists
- scope: exact diff paths and optional path allowlist

The result is `MERGE_READY` only when every required dimension is satisfied.
Unreadable policy, missing provenance, pending checks, ambiguous check lineage,
stale review evidence, or insufficient lane evidence produces `BLOCKED`.

## Risk lanes

The immutable base derives a minimum path-based lane; callers may raise, never lower it.
GREEN requires deterministic checks; YELLOW
requires one controller-owned independent AI review; RED requires two distinct
independent reviews; BLACK requires a real owner decision. Merge-control,
workflow, policy, and authority paths are RED. A trusted dispatcher classifies BLACK by action/context, not candidate path.
A candidate cannot rewrite its own evaluator, label itself
GREEN, or clear a trusted BLACK classification.

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

The required producer map is explicit: `trusted-control-plane` is produced by
`pull_request_target / Trusted Control Plane`; `public-pr-metadata` is produced by
`pull_request_target / Public PR Metadata`; and `security`,
`public-content-policy`, `linux-validation`, and `windows-portability` are
produced by `pull_request / Public Release Gate`. Each ruleset entry must also
retain its GitHub Actions integration identity (currently integration `15368`).
The ordinary validation workflow owns `pull_request`. The privileged workflows
check out the default branch, have distinct workflow names, do not execute
PR-controlled code, and cannot satisfy a differently bound same-name check.

## Independent technical review evidence

The existing owner-controlled host runs fresh text-only OpenCode Go AI workers.
GitHub transports/enforces evidence; no new App, AI credits or signing keys are needed.
Workers receive original task and exact diff; models supply findings, controllers supply provenance.
Each `autonomous_review_evidence_v2` binds task hash, repo/PR/base/head, full scope,
numstat digest, execution/reviewer ID, observed model/provider, isolation and timestamp.
Invalid, stale, uncertain, blocking, self-reviewed or mismatched evidence blocks merge.

The host publishes one whole `host_review_handoff_v2` under `<!-- babel-controller-ai-reviews-v2 -->`.
Immutable-base transport creates `github_host_review_bundle_v2` with actual owner/comment IDs.
Transport and gate paginate live comments and use GitHub's numeric repository-owner User ID.
The latest matching whole round wins, including rejection; local bundles are only untrusted caches.
Workers have no shell, candidate-write, GitHub-write, merge or controller-state capability.
The owner launcher/session is trusted: this is **not** isolation against malicious processes
already holding owner credentials. Stronger principal isolation is a separate requirement.

Privileged workflows execute immutable base only. Owner comment creation/editing reruns
the original PR audit; a comment-workflow check cannot satisfy the required PR check.
GitHub must require an up-to-date branch, closing the base-change race after an audit.
Task authority survives repairs; changed base/head still requires fresh checks and review.
Use one task-wide spend ledger, retain unknown-usage reservations, scan sources before
transmission, and recheck PR identity before publication.

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

The obsolete `BootstrapRepairAuthorized` per-invocation exception is removed.
A migration from the former signing system may use only the separately
authorized, exact-candidate, snapshot/restore procedure. It must retain every
unaffected check, restore the ruleset immediately, leave no standing bypass,
and be followed by a normal protected PR. This is not a normal merge option.
