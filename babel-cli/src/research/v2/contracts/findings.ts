import { z } from 'zod'
import { IsoDateTimeSchema, RecordIdSchema } from './common.js'

export const AssertionKindSchema = z.enum([
  'source_observation',
  'vendor_reported_result',
  'measured_result',
  'inference',
  'proposal',
])

export const SourceIntegrityResultSchema = z.enum([
  'supported',
  'contradicted',
  'insufficient',
  'not_checked',
])

export const SemanticSupportJudgmentSchema = z
  .object({
    status: SourceIntegrityResultSchema,
    reviewer: z.string().min(1),
    reviewer_version: z.string().min(1),
    rationale: z.string().min(1),
    reviewed_at: IsoDateTimeSchema,
  })
  .strict()

export const FindingRecordSchema = z
  .object({
    finding_id: RecordIdSchema,
    question_id: RecordIdSchema,
    assertion_text: z.string().min(1),
    assertion_kind: AssertionKindSchema,
    passage_ids: z.array(RecordIdSchema),
    source_integrity: SourceIntegrityResultSchema,
    semantic_support: SemanticSupportJudgmentSchema.optional(),
    assumption_ids: z.array(RecordIdSchema).optional(),
    conflicting_finding_ids: z.array(RecordIdSchema).optional(),
    calculation_ref: z.string().optional(),
    benchmark_fields: z
      .object({
        dataset: z.string().optional(),
        metric: z.string().optional(),
        model_revision: z.string().optional(),
        evaluator: z.string().optional(),
        configuration: z.string().optional(),
      })
      .strict()
      .optional(),
    created_at: IsoDateTimeSchema,
    revised_at: IsoDateTimeSchema.optional(),
  })
  .strict()

export type FindingRecord = z.infer<typeof FindingRecordSchema>
