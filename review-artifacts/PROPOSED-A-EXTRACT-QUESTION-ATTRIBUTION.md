# Extract `question_id` contract — adopted on draft PR 406

**Production checkpoint:** `b0194564c1a0934e0a11da614f4fda2f798b7a0d` (draft #406).

**Agent B branch integration:** production mapper + schema from A; B-owned typed tests in
`extractQuestionAttribution.production.contract.test.ts` and `findingsFromModelOutput.extractBinding.test.ts`.
Historical pre-adoption Q[0] host binding is **nonacceptance evidence only**:
`review-artifacts/historical-extract-question-id-q0-host-binding.json` (not a regression target).

## Production contract

```typescript
// modelOutputs.ts — extract_findings.findings[]
{
  assertion_text: string
  assertion_kind: AssertionKind
  passage_ids: string[]
  question_id: string // REQUIRED — must match an active plan.questions[].question_id
}
```

### Host rules (A-owned runtime)

1. **Validate** each `question_id` ∈ active plan question ids; **unknown ids rejected** (fail closed).
2. **No Q1 fallback**; legacy rows missing `question_id` fail Zod parse.
3. **`plan_questions`** supplied on extract invocation; **`question_id` preserved** in synthesis input.
4. Per-question `semantic_support` drives unanswered / partial terminal state independently.

## B executed tests (post-integration)

| Suite | Role |
|-------|------|
| `extractQuestionAttribution.production.contract.test.ts` | two-question success, unknown/missing rejection, per-question insufficient/contradicted unanswered |
| `findingsFromModelOutput.extractBinding.test.ts` | mapper validates plan membership |
| `reportFinalizationEvidence.attempt4.regression.test.ts` | preserves ORIGINAL attempt4 bytes; legacy extract shape rejected |

## Campaign fixtures (B-owned)

- **G-L2 / G-L3:** `fixtures/campaign/*` + portable preflight (`3f9754fc` runner)
- Preflight coordination: `review-artifacts/PROPOSED-B-CAMPAIGN-PREFLIGHT-SHARED.md`

## Semantic question coverage (A `c3c553a`)

Production: bound `question_text` in semantic review input; judgments carry separate `question_coverage`
(`answers` / `partial` / `tangential` / `none`); durable `FindingRecord.question_coverage`; unanswered requires
`supported` + `answers`. Legacy `not_assessed` cannot close coverage.

B reciprocal tests: `semanticQuestionCoverage.production.reciprocal.test.ts`, `durableResearchStore.questionCoverage.conformance.test.ts`.
Pre-c3c553a gap characterization: `historical-semantic-question-coverage-gap-9d532d9b.json` only.

**A followup:** include `question_coverage` on synthesis input (B does not implement).

## Preserved checkpoints

- Finalizer GO: `08cc2986507b7549be04fe6d49ccfc995080e351`
- Attempt4 evidence subset: `review-artifacts/general-g-l1-attempt4-evidence-subset.json` (unchanged bytes)
