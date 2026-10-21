import type { ResearchReportV2 } from '../contracts/plan.js'
import type { PlanRevision } from '../contracts/plan.js'
import type {
  ExternalOperationIntent,
  ExternalOperationCompletion,
  ExternalOperationReconciliation,
} from '../contracts/operations.js'
import { StoreContractError } from '../fixtures/fakePorts.js'
import type { InMemoryResearchStoreSnapshot } from '../fixtures/fakePorts.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'

function stableJson(value: unknown): string {
  return JSON.stringify(value)
}

function operationKey(missionId: string, operationId: string, attemptId: string): string {
  return `${missionId}::${operationId}::${attemptId}`
}

function deriveFenceFromEvents(missionEvents: readonly ResearchStoreEvent[]): {
  activePlanRevisionId: string | null
  terminalReport: ResearchReportV2 | null
  retainedTerminalReceipt: ResearchReportV2 | null
  minWriterGeneration: number
} {
  let activePlanRevisionId: string | null = null
  let terminalReport: ResearchReportV2 | null = null
  let retainedTerminalReceipt: ResearchReportV2 | null = null
  let minWriterGeneration = 1

  for (const event of missionEvents) {
    if (event.kind === 'plan_revised') {
      const plan = (event.payload as { plan?: PlanRevision }).plan
      if (!plan?.plan_revision_id) {
        throw new StoreContractError('snapshot plan_revised missing plan revision id')
      }
      activePlanRevisionId = plan.plan_revision_id
    }
    if (event.kind === 'terminal_receipt') {
      const report = (event.payload as { report?: ResearchReportV2 }).report
      if (!report) {
        throw new StoreContractError('snapshot terminal_receipt missing report')
      }
      terminalReport = report
    }
    if (event.kind === 'research_continuation_resumed') {
      const payload = event.payload as {
        retained_terminal_receipt?: ResearchReportV2
        writer_generation?: number
      }
      if (!payload.retained_terminal_receipt || payload.writer_generation === undefined) {
        throw new StoreContractError('snapshot continuation missing retained receipt or generation')
      }
      retainedTerminalReceipt = payload.retained_terminal_receipt
      terminalReport = null
      minWriterGeneration = Math.max(minWriterGeneration, payload.writer_generation)
    }
  }

  return {
    activePlanRevisionId,
    terminalReport,
    retainedTerminalReceipt,
    minWriterGeneration,
  }
}

function reportsEqual(a: ResearchReportV2 | null, b: ResearchReportV2 | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return stableJson(a) === stableJson(b)
}

interface DerivedTrackedOperation {
  missionId: string
  attemptId: string
  intent: ExternalOperationIntent
  completion?: ExternalOperationCompletion
  accountingReconciled?: ExternalOperationReconciliation
}

function deriveOperationsFromEvents(events: readonly ResearchStoreEvent[]): Map<string, DerivedTrackedOperation> {
  const derived = new Map<string, DerivedTrackedOperation>()
  for (const event of events) {
    if (event.kind === 'external_operation_intent') {
      const intent = (event.payload as { intent?: ExternalOperationIntent }).intent
      if (!intent) {
        throw new StoreContractError('snapshot intent event missing intent payload')
      }
      const key = operationKey(intent.mission_id, intent.operation_id, intent.attempt_id)
      derived.set(key, {
        missionId: intent.mission_id,
        attemptId: intent.attempt_id,
        intent,
      })
    }
    if (event.kind === 'external_operation_completed') {
      const completion = (event.payload as { completion?: ExternalOperationCompletion }).completion
      if (!completion) {
        throw new StoreContractError('snapshot completion event missing completion payload')
      }
      const key = operationKey(completion.mission_id, completion.operation_id, completion.attempt_id)
      const tracked = derived.get(key)
      if (!tracked) {
        throw new StoreContractError('snapshot completion without prior intent event')
      }
      tracked.completion = completion
    }
    if (event.kind === 'external_operation_reconciled') {
      const reconciliation = (event.payload as {
        reconciliation?: ExternalOperationReconciliation
      }).reconciliation
      if (!reconciliation) {
        throw new StoreContractError('snapshot reconciliation event missing reconciliation payload')
      }
      const key = operationKey(
        reconciliation.mission_id,
        reconciliation.operation_id,
        reconciliation.attempt_id,
      )
      const tracked = derived.get(key)
      if (!tracked) {
        throw new StoreContractError('snapshot reconciliation without prior intent event')
      }
      if (tracked.completion && tracked.completion.settlement === 'uncertain') {
        tracked.completion = {
          ...tracked.completion,
          settlement: reconciliation.resolved_settlement,
          usage_settlement: reconciliation.usage_settlement,
        }
      } else if (!tracked.completion) {
        tracked.accountingReconciled = reconciliation
      }
    }
  }
  return derived
}

