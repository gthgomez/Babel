# PR #120 / PR #126 Reconciliation

<!--
status: ACTIVE
last_verified: 2026-08-30
-->

This record is a live GitHub snapshot, not a final merge claim. It must be
refreshed after the final candidate head exists.

## Observed bindings

| PR | state | base | head | mergeability | disposition |
| --- | --- | --- | --- | --- | --- |
| #120 | OPEN, not draft | `09882fa839253e9615a1e95ec6cd4fe81edb7871` | `73fda8d46e0cd85706d225551793946557e5c7c5` | CONFLICTING / DIRTY | superseded by the reconciled #126 candidate after final certification |
| #126 | OPEN, draft | `a997d877e8342759afefc3ca9257eb6d4d9a38a2` | `e029ca2c762cccbc9f21681ba562327e23350850` | MERGEABLE / BLOCKED | primary consolidation candidate |

At the same observation, `origin/main` was
`a997d877e8342759afefc3ca9257eb6d4d9a38a2`. The open-PR query returned #120
and #126; no other open PR was included in that query.

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
