import { z } from 'zod'
import { IsoDateTimeSchema, RecordIdSchema, UnknownValueSchema } from './common.js'
import { FindingRecordSchema } from './findings.js'
import { PassageRecordSchema } from './passages.js'
import { SourceRecordSchema, SourceRevisionSchema } from './sources.js'
import { ResearchMissionV2Schema } from './mission.js'

export const QuestionStatusSchema = z.enum([
  'open',
  'partially_answered',
  'answered',
  'blocked',
  'exhausted',
])

export const QuestionRecordSchema = z
  .object({
    question_id: RecordIdSchema,
    text: z.string().min(1),
    importance: z.enum(['critical', 'high', 'medium', 'low']),
    evidence_requirement: z.string().min(1),
    status: QuestionStatusSchema,
    next_gap: z.string().optional(),
  })
  .strict()

export const PlanRevisionSchema = z
  .object({
    plan_revision_id: RecordIdSchema,
    mission_id: RecordIdSchema,
    created_at: IsoDateTimeSchema,
    questions: z.array(QuestionRecordSchema).min(1),
    revision_reason: z.string().min(1),
  })
  .strict()

export const MissionTerminalStateSchema = z.enum([
  'complete',
  'partial',
  'blocked',
  'failed',
  'cancelled',
  'interrupted',
  'needs_reconciliation',
])

export const ResearchReportV2Schema = z
  .object({
    mission_id: RecordIdSchema,
    plan_revision_id: RecordIdSchema,
    terminal_state: MissionTerminalStateSchema,
    answer_summary: z.string().min(1),
    competing_explanations: z.array(z.string()).optional(),
    unanswered_questions: z.array(RecordIdSchema),
    coverage_notes: z.string().min(1),
    limitations: z.array(z.string()),
    source_cutoff: UnknownValueSchema,
    acceptance_state: z.string().min(1),
    stopping_reason: z.string().min(1),
    finding_ids: z.array(RecordIdSchema),
    citation_passage_ids: z.array(RecordIdSchema),
    generated_at: IsoDateTimeSchema,
  })
  .strict()

/** Snapshot bundle for inspect/resume reconstruction (logical, not storage format). */
export const ResearchStateSnapshotV2Schema = z
  .object({
    mission: ResearchMissionV2Schema,
    plan: PlanRevisionSchema,
    sources: z.array(SourceRecordSchema),
    source_revisions: z.array(SourceRevisionSchema),
    passages: z.array(PassageRecordSchema),
    findings: z.array(FindingRecordSchema),
    report: ResearchReportV2Schema.optional(),
  })
  .strict()

export type QuestionRecord = z.infer<typeof QuestionRecordSchema>
export type PlanRevision = z.infer<typeof PlanRevisionSchema>
export type ResearchReportV2 = z.infer<typeof ResearchReportV2Schema>
export type ResearchStateSnapshotV2 = z.infer<typeof ResearchStateSnapshotV2Schema>
