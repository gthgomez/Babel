# PROPOSED bounded repair for Agent A adoption (draft406)

Agent **A** owns production semantics on `researchReportFinalization.ts` and
`buildSynthesizedResearchReport.ts`. Agent **B** supplies this bounded candidate for
explicit review/adoption — not a parallel runtime.

## Checkpoints

| Role | SHA | Notes |
|------|-----|--------|
| A canonical base | `fef78559dc4a2e45ee4356c6d4269123d5a2941b` | Cherry-picked honest finalizer on B branch |
| **B corrected candidate (production on PR #404)** | **`08cc2986`** (superseded by handoff commit after reconciliation) | Full correction in shared runtime + reciprocal tests |

After handoff commit lands, use **`git rev-parse HEAD`** on `cursor/agent-b-general-fixtures-f617` for the
authoritative corrected candidate SHA (content matches `08cc2986` production finalizer).

## Bounded delta for A (apply or reconcile)

```text
review-artifacts/proposed-a-fef78559-report-finalization-correction.patch
```

```bash
git diff fef78559dc4a2e45ee4356c6d4269123d5a2941b -- \
  babel-cli/src/research/v2/engine/researchReportFinalization.ts \
  babel-cli/src/research/v2/engine/buildSynthesizedResearchReport.ts
```

## Delta summary

1. `deriveVerifiedEvidenceLimitations` — integrity, missing passage, absent revision, incomplete revision completeness.
2. `deriveTerminalState` / `deriveSinglePassStoppingReason` — `evidenceVerificationLimitations` + runtime `additionalLimitations`.
3. `deriveSourceCutoffFromRevisions` — instant compare + UTC normalize; `unknown` when invalid/absent.

## B reciprocal tests (real runtime)

- `researchReportFinalization.test.ts` (A baseline from `fef78559`)
- `researchReportFinalization.nativeReview.regression.test.ts`
- `reportFinalizationEvidence.attempt4.regression.test.ts` + `testSupport/attempt4EvidenceSubset.ts` (load only)

Attempt4 evidence: `review-artifacts/general-g-l1-attempt4-evidence-subset.json`

**No further B edits to shared finalizer after this handoff** unless A requests reconciliation.
