# Migration prep (B branch) — A coverage + multi-source APIs

**Integrated:** `c3c553a234b7d1f2133d40601376c723e973909d` — question text in semantic review, `question_coverage` on findings, `deriveUnansweredPlanQuestionIds` uses `answers` only.

| B artifact | Next step when A ships follow-up |
|------------|----------------------------------|
| `semanticQuestionCoverage.production.reciprocal.test.ts` | Extend when synthesis input includes `question_coverage` (A-owned small followup) |
| `missionWebRetrieval.actualPort.reciprocal.test.ts` | Tighten URL-binding assertions after abd4 repair checkpoint (do not encode faulty binding as acceptance) |
| `generalAdapterTwoCanonicalSources.actualPort.reciprocal.test.ts` | Extend for bounded multi-source loop (no second controller) |
| `historical-semantic-question-coverage-gap-9d532d9b.json` | Archival only — never acceptance criteria |

**G-L2/G-L3 handoff for A (absent at abd4):** campaign missions + expected outcomes + portable preflight — see `review-artifacts/PROPOSED-B-CAMPAIGN-PREFLIGHT-SHARED.md` and `babel-cli/src/research/v2/fixtures/campaign/G-L{2,3}-*`.

No duplicate production loop or coverage helper on B branch.
