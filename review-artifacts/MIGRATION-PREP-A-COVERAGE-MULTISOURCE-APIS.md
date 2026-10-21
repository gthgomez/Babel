# Migration prep (B branch) — A coverage + multi-source APIs

Agent A owns canonical repair. B keeps **characterization tests** until A publishes stable production APIs.

| B artifact (today) | Migrate when A ships |
|--------------------|----------------------|
| `semanticQuestionCoverage.production.reciprocal.test.ts` (`HOST_EVALUATES_QUESTION_COVERAGE`) | Question-text in semantic review + host coverage decision; flip flag and replace `capability_gap_reciprocal` blocks with acceptance assertions |
| `generalAdapterTwoCanonicalSources.actualPort.reciprocal.test.ts` (`candidates[0]` single-iteration case) | Bounded general multi-source discover/fetch in canonical loop; extend same suite against A APIs (no second controller) |
| `historical-semantic-question-coverage-gap-9d532d9b.json` | Retain as historical record; do not delete when migrating tests |

No duplicate production loop or coverage helper on B branch.
