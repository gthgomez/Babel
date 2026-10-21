/**
 * PROPOSED contract (Agent A adoption). Not wired to production modelOutputs.ts or mapper.
 */
import { z } from 'zod'
import type { PlanRevision } from '../../contracts/plan.js'

export const ProposedExtractFindingRowSchema = z
  .object({
    assertion_text: z.string().min(1),
    assertion_kind: z.enum([
      'source_observation',
      'vendor_reported_result',
      'measured_result',
      'inference',
      'proposal',
    ]),
    passage_ids: z.array(z.string().min(1)).min(1),
    question_id: z.string().min(1),
  })
  .strict()

export const ProposedExtractFindingsOutputSchema = z
  .object({
    kind: z.literal('extract_findings'),
    findings: z.array(ProposedExtractFindingRowSchema).min(1),
  })
  .strict()

export class ExtractQuestionAttributionError extends Error {
  readonly code = 'extract_question_attribution_invalid'
}

/** Reject unknown question_id; no fallback to plan.questions[0]. */
export function assertExtractQuestionIdsAdmittedByPlan(
  plan: PlanRevision,
  rows: readonly { question_id: string }[],
): void {
  const admitted = new Set(plan.questions.map((q) => q.question_id))
  for (const row of rows) {
    if (!admitted.has(row.question_id)) {
      throw new ExtractQuestionAttributionError(
        `extract finding question_id not in plan: ${row.question_id}`,
      )
    }
  }
}
