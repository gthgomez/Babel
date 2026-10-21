import type { MissionWriteContext } from '../contracts/common.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { ResearchReportV2 } from '../contracts/plan.js'
import type { ResearchStore } from '../ports/researchStore.js'
import {
  limitationsForFailedPass,
  resolveFailedPassStoppingReason,
  type ResearchPassStoppingReason,
} from './researchPassFailure.js'
import { deriveExternalOperationAccountingNotes } from './deriveExternalOperationAccountingNotes.js'
import { listFindingsFromStoreEvents } from './listFindingsFromStoreEvents.js'
import {
  deriveUnansweredPlanQuestionIds,
  planRevisionFromStoreEvents,
} from './researchReportFinalization.js'
import { deriveSearchProviderReportLimitations } from './sourceDiscoverSearchReceipt.js'

export function buildFailedPassTerminalReport(params: {
  mission: ResearchMissionV2
  planRevisionId: string
  generatedAt: string
  failurePhase: string
  message: string
  stoppingReason: ResearchPassStoppingReason
  searchProviderLimitations?: readonly string[]
  accountingNotes?: string
  unansweredQuestionIds?: readonly string[]
}): ResearchReportV2 {
  const summary = `Research pass failed during ${params.failurePhase}. ${params.message}`.slice(0, 4000)
  return {
    mission_id: params.mission.mission_id,
    plan_revision_id: params.planRevisionId,
    terminal_state: 'failed',
    answer_summary: summary,
    unanswered_questions: [...(params.unansweredQuestionIds ?? [])],
    coverage_notes: [
      'Terminal receipt recorded after admitted pass failure.',
      params.accountingNotes ??
        'External operation accounting could not be derived from store events.',
    ].join(' '),
    limitations: [
      ...limitationsForFailedPass(params.stoppingReason),
      ...(params.searchProviderLimitations ?? []),
    ],
    source_cutoff: 'unknown',
    acceptance_state: 'not_accepted',
    stopping_reason: params.stoppingReason,
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
  cause?: unknown
  now?: () => string
}): Promise<boolean> {
  const now = params.now ?? (() => new Date().toISOString())
  const stoppingReason = resolveFailedPassStoppingReason(
    params.cause ?? new Error(params.message),
    params.failurePhase,
  )
  const fence = params.store.readMissionWriteFence(params.mission.mission_id)
  if (fence.terminal_report) {
    return false
  }
  const planRevisionId =
    fence.active_plan_revision_id ?? `${params.planRevisionId}-bootstrap`
  const events = await params.store.listEvents(params.mission.mission_id)
  const searchProviderLimitations = deriveSearchProviderReportLimitations(events)
  const activePlan = planRevisionFromStoreEvents(events, planRevisionId)
  const findings = listFindingsFromStoreEvents(events)
  const unansweredQuestionIds = activePlan
    ? deriveUnansweredPlanQuestionIds(activePlan, findings)
    : []
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
      stoppingReason,
      searchProviderLimitations,
      accountingNotes: deriveExternalOperationAccountingNotes(events, params.mission.mission_id),
      unansweredQuestionIds,
    }),
  )
  return true
}
