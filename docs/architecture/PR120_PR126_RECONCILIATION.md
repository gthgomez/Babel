# PR #120 / PR #126 Reconciliation

<!--
status: ACTIVE
last_verified: 2026-08-30
-->

This record is a historical reconciliation record. The canonical recovery
candidate is now tracked separately as PR #133; this file preserves the earlier
#120/#126 evidence without claiming that either PR was merged.

## Observed bindings

| PR | state | base | head | mergeability | disposition |
| --- | --- | --- | --- | --- | --- |
| #120 | OPEN, not draft | `09882fa839253e9615a1e95ec6cd4fe81edb7871` | `73fda8d46e0cd85706d225551793946557e5c7c5` | CONFLICTING / DIRTY | superseded by the reconciled #126 candidate after final certification |
| #126 | OPEN, draft | `a997d877e8342759afefc3ca9257eb6d4d9a38a2` | `e029ca2c762cccbc9f21681ba562327e23350850` | MERGEABLE / BLOCKED | primary consolidation candidate |

At the original observation, `origin/main` was
`a997d877e8342759afefc3ca9257eb6d4d9a38a2`. A fresh observation on 2026-08-30
found `origin/main` at `c91be8ff901769958691f505b6a4fb3a0b8cd4ed` and PR #133 as
the canonical recovery candidate. Those later facts supersede the snapshot
above for merge planning, but do not rewrite its historical evidence.

## Later candidate comparison

PR #129 changed one material path:
`babel-cli/src/interactive/testing/realCliInteractiveProcess.test.ts`.
Direct local comparison of the #129 head with the #133 head shows that path is
present in #133 and its readiness handling is carried forward with additional
timeout, stream, and deterministic-exit changes. Therefore #133 supersedes the
#129 content for consolidation purposes, subject to exact-head CI and trust
certification. PR #129 remains an external open draft until an authorized
operator reconciles or closes it.

## Determination: Case A

The current #126 tree contains every material path changed by #120. The
reconciliation is not based on a filename-only assumption: the candidate tree
was compared against the complete #120 changed-path list returned by GitHub.

| #120 material paths | #126 candidate result | evidence |
| --- | --- | --- |
| `.github/workflows/typecheck.yml`, `babel-cli/package.json`, `babel-cli/src/agent/autonomousSweFoundations.test.ts`, `babel-cli/src/agent/autonomousSweHardening.test.ts`, `babel-cli/src/agent/breakerContract.ts`, `babel-cli/src/agent/executionLifecycle.ts`, `babel-cli/src/agent/taskContract.ts`, `babel-cli/src/agent/taskEventJournal.ts` | incorporated | each path is present in the #126 head tree and appears in the current #126 file list where changed |
| `babel-cli/src/authority/commandSpec.test.ts`, `babel-cli/src/authority/trustedExecutionPort.ts`, `babel-cli/src/authority/trustedExecutionSupervisor.ts` | incorporated | each path is present in the #126 head tree |
| `babel-cli/src/evidence/evidenceGraph.ts`, `babel-cli/src/evidence/independentReview.ts`, `babel-cli/src/evidence/revisionBoundReceipt.ts`, `babel-cli/src/evidence/trustedExecutionIdentity.ts`, `babel-cli/src/services/autonomousSWEArtifacts.ts` | incorporated | each path is present in the #126 head tree and the trust/evidence implementation is carried into the candidate |
| `config/independent-review-keys.json`, `scripts/verify-independent-review.mjs` | incorporated from the #126 base | both paths are present in `origin/main` and therefore inherited by the #126 head; they are trust-root dependencies, not dropped work |
| `docs/architecture/AUTONOMOUS_SWE_FOUNDATIONS_V1.md`, `docs/architecture/AUTONOMOUS_SWE_PR117_RECONCILIATION.md`, `docs/architecture/MERGE_CONTROL_PLANE_V1.md` | incorporated | each path is present in the #126 head tree |
| `scripts/agent-pr-gate-common.psm1`, `scripts/agent-pr-gate.ps1`, `tools/tests/test-agent-pr-gate.ps1` | incorporated | each path is present in the #126 head tree; exact-head gate behavior remains subject to final CI certification |

This makes #126 the superseding candidate. The old #120 branch must not be
closed or deleted until #126 (or an equivalent final candidate) has passed its
exact-head protections and the final tree has been independently inspected.
After that gate, close #120 as superseded and delete its branch only after the
cleanup uniqueness proof and deletion ledger are complete.

## SHA hygiene

The hashes above are the observed PR snapshot as of 2026-08-30. They are not
portable final-certification values. Any final PR body, review receipt,
challenge, manifest, or certification report must bind to the then-current
base and head and must not copy an older recovery or pre-rebase SHA.
