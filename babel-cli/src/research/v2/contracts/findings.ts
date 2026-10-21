import { z } from 'zod'
import { IsoDateTimeSchema, RecordIdSchema } from './common.js'
import { PlanObligationCoverageRecordSchema } from './planObligationCoverageRecords.js'

export const AssertionKindSchema = z.enum([
  'source_observation',
  'vendor_reported_result',
  'measured_result',
  'inference',
  'proposal',
])

/** Citation / hash / locator integrity — not semantic truth. */
export const SourceIntegrityStateSchema = z.enum(['valid', 'invalid', 'not_checked'])

export const SemanticSupportStatusSchema = z.enum([
  'supported',
  'contradicted',
  'insufficient',
  'not_checked',
])

export const SemanticSupportJudgmentSchema = z
  .object({
    status: SemanticSupportStatusSchema,
    reviewer: z.string().min(1),
    reviewer_version: z.string().min(1),
    rationale: z.string().min(1),
    reviewed_at: IsoDateTimeSchema,
  })
  .strict()

/** Whether a finding's assertion addresses its bound plan question (distinct from passage support). */
export const QuestionCoverageStatusSchema = z.enum([
  'answers',
  'partial',
  'tangential',
  'none',
  'not_assessed',
])

export const QuestionCoverageJudgmentSchema = z
  .object({
    status: QuestionCoverageStatusSchema,
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
    passage_ids: z.array(RecordIdSchema).min(1),
    source_integrity: SourceIntegrityStateSchema,
    semantic_support: SemanticSupportJudgmentSchema.optional(),
    question_coverage: QuestionCoverageJudgmentSchema.optional(),
    plan_obligation_coverage: z.array(PlanObligationCoverageRecordSchema).optional(),
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
