# B → A handoff: obligation_coverage judgment integrity (`4e9b5f70`)

**Status:** B branch `cursor/agent-b-general-fixtures-f617` @ **`4e9b5f7098e2bfd33fdd04fe9c1e58ca21dbdf44`**.  
**No further B edits** to shared host-bound / semantic production files until A reconciles (A is active on the same surface).

**A newest read-only checkpoint (PR #406 branch):**  
`origin/cursor/research-v2-post-review-settlement-fc31` @ **`d490dced8b5679e72115288c6b3fcc7b2ddfe37d`** (tree `68ed3cada2f5fc4d5c3bec75d8a8d0a92e2d2cff`).

## B production delta to adopt or supersede (`4e9b5f70` only)

| Path | Role |
| --- | --- |
| `babel-cli/src/research/v2/engine/obligationCoverageJudgmentIntegrity.ts` | **New.** `collectObligationCoverageJudgmentIntegrityIssues` — validates raw `obligation_coverage` before host assessment filters passage ids. |
| `babel-cli/src/research/v2/engine/obligationCoverageHostBound.ts` | Early integrity gate; still calls `passageSupportsObligationCompleteness` (topic regex) after integrity passes. |
| `babel-cli/src/research/v2/engine/boundQuestionCoverageFromEvidence.ts` | `judgmentIntegrityIssues` on assessment + host rationale prefix `obligation_coverage judgment integrity failed`. Reviewer version `0.3.0-obligation-judgments`. |

**Not modified in `4e9b5f70`:** `findingsFromModelOutput.ts`, `planCoverageObligations.ts`, `semanticObligationCoverageValidation.ts` (does not exist on B).

## B tests + wiring to preserve (do not move semantics into test-support)

| Path | Role |
| --- | --- |
| `babel-cli/src/research/v2/engine/gL2ObligationJudgmentIntegrity.boundCoverage.reciprocal.test.ts` | Production planner + `stampCoverageSourceSlotOnSource`; bounded negatives + positive control + regex-gap characterization. |
| `babel-cli/src/research/v2/engine/obligationCoverageJudgmentIntegrity.test.ts` | Unit: absent passage id flagged before filter. |
| `babel-cli/package.json` | `test:research-v2-g-l2-bound-coverage` includes the two files above (31 tests at `4e9b5f70`). |
| `babel-cli/src/research/v2/engine/g-l2-obligation-wiring-bound-coverage.tap.txt` | Frozen TAP @ 31/31 exit 0. |
| `babel-cli/src/research/v2/engine/g-l2-obligation-wiring-5d822856-receipt.json` | Receipt metadata (update `verification_head` when reconciling). |

**Earlier reciprocal suite (unchanged by `4e9b5f70` production):**  
`gL2Diagnostic1Quality.boundCoverage.reciprocal.test.ts`, `reportFinalizationEvidence.gL2.regression.test.ts`, `boundQuestionCoverageFromEvidence.test.ts`, `planCoverageObligations.test.ts`.

## A `d490dced` read-only comparison (canonical direction)

| A production (d490dced) | B equivalent / note |
| --- | --- |
| `semanticObligationCoverageValidation.ts` (**new**) | Validates **before persistence** in `applySemanticSupportReview`; fail-closed; clears `plan_obligation_coverage` on violation. |
| `findingsFromModelOutput.ts` | Calls `validateSemanticObligationCoverageResponse` + `conservativeQuestionCoverageAfterObligationResponseViolation`. |
| `semanticObligationCoverageValidation.test.ts` (**new**) | A-native tests for same bounded negatives. |
| `obligationCoverageHostBound.ts` | **No** `obligationCoverageJudgmentIntegrity`; **no** `passageSupportsObligationCompleteness`; uses `obligationCitationStructuralCompleteness` (truncation/slot/inline only). |
| `boundQuestionCoverageFromEvidence.ts` | Reviewer `0.3.1-obligation-response-validation`; no `judgmentIntegrityIssues` field. |

### Violation vocabulary (reconcile assertions)

| B integrity token (`4e9b5f70` rationale) | A `ObligationCoverageResponseViolation` |
| --- | --- |
| `absent_passage_id:<id>` | `unknown_passage_id` (detail: `unknown passage_id <id>…`) |
| `foreign_passage_id:<id>` | `foreign_passage_id` |
| `duplicate_obligation_id:<id>` | `duplicate_obligation_id` |
| `unknown_obligation_id:<id>` | `unknown_obligation_id` |

A rationale pattern: `Host rejected obligation_coverage response (<violation>): <detail>.`

### Reciprocal test alignment after A merge (typed, test-only edits on B)

1. **`gL2ObligationJudgmentIntegrity.boundCoverage.reciprocal.test.ts`** — keep scenarios; relax `assert.match` to accept **either** B integrity tokens **or** A `Host rejected obligation_coverage response` + violation enum (see `gL2ObligationWiringAReconciliation.alignment.test.ts`).
2. **Regex characterization subtest** — on A structural host bound, replace with assertion that `obligationCitationStructuralCompleteness` allows Cache-Control-only overview when model claims `met` (7f3 defect moves to **model judgment + structural truncation**, not regex).
3. **`obligationCoverageJudgmentIntegrity.test.ts`** — drop or repoint to A `semanticObligationCoverageValidation.test.ts` once B deletes B-only module.
4. **Do not** duplicate validation in `testSupport/`; call production `validateSemanticObligationCoverageResponse` after cherry-pick.

## Lineage durable matrix

**Closed** @ `73c5478c` (24/24). No further lineage reruns on B.

## Suggested A merge order

1. Take A `d490dced` production as canonical for validation + host bound (supersedes B `obligationCoverageJudgmentIntegrity.ts` + host-bound hook).
2. Cherry-pick or transplant B reciprocal tests; apply alignment row 1–3 above.
3. Remove B-only `obligationCoverageJudgmentIntegrity.ts` when A validator is present (avoid double validation).
