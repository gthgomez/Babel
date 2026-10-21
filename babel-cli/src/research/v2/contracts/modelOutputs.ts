import { z } from 'zod'

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
