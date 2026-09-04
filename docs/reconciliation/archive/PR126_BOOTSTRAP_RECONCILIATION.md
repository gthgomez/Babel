<!--
status: ARCHIVED_SUPERSEDED
archived: 2026-09-04
superseded_by: ../BABEL_PR_RECONCILIATION_CURRENT.md
-->

# PR #126 Bootstrap Reconciliation

<!--
status: ACTIVE
last_verified: 2026-08-30
-->

The current live binding is recorded in
[`docs/architecture/PR120_PR126_RECONCILIATION.md`](docs/architecture/PR120_PR126_RECONCILIATION.md).
At that snapshot, #126 targets `main` at
`a997d877e8342759afefc3ca9257eb6d4d9a38a2` and its head is
`e029ca2c762cccbc9f21681ba562327e23350850`.

The trusted bootstrap must materialize gate source from the immutable base
revision, inspect the candidate only as data, and require the candidate head to
match the explicitly reviewed head. It must not accept a recovery ref,
floating branch, or caller-provided bypass as a substitute for the PR base.

The #120 trust/evidence paths are present in the current #126 tree: the
independent-review registry and verifier are inherited from the #126 base, and
the supervisor/read-port and independent-review implementation are in the
candidate. This is the Case A reconciliation; #120 remains open only until the
certified #126 result is ready to supersede it.

This document intentionally records a snapshot rather than claiming that the
remote PR has already been merged. Refresh the hashes and disposition after
the final exact-head gate.
