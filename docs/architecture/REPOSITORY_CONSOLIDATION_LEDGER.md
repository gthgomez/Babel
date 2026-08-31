# Repository Consolidation Ledger

<!--
status: ACTIVE
last_verified: 2026-08-30
-->

## Current snapshot

- canonical remote: `https://github.com/gthgomez/Babel.git`
- observed `origin/main`: `c91be8ff901769958691f505b6a4fb3a0b8cd4ed`
- canonical candidate: PR #133 at `6c2a32b22a67184cc0ccb5206fbd49bf8785f824`
- trust follow-up: PR #136 at `72ef5912b4616c18932e541d99cf3b0cf6d78b41`
- additional open PRs observed: #120, #126, #128, #129 (draft), and #130
- the local checkout remains dirty; no remote merge, close, deletion, or cleanup
  mutation has been performed by this campaign

## Reconciliation

PR #133 is the current canonical recovery candidate. PR #129's sole material
path, `babel-cli/src/interactive/testing/realCliInteractiveProcess.test.ts`,
is present in the #133 tree with the readiness/exit hardening carried forward.
PR #133 also includes the trust-gate follow-up changes; PR #136 is a separate
open trust repair candidate and must not be silently conflated with #133. The
earlier #120/#126 relationship remains documented in
[`PR120_PR126_RECONCILIATION.md`](PR120_PR126_RECONCILIATION.md).

## Required closeout order

1. certify the final #133 head against its exact current base;
2. reconcile/close superseded PRs only after uniqueness proof and explicit
   GitHub authorization;
3. clean only uniquely identified Babel worktrees/clones using a deletion
   ledger;
4. refresh this ledger with the final merged SHA and cleanup inventory.

No line in this ledger is evidence that a remote merge or deletion has already
occurred. Such claims require fresh command output recorded in the final
package.
