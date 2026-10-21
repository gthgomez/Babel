import type { MissionWriteContext } from '../contracts/common.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { ResearchReportV2 } from '../contracts/plan.js'
import type { ExternalOperationIntent } from '../contracts/operations.js'
import type { ResearchStore, ResearchStoreEvent } from '../ports/researchStore.js'
import { deriveSearchProviderReportLimitations } from './sourceDiscoverSearchReceipt.js'
import { settleExternalOperation, unknownUsageSettlement } from './settleExternalOperation.js'
import { settleModelOperation } from './settleModelOperation.js'

function operationKey(missionId: string, operationId: string, attemptId: string): string {
  return `${missionId}::${operationId}::${attemptId}`
}

function unsettledOperationIntents(
  events: readonly ResearchStoreEvent[],
  missionId: string,
): ExternalOperationIntent[] {
  const intents = new Map<string, ExternalOperationIntent>()
  const completed = new Set<string>()
  for (const event of events) {
    if (event.missionId !== missionId) continue
    if (event.kind === 'external_operation_intent') {
      const intent = (event.payload as { intent?: ExternalOperationIntent }).intent
      if (!intent) continue
      intents.set(operationKey(intent.mission_id, intent.operation_id, intent.attempt_id), intent)
    }
    if (event.kind === 'external_operation_completed') {
      const completion = (event.payload as {
        completion?: { mission_id: string; operation_id: string; attempt_id: string }
      }).completion
      if (!completion) continue
      completed.add(
        operationKey(completion.mission_id, completion.operation_id, completion.attempt_id),
      )
    }
  }
  return [...intents.values()].filter(
    (intent) => !completed.has(operationKey(intent.mission_id, intent.operation_id, intent.attempt_id)),
  )
}

function buildCancelledTerminalReport(params: {
  mission: ResearchMissionV2
  planRevisionId: string
  generatedAt: string
  searchProviderLimitations?: readonly string[]
}): ResearchReportV2 {
  return {
    mission_id: params.mission.mission_id,
    plan_revision_id: params.planRevisionId,
    terminal_state: 'cancelled',
    answer_summary: 'Owner session cancelled before research pass completed.',
    unanswered_questions: [],
    coverage_notes: 'cancelled during admitted engine pass',
    limitations: [...(params.searchProviderLimitations ?? [])],
    source_cutoff: 'unknown',
    acceptance_state: 'not_accepted',
    stopping_reason: 'user_cancel',
    finding_ids: [],
    citation_passage_ids: [],
    generated_at: params.generatedAt,
  }
}

/**
 * When an owner run aborts, settle dangling external operations and persist a cancelled terminal receipt.
 */
export async function finalizeOwnerResearchRunCancellation(params: {
  store: ResearchStore
  mission: ResearchMissionV2
  now?: () => string
}): Promise<boolean> {
  const now = params.now ?? (() => new Date().toISOString())
  const fence = params.store.readMissionWriteFence(params.mission.mission_id)
  if (fence.terminal_report) {
    return false
  }
  const planRevisionId = fence.active_plan_revision_id
  if (!planRevisionId) {
    return false
  }
  const ctx: MissionWriteContext = {
    mission_id: params.mission.mission_id,
    plan_revision_id: planRevisionId,
    writer_generation: fence.writer_generation,
  }
  let events = await params.store.listEvents(params.mission.mission_id)
  for (const intent of unsettledOperationIntents(events, params.mission.mission_id)) {
    if (intent.operation_kind === 'model_invoke') {
      await settleModelOperation(
        params.store,
        ctx,
        intent.mission_id,
        intent.operation_id,
        intent.attempt_id,
        {
          status: 'cancelled',
          operationId: intent.operation_id,
          usageSettlement: unknownUsageSettlement(intent.attempt_id),
        },
        now(),
      )
    } else {
      await settleExternalOperation(
        params.store,
        ctx,
        intent.mission_id,
        intent.operation_id,
        intent.attempt_id,
        {
          settlement: 'cancelled',
          message: 'owner session cancelled before operation completed',
          usage_settlement: unknownUsageSettlement(intent.attempt_id),
        },
        now(),
      )
    }
  }
  events = await params.store.listEvents(params.mission.mission_id)
  const searchProviderLimitations = deriveSearchProviderReportLimitations(events)
  await params.store.appendTerminalReport(
    ctx,
    buildCancelledTerminalReport({
      mission: params.mission,
      planRevisionId,
      generatedAt: now(),
      searchProviderLimitations,
    }),
  )
  return true
}
