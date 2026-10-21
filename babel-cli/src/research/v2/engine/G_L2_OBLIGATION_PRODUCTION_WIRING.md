# G-L2 obligation API — production wiring status (B report, 95a87054)

**Integrated:** `planCoverageObligations`, `enforceBoundQuestionCoverageOnFindings` (plan `coverage_obligations` + `coverage_source_slot`), review rubric via `buildSemanticSupportReviewInput`, e2e `applySemanticSupportReview` with store sources/revisions.

**Not yet wired (no duplicate planner on B):**

| Stage | Gap |
| --- | --- |
| `buildPlanRevisionFromPlanQuestions` | Model `plan_questions` output is not mapped to `coverage_obligations`; live diagnostic subset plan rows have none. |
| Retrieval persist (`researchRetrievalLoop` / adapters) | `SourceRecord.coverage_source_slot` is not stamped from mission policy or selected web refs. |
| Live replay | Bound enforcement is inert until host supplies obligations + slots (see wiring reciprocal test on immutable subset). |

**Labelled acceptance bytes:** `g-l2-original-derived-regression.fixture.json` + `gL2OriginalDerivedRegression.ts` supply obligations/slots for typed regression without mutating live evidence.
