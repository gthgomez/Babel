# G-L2 quality fixtures (original-derived, for A canonical reviewer)

Labeled offline slices derived from the immutable diagnostic-1 evidence subset. They are **not** acceptance substitutes for live G-L2 and **must not** edit stored subset rows or judgments.

| Label | Fixture | Plan question | Finding (subset) |
| --- | --- | --- | --- |
| `G_L2_QUALITY_CASE1_CROSS_SOURCE_MAX_AGE` | `G-L2-quality-case1-cross-source-max-age.fixture.json` | `…-3` (max-age agreement/difference) | `finding-7f3b2733cd9d640be75867f5` |
| `G_L2_QUALITY_CASE2_AUDIENCE_VS_CACHE_SCOPE` | `G-L2-quality-case2-audience-vs-cache-scope.fixture.json` | `…-4` (audience + max-age citation inventory) | `finding-a0cf246d49ce566335d79122` |

**Subset pin:** `review-artifacts/general-g-l2-diagnostic-1-evidence-subset.json` (snapshot SHA in each fixture).

**Reciprocal tests:** `babel-cli/src/research/v2/engine/gL2Diagnostic1Quality.originalDerived.reciprocal.test.ts` — loads original rows via `loadGL2Diagnostic1EvidenceSubset()`, applies expected rubric only through production `applySemanticSupportReview` + `researchReportFinalization` helpers.

**Ownership:** Agent A — review contract / runtime after durable lineage repair. Agent B — fixtures and reciprocal tests only (no duplicate semantic implementation).