function trackedOperationsEqual(
  a: DerivedTrackedOperation,
  b: DerivedTrackedOperation,
): boolean {
  return (
    a.missionId === b.missionId &&
    a.attemptId === b.attemptId &&
    stableJson(a.intent) === stableJson(b.intent) &&
    stableJson(a.completion ?? null) === stableJson(b.completion ?? null) &&
    stableJson(a.accountingReconciled ?? null) === stableJson(b.accountingReconciled ?? null)
  )
}

function assertOperationsMapMatchesEvents(snapshot: InMemoryResearchStoreSnapshot): void {
  const derived = deriveOperationsFromEvents(snapshot.events)
  const mapByKey = new Map(snapshot.operations)

  if (derived.size !== mapByKey.size) {
    throw new StoreContractError('snapshot operations map size disagrees with event-derived operations')
  }

  for (const [key, derivedOp] of derived) {
    const mapOp = mapByKey.get(key)
    if (!mapOp) {
      throw new StoreContractError('snapshot operations map missing event-derived operation entry')
    }
    if (!trackedOperationsEqual(derivedOp, mapOp)) {
      throw new StoreContractError('snapshot operations map entry disagrees with event-derived state')
    }
  }

  for (const [key] of mapByKey) {
    if (!derived.has(key)) {
      throw new StoreContractError('snapshot operations map contains orphan entry without intent events')
    }
  }
}

/** Fail-closed cross-check of snapshot maps vs append-only event evidence. */
export function assertSnapshotIntegrity(snapshot: InMemoryResearchStoreSnapshot): void {
  if (snapshot.schema_version !== 1) {
    throw new StoreContractError('unsupported store snapshot schema')
  }

  const missionIdsFromEvents = new Set<string>()
  for (const event of snapshot.events) {
    missionIdsFromEvents.add(event.missionId)
  }

  for (const missionId of missionIdsFromEvents) {
    if (!snapshot.missions.some(([id]) => id === missionId)) {
      throw new StoreContractError(`snapshot events reference mission without fence: ${missionId}`)
    }
  }

  for (const [missionId, fence] of snapshot.missions) {
    const missionEvents = snapshot.events.filter((e) => e.missionId === missionId)
    const created = missionEvents.some((e) => e.kind === 'mission_created')
    if (!created) {
      throw new StoreContractError(`snapshot fence without mission_created: ${missionId}`)
    }

    const derived = deriveFenceFromEvents(missionEvents)
    if (fence.activePlanRevisionId !== derived.activePlanRevisionId) {
      throw new StoreContractError('snapshot active plan revision disagrees with event log')
    }
    if (!reportsEqual(fence.terminalReport, derived.terminalReport)) {
      throw new StoreContractError('snapshot terminal fence disagrees with event log')
    }
    if (!reportsEqual(fence.retainedTerminalReceipt, derived.retainedTerminalReceipt)) {
      throw new StoreContractError('snapshot retained terminal disagrees with event log')
    }
    if (fence.writerGeneration < derived.minWriterGeneration) {
      throw new StoreContractError('snapshot writer generation below event-derived minimum')
    }
    if (fence.writerGeneration < 1) {
      throw new StoreContractError('snapshot writer generation invalid')
    }
  }

  for (const [key, tracked] of snapshot.operations) {
    const expectedKey = operationKey(tracked.missionId, tracked.intent.operation_id, tracked.attemptId)
    if (key !== expectedKey) {
      throw new StoreContractError('snapshot operation key mismatch')
    }
  }

  assertOperationsMapMatchesEvents(snapshot)
}
