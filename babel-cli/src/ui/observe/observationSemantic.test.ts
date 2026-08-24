import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createObservationSemanticReducer, reduceObservationSemantic } from './observationSemantic.js'
import type { SessionEvent } from '../../agent/sessionEvents.js'

function ev(partial: object): SessionEvent {
  return {
    schema_version: 1,
    session_id: 's',
    event_id: Math.random().toString(16).slice(2),
    ts: new Date().toISOString(),
    ...partial,
  } as SessionEvent
}

describe('reduceObservationSemantic', () => {
  it('does X when Y: cancelled policy tools count as blocked not completed', () => {
    const state = reduceObservationSemantic([
      ev({ kind: 'user_submitted', turn_id: 't1', task_preview: 'x' }),
      ev({ kind: 'tool_proposed', tool_call_id: 'c1', tool_name: 'run_command', idempotency_key: 'c1' }),
      ev({ kind: 'tool_started', tool_call_id: 'c1', tool_name: 'run_command', idempotency_key: 'c1' }),
      ev({
        kind: 'tool_cancelled',
        tool_call_id: 'c1',
        tool_name: 'run_command',
        idempotency_key: 'c1',
        reason: 'blocked by policy',
      }),
      ev({ kind: 'progress_recovery', intervention: 'stall', score: 8, signals: ['no-progress'] }),
    ])
    assert.equal(state.toolBlocked, 1)
    assert.equal(state.toolCompleted, 0)
    assert.equal(state.lastTool?.state, 'blocked')
    assert.equal(state.lastTool?.name, 'run_command')
    assert.equal(state.workspaceMutationCount, 0)
    assert.equal(state.stallCycle, 1)
    assert.equal(state.terminalStatus, 'stalled')
  })

  it('does X when Y: mutation_batch paths increment workspace_mutation_count', () => {
    const state = reduceObservationSemantic([
      ev({ kind: 'mutation_batch', paths: ['a.ts', 'b.ts'] }),
      ev({ kind: 'mutation_batch', paths: ['a.ts'] }),
    ])
    assert.equal(state.workspaceMutationCount, 2)
    assert.deepEqual(state.changedPaths.sort(), ['a.ts', 'b.ts'])
  })

  it('matches full replay semantics at every prefix', () => {
    const events: SessionEvent[] = [
      ev({ kind: 'user_submitted', turn_id: 't1', task_preview: 'x' }),
      ev({ kind: 'tool_proposed', tool_call_id: 'c1', tool_name: 'read_file', idempotency_key: 'c1' }),
      ev({ kind: 'tool_completed', tool_call_id: 'c1', tool_name: 'read_file', idempotency_key: 'c1' }),
      ev({ kind: 'mutation_batch', paths: ['src/a.ts'] }),
      ev({
        kind: 'completion_decision',
        requested_outcome: 'VERIFIED_COMPLETE',
        final_outcome: 'VERIFIED_COMPLETE',
        allowed: true,
        reason: 'done',
        evidence_refs: [],
        policy_version: 'test',
      }),
      ev({ kind: 'turn_ended', outcome: 'VERIFIED_COMPLETE', status: 'completed' }),
      ev({ kind: 'turn_ended', status: 'blocked' }),
    ]
    const incremental = createObservationSemanticReducer()
    for (let index = 0; index < events.length; index += 1) {
      const actual = incremental.apply(events[index]!)
      const expected = reduceObservationSemantic(events.slice(0, index + 1))
      assert.deepEqual(actual, expected)
    }
  })
})
