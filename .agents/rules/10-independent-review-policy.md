<!--
status: ACTIVE
last_verified: 2026-09-26
-->
# Independent Review Routing

Every PR requires V3 independent final certification of its exact current base/head.
TRIVIAL and NORMAL require one fresh certifier. ELEVATED and CRITICAL require two fresh,
distinct certifiers. BLACK remains an owner-decision boundary. Same-harness and same-model
reviewers are valid when their observed child executions are distinct from the builder,
repair producer, and each other.

The active coding harness owns spawning. Run `tools/babel-pr-orchestrate.mts prepare` to
freeze the candidate and issue challenges, spawn native read-only children, submit their
structured results, then publish the owner-authenticated handoff. The in-process
`HarnessReviewAdapter` API uses the same protocol. Codex is the first native bridge;
OpenCode is an explicit fallback. Other harnesses implement the shared contract later.

Certification requires `FINAL_CERTIFICATION`, a fresh child context, an observed session
identity, enforced read-only review, full exact diff delivery and acknowledgement, and
candidate SHA/digest binding. Reviewer source reads are telemetry. Reviewers cannot write
the candidate, mutate GitHub, or merge. The trusted host must restrict controller-state
reads before claiming that isolation. A repair producer cannot certify its own candidate.
BLOCK against an unchanged candidate is retained.

Review authority is scope-derived. `resolveReviewAuthority(scope)` returns `SESSION_ATTESTED` for
ordinary PRs, where a fresh harness-native child (no root-owned binary required) is launched
read-only with observed identity and full exact-diff delivery; it returns `HOST_PROTECTED` when any
changed path matches `hostProtectedPrefixes` in `config/review-risk-policy.json` (the
reviewer/gate/authority surface), where the protected installation and launcher must attest the
review. A `HOST_PROTECTED` run fails closed when the adapter cannot attest host protection; the
OpenCode fallback is `SESSION_ATTESTED` only. Reviewers still never merge. After the base-rooted gate
reports `MERGE_READY` for the exact reviewed head, the orchestrator may run
`scripts/agent-pr-merge.ps1` under the rule 05 bounded-autonomous merge contract; the executor binds
`gh pr merge --match-head-commit` to that head and never merges on a mismatch.

The base-rooted merge gate accepts V3 only. It fetches the live owner comment and checks
owner identity, exact candidate, scope, fresh independent child evidence, reviewer count,
and isolation and coverage receipts. V2 comments are historical and cannot satisfy this
gate. A changed gate must be reviewed under the previously trusted base before promotion.

Reviewer rejection, malformed output, a provider timeout, changed SHA, failed
check, or missing handoff is a repair/verification event, not a new permission
request. Preserve the failed run, classify its cause, make a bounded safe repair,
and obtain fresh evidence. Escalate only for unresolved product intent, new
credential trust boundaries, nondelegable account actions, or consequences
outside the owner's task authority.

For owner-authorized Babel PR reviews, there is no monetary cap. Record usage
and uncertainty; do not convert unknown cost to zero. Wall-clock, turn, stall,
concurrency, duplicate-effect, and bounded-retry controls still apply. Retain
private raw telemetry and failed attempts so harness defects can become tested
regressions; do not publish raw transcripts or credentials in PR comments.
