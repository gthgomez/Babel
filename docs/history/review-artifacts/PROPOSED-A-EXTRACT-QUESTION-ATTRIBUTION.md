# PROPOSED typed question-attribution contract (Agent A adoption)

**Agent B:** specification + reciprocal tests in `extractQuestionAttribution.proposed.contract.test.ts` only.
**No** production mapper on B branch after handoff.

## Problem (legacy — executed)

`ExtractFindingsOutputSchema` findings omit `question_id`. Production `findingsFromExtractModelOutput`
binds every row to `plan.questions[0].question_id` (see `extractQuestionAttribution.legacy.reciprocal.test.ts`).

## Target contract (A-owned production)

```typescript
// modelOutputs.ts — extract_findings.findings[] (PROPOSED)
{
  assertion_text: string
  assertion_kind: AssertionKind
  passage_ids: string[]
  question_id: string // REQUIRED — must match an active plan.questions[].question_id
}
```

### Host rules (A implements in mapper + prompt + synthesis preservation)

1. **Validate** each `question_id` ∈ active plan question ids; **unknown ids rejected** (fail closed).
2. **No Q1 fallback**, no inferred cross-question coverage from a single binding.
3. **`FindingRecord.question_id` preserved** through `applySemanticSupportReview` and into report
   `deriveUnansweredPlanQuestionIds` / synthesis inputs (already true for question_id field; extract must populate correctly).
4. **Per-question** `semantic_support` (`supported` / `insufficient` / `contradicted`) drives unanswered
   and partial terminal state independently.

Reference validator (test-only mirror): `testSupport/proposedExtractQuestionAttributionContract.ts`

## Proposed vs executed tests

| Suite | Status | Role |
|-------|--------|------|
| `extractQuestionAttribution.proposed.contract.test.ts` | PROPOSED (passes on testSupport schema) | two-question success, unknown-id rejection, per-question semantic/unanswered |
| `extractQuestionAttribution.legacy.reciprocal.test.ts` | EXECUTED (production) | documents current schema + Q[0] binding |
| `findingsFromModelOutput.extractBinding.test.ts` | EXECUTED | single-plan Q[0] binding |

## Campaign fixtures (B-owned, not G-DEV relabel)

- **G-L2:** `fixtures/campaign/G-L2-mission.json` + `G-L2-expected-outcomes.json`
- **G-L3:** `fixtures/campaign/G-L3-mission.json` + `G-L3-expected-outcomes.json`
- Preflight: `npm run test:research-v2-g-l2-preflight` / `test:research-v2-g-l3-preflight` (OpenRouter lane, no model)

## Preserved checkpoints

- Finalizer GO: `08cc2986507b7549be04fe6d49ccfc995080e351`
- One-question partial predicate: `6c51bbed`
- Attempt4 evidence: `review-artifacts/general-g-l1-attempt4-evidence-subset.json`
- Inventory: `review-artifacts/general-acceptance-G-L2-G-L3-X-L1-inventory.json` (`46ad6767`+)
