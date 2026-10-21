# G-L2 obligation API — production wiring status (B report)

**Integrated (27512ba1, docs 5d822856):**

| Stage | Status |
| --- | --- |
| `buildPlanRevisionFromPlanQuestions` | Persists validated `coverage_obligations` from `plan_questions` model output; rejects unknown mission slots (`PlanCoverageObligationValidationError`). |
| `missionCoverageSourceSlots` / retrieval | `stampCoverageSourceSlotOnSource` in `researchRetrievalLoop` and `researchComposedRetrievalLoop` stamps `coverage_source_slot` from slot topology (`web-ref-N`, etc.). |
| Review + host bound | `applySemanticSupportReview` → `enforceBoundQuestionCoverageOnFindings`; `collectObligationCoverageJudgmentIntegrityIssues` rejects absent/foreign passage ids, duplicate/unknown obligation rows (safe partial); `assessObligationCoverageHostBound` still calls `passageSupportsObligationCompleteness` regex until A ships per-obligation semantic judgments. |
| Finalizer | `buildSynthesizedResearchReport` + `deriveUnansweredPlanQuestionIds` conservative partial terminal state when q3/q4 downgraded. |

**Preserved historical evidence (unchanged bytes):**

- Immutable live diagnostic subset (`loadGL2Diagnostic1EvidenceSubset`) — no plan obligations, no stamped slots (pre-wiring red).
- Labelled `g-l2-original-derived-regression.fixture.json` — frozen passage/finding text with legacy slot ids (`comparison_mdn`, …) for regression without mutating live artifacts.

**B reciprocal tests:** `gL2Diagnostic1Quality.boundCoverage.reciprocal.test.ts` exercises production planner + stamped sources on original-derived wording; `reportFinalizationEvidence.gL2.regression.test.ts` retains labelled-fixture finalizer cases (renamed slot, non-cache negatives, positive control).
