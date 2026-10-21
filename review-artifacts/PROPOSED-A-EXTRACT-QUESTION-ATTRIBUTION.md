# PROPOSED typed question-attribution contract (Agent A adoption)

**Agent B:** specification + reciprocal test proposals only — **no** duplicate mapper/controller in B branch.

## Problem

`ExtractFindingsOutputSchema` findings omit `question_id`. Host maps all rows to `plan.questions[0].question_id`
(`findingsFromModelOutput.ts`). Multi-question plans therefore **honestly report** open sibling questions but
**cannot** record extract-phase attribution per plan question.

## Smallest contract extension

Add optional attribution on each extract finding (exactly one required at host parse time):

```typescript
// modelOutputs.ts — extract_findings.findings[]
{
  assertion_text: string
  assertion_kind: AssertionKind
  passage_ids: string[]
  question_id?: string  // MUST match a plan.questions[].question_id when present
}
```

**Host rules (findingsFromExtractModelOutput — A-owned):**

1. If `question_id` present → validate ∈ active plan question ids; else throw structured parse error.
2. If absent → bind to `plan.questions[0].question_id` **and** emit host limitation
   `extract_question_binding_defaulted:first_plan_question` once per extract op (report finalization already partial-friendly).
3. No silent reassignment across questions.

**Prompt contract:** `modelOutputContractPrompt.ts` extract_findings section lists plan questions with stable ids
(host supplies `question_id` list in extract input payload).

## Proposed tests for A (not implemented on B)

| Test | Assert |
|------|--------|
| `ExtractFindingsOutputSchema` | accepts optional `question_id`; rejects unknown id when strict host wrapper applied |
| `findingsFromExtractModelOutput` | two findings with distinct valid `question_id` → two plan questions answered |
| `findingsFromExtractModelOutput` | omitted `question_id` → `questions[0]` + limitation token (or single default flag on op receipt) |
| `deriveUnansweredPlanQuestionIds` integration | q1+q2 supported on correct ids → only q3…unanswered |
| Reciprocal (fixture) | replay extract JSON with per-question bindings; no live API |

## Preserved B checkpoints (unchanged)

- Finalizer GO: `08cc2986507b7549be04fe6d49ccfc995080e351`
- Single-question partial predicate: `6c51bbed`
- Attempt4 evidence: `review-artifacts/general-g-l1-attempt4-evidence-subset.json`
