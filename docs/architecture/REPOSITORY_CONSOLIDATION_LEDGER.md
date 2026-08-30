# Repository Consolidation Ledger

<!--
status: ACTIVE
last_verified: 2026-08-30
-->

## Current snapshot

- canonical remote: `https://github.com/gthgomez/Babel.git`
- observed `origin/main`: `a997d877e8342759afefc3ca9257eb6d4d9a38a2`
- primary candidate: PR #126 at `e029ca2c762cccbc9f21681ba562327e23350850`
- superseded candidate: PR #120 at `73fda8d46e0cd85706d225551793946557e5c7c5`
- open PRs observed: #120 and #126

## Reconciliation

PR #126 contains every material path changed by #120. The two trust-root
artifacts that do not appear in #126's changed-file list are inherited from
its current base, not omitted: `config/independent-review-keys.json` and
`scripts/verify-independent-review.mjs` are both present in the #126 tree.
The complete path-level record is in
[`PR120_PR126_RECONCILIATION.md`](PR120_PR126_RECONCILIATION.md).

## Required closeout order

1. certify the final #126 head against its exact current base;
2. close #120 as superseded and delete its branch only after uniqueness proof;
3. clean only uniquely identified Babel worktrees/clones using a deletion
   ledger;
4. refresh this ledger with the final merged SHA and cleanup inventory.

No line in this ledger is evidence that a remote merge or deletion has already
occurred. Such claims require fresh command output recorded in the final
package.
