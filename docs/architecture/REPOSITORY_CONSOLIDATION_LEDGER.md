<!-- License: Apache-2.0 — see LICENSE -->

<!-- status: ACTIVE; captured 2026-08-29 -->
# Repository Consolidation Ledger

This ledger is the durable, sanitized index of meaningful work found during
the repository consolidation. Full per-worktree status, diffs, untracked
source copies, branch topology, PR JSON, and recovery evidence are retained in
the local consolidation artifact package; machine paths and credentials are
intentionally excluded from this document.

| Class | Work | Source / evidence | State | Action |
|---|---|---|---|---|
| A | Merged mainline work through PR #125 | `origin/main` at the captured baseline | Durable | Use as the only integration base |
| B | Provider runtime generalization | Current dirty provider diff; neutral transport extraction | Reapplied on integration branch | Verify isolation and compatibility tests |
| C | GLM / DeepSeek reliability | Current provider and model-policy diff plus merged reliability PRs #122–#124 | Partly in main, partly preserved | Reconcile exact IDs, finish attribution, usage, and breaker behavior |
| D | Model Intelligence core | Preserved `src/intelligence/*` and typed tests | Recovered | Port only with current runtime contracts |
| E | MI repair, certification, live qualification, review packaging | Preserved MI scripts/docs and prior partial qualification evidence | Live campaign intentionally not rerun | Keep evidence immutable; classify the partial result as incomplete |
| F | Autonomous SWE trust foundations | PR #120 / remote branch and captured worktree | Open PR, stale base | Reconcile semantically after trust root |
| G | Trusted control bootstrap | PR #121 / remote branch and captured worktree | Open PR, stale base | Reconcile first; do not blind-merge |
| H | UI, Remote, BDNS, TUI, workflow, and other parallel work | Branch/worktree inventory and preservation receipts | Preserved, not part of this integration slice | Keep on source branches or later focused PRs |
| I | Generated reports, runs, caches, and packages | Artifact inventory and untracked-file receipts | Preserved locally | Do not publish generated/private material |
| J | Obsolete or superseded candidates | Reflog/branch comparison required per item | Not deleted | Mark only after semantic reconciliation and recovery receipt |

## Reconciliation rules

Every entry has a source worktree/branch or PR, an observed commit/file
reference, and an explicit action. Existing commits and remote PR heads are
already recoverable; dirty or unreadable worktrees have preservation receipts
before any future cleanup. No branch, worktree, stash, or artifact is treated
as obsolete solely because it is stale, detached, or hard to query.
