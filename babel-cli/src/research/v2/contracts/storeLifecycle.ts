import { z } from 'zod'
import { RecordIdSchema } from './common.js'
import { MissionTerminalStateSchema } from './plan.js'

/** Terminal states the host may explicitly resume into a new research continuation run. */
export const ResumableTerminalStateSchema = z.enum([
  'cancelled',
  'interrupted',
  'needs_reconciliation',
])
export type ResumableTerminalState = z.infer<typeof ResumableTerminalStateSchema>

export const WriterOwnershipAcquireSchema = z
  .object({
    mission_id: RecordIdSchema,
    /** Must match current store writer generation (including first acquire after mission create). */
    expected_writer_generation: z.number().int().positive(),
  })
  .strict()

export const WriterOwnershipReplaceSchema = z
  .object({
    mission_id: RecordIdSchema,
    writer_generation: z.number().int().positive(),
    rationale: z.string().min(1),
  })
  .strict()

/** Host-authorized new continuation after a resumable terminal receipt; never implied by accounting. */
export const ResearchContinuationResumeSchema = z
  .object({
    mission_id: RecordIdSchema,
    expected_writer_generation: z.number().int().positive(),
    host_authorization_ref: z.string().min(1),
    /** Must match the frozen terminal receipt being continued from. */
    acknowledged_plan_revision_id: RecordIdSchema,
    acknowledged_terminal_state: ResumableTerminalStateSchema,
  })
  .strict()

export type WriterOwnershipAcquire = z.infer<typeof WriterOwnershipAcquireSchema>
export type WriterOwnershipReplace = z.infer<typeof WriterOwnershipReplaceSchema>
export type ResearchContinuationResume = z.infer<typeof ResearchContinuationResumeSchema>

export function isResumableTerminalState(
  state: z.infer<typeof MissionTerminalStateSchema>,
): state is ResumableTerminalState {
  return ResumableTerminalStateSchema.safeParse(state).success
}
