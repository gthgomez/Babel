import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ResearchStoreEvent } from '../ports/researchStore.js'
import { deriveExternalOperationAccountingNotes } from './deriveExternalOperationAccountingNotes.js'

const MISSION_ID = 'mission-acct-001'

function modelIntent(operationId: string, attemptId: string): ResearchStoreEvent {
  return {
    eventId: `intent-${operationId}-${attemptId}`,
    missionId: MISSION_ID,
    kind: 'external_operation_intent',
    recordedAt: '2026-10-21T15:00:00.000Z',
    payload: {
      intent: {
        mission_id: MISSION_ID,
        operation_id: operationId,
        attempt_id: attemptId,
        operation_kind: 'model_invoke',
        dispatched_at: '2026-10-21T15:00:00.000Z',
        idempotency_key: operationId,
      },
    },
  }
}

function modelCompletion(operationId: string, attemptId: string): ResearchStoreEvent {
  return {
    eventId: `completion-${operationId}-${attemptId}`,
    missionId: MISSION_ID,
    kind: 'external_operation_completed',
    recordedAt: '2026-10-21T15:00:01.000Z',
    payload: {
      completion: {
        mission_id: MISSION_ID,
        operation_id: operationId,
        attempt_id: attemptId,
        completed_at: '2026-10-21T15:00:01.000Z',
        settlement: 'succeeded',
      },
    },
  }
}

describe('deriveExternalOperationAccountingNotes', () => {
  it('pending retry: completed attempt A does not clear pending attempt B on same operation', () => {
    const events = [
      modelIntent('plan-op', 'attempt-a'),
      modelCompletion('plan-op', 'attempt-a'),
      modelIntent('plan-op', 'attempt-b'),
    ]
    const notes = deriveExternalOperationAccountingNotes(events, MISSION_ID)
    assert.match(notes, /1 intent\(s\) lack completion/)
    assert.match(notes, /plan-op@attempt-b/)
    assert.doesNotMatch(notes, /attempt-a/)
  })

  it('reports all settled when each intent key has a completion', () => {
    const events = [modelIntent('plan-op', 'attempt-a'), modelCompletion('plan-op', 'attempt-a')]
    const notes = deriveExternalOperationAccountingNotes(events, MISSION_ID)
    assert.match(notes, /each recorded external_operation_intent has a matching/)
  })
})
