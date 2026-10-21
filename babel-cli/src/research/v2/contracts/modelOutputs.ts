import { z } from 'zod'
import { PlanCoverageObligationSchema } from './plan.js'

export const ResearchModelOperationKindSchema = z.enum([
  'plan_questions',
  'extract_findings',
  'semantic_support_review',
  'synthesize_report',
])
export type ResearchModelOperationKind = z.infer<typeof ResearchModelOperationKindSchema>

export const PlanQuestionsOutputSchema = z
  .object({
    kind: z.literal('plan_questions'),
    questions: z.array(
      z
        .object({
          text: z.string().min(1),
          importance: z.enum(['critical', 'high', 'medium', 'low']),
          evidence_requirement: z.string().min(1).optional(),
          coverage_obligations: z.array(PlanCoverageObligationSchema).optional(),
        })
        .strict(),
    ),
  })
  .strict()

export const ExtractFindingsOutputSchema = z
  .object({
    kind: z.literal('extract_findings'),
    findings: z.array(
      z
        .object({
          assertion_text: z.string().min(1),
          assertion_kind: z.enum([
            'source_observation',
            'vendor_reported_result',
            'measured_result',
            'inference',
            'proposal',
          ]),
          passage_ids: z.array(z.string().min(1)),
          /** Required; must match an active plan question id (no legacy Q[0] fallback). */
          question_id: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()

export const SemanticSupportReviewOutputSchema = z
  .object({
    kind: z.literal('semantic_support_review'),
    judgments: z.array(
      z
        .object({
          finding_id: z.string().min(1),
          status: z.enum(['supported', 'contradicted', 'insufficient', 'not_checked']),
          rationale: z.string().min(1),
          /**
           * Whether the assertion addresses the bound plan question text (not citation support alone).
           */
          question_coverage: z.enum(['answers', 'partial', 'tangential', 'none']),
          claimed_source_attribution: z
            .enum([
              'matches_admitted_citations',
              'names_unfetched_or_unread_source',
              'not_assessed',
            ])
            .optional(),
          obligation_coverage: z
            .array(
              z
                .object({
                  obligation_id: z.string().min(1),
                  status: z.enum(['met', 'unmet', 'wrong_aspect']),
                  supporting_passage_ids: z.array(z.string().min(1)).optional(),
                })
                .strict(),
            )
            .optional(),
        })
        .strict(),
    ),
  })
  .strict()

export const SynthesizeReportOutputSchema = z
  .object({
    kind: z.literal('synthesize_report'),
    answer_summary: z.string().min(1),
    stopping_reason: z.string().min(1),
  })
  .strict()

const OUTPUT_SCHEMAS: Record<ResearchModelOperationKind, z.ZodType<Record<string, unknown>>> = {
  plan_questions: PlanQuestionsOutputSchema,
  extract_findings: ExtractFindingsOutputSchema,
  semantic_support_review: SemanticSupportReviewOutputSchema,
  synthesize_report: SynthesizeReportOutputSchema,
}

export function modelOutputSchemaForKind(
  operationKind: ResearchModelOperationKind,
): z.ZodType<Record<string, unknown>> {
  return OUTPUT_SCHEMAS[operationKind]
}

export function parseValidatedModelOutput(
  operationKind: ResearchModelOperationKind,
  raw: unknown,
): Record<string, unknown> {
  return modelOutputSchemaForKind(operationKind).parse(raw) as Record<string, unknown>
}
