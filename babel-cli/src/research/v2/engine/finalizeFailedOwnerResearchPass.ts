import type { MissionWriteContext } from '../contracts/common.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { ResearchReportV2 } from '../contracts/plan.js'
import type { ResearchStore } from '../ports/researchStore.js'

export function buildFailedPassTerminalReport(params: {
  mission: ResearchMissionV2
  planRevisionId: string
  generatedAt: string
  failurePhase: string
  message: string
}): ResearchReportV2 {
  const summary = `Research pass failed during ${params.failurePhase}. ${params.message}`.slice(0, 4000)
  return {
    mission_id: params.mission.mission_id,
    plan_revision_id: params.planRevisionId,
    terminal_state: 'failed',
    answer_summary: summary,
    unanswered_questions: [],
    coverage_notes:
      'Terminal receipt recorded after admitted pass failure; external operations retain settled failure accounting.',
    limitations: ['pass_failed_before_retrieval_or_synthesis'],
    source_cutoff: 'unknown',
    acceptance_state: 'not_accepted',
    stopping_reason: 'provider_invoke_failed',
    finding_ids: [],
    citation_passage_ids: [],
    generated_at: params.generatedAt,
  }
}

/**
 * Persist an honest failed terminal receipt when a pass aborts without synthesis (e.g. planning Zod failure).
 */
export async function finalizeFailedOwnerResearchPass(params: {
  store: ResearchStore
  mission: ResearchMissionV2
  planRevisionId: string
  failurePhase: string
  message: string
  now?: () => string
}): Promise<boolean> {
  const now = params.now ?? (() => new Date().toISOString())
  const fence = params.store.readMissionWriteFence(params.mission.mission_id)
  if (fence.terminal_report) {
    return false
  }
  const planRevisionId =
    fence.active_plan_revision_id ?? `${params.planRevisionId}-bootstrap`
  const ctx: MissionWriteContext = {
    mission_id: params.mission.mission_id,
    plan_revision_id: planRevisionId,
    writer_generation: fence.writer_generation,
  }
  await params.store.appendTerminalReport(
    ctx,
    buildFailedPassTerminalReport({
      mission: params.mission,
      planRevisionId,
      generatedAt: now(),
      failurePhase: params.failurePhase,
      message: params.message,
    }),
  )
  return true
}
