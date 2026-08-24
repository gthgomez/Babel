import { performance } from 'node:perf_hooks'

import { createObservationSemanticReducer, reduceObservationSemantic } from '../src/ui/observe/observationSemantic.js'
import type { SessionEvent } from '../src/agent/sessionEvents.js'

const SIZES = [100, 1_000, 5_000, 10_000]

function base(seq: number, kind: SessionEvent['kind']): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: `benchmark-${seq}`,
    session_id: 'benchmark-session',
    turn_id: 'benchmark-turn',
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    kind,
  }
}

function buildEvents(size: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let seq = 1; seq <= size; seq += 1) {
    if (seq === 1) {
      events.push({ ...base(seq, 'user_submitted'), task_preview: 'benchmark' } as SessionEvent)
      continue
    }
    const phase = seq % 6
    if (phase === 0) {
      const toolId = `tool-${Math.floor(seq / 6)}`
      events.push({
        ...base(seq, 'tool_proposed'),
        tool_call_id: toolId,
        tool_name: 'read_file',
        idempotency_key: toolId,
        target_summary: 'src/ui/observe/tuiSessionStore.ts',
      } as SessionEvent)
    } else if (phase === 1) {
      const toolId = `tool-${Math.floor(seq / 6)}`
      events.push({
        ...base(seq, 'tool_started'),
        tool_call_id: toolId,
        tool_name: 'read_file',
        idempotency_key: toolId,
        target_summary: 'src/ui/observe/tuiSessionStore.ts',
      } as SessionEvent)
    } else if (phase === 2) {
      const toolId = `tool-${Math.floor(seq / 6)}`
      events.push({
        ...base(seq, 'tool_completed'),
        tool_call_id: toolId,
        tool_name: 'read_file',
        idempotency_key: toolId,
        exit_code: 0,
        target_summary: 'src/ui/observe/tuiSessionStore.ts',
      } as SessionEvent)
    } else {
      events.push({
        ...base(seq, 'mutation_batch'),
        paths: ['babel-cli/src/ui/observe/tuiSessionStore.ts'],
      } as SessionEvent)
    }
  }
  return events
}

function measureCumulativeReduction(
  size: number,
  mode: 'full-replay' | 'incremental',
): { size: number; mode: string; milliseconds: number; finalSeq: number } {
  const events = buildEvents(size)
  const prefix: SessionEvent[] = []
  const reducer = mode === 'incremental' ? createObservationSemanticReducer() : null
  let finalSeq = 0
  const started = performance.now()
  for (const event of events) {
    prefix.push(event)
    finalSeq = (reducer ? reducer.apply(event) : reduceObservationSemantic(prefix)).semanticEventSeq
  }
  return {
    size,
    mode,
    milliseconds: Number((performance.now() - started).toFixed(3)),
    finalSeq,
  }
}

for (const size of SIZES) {
  process.stderr.write(`benchmarking cumulative semantic reduction at ${size} events\n`)
  process.stdout.write(`${JSON.stringify(measureCumulativeReduction(size, 'full-replay'))}\n`)
  process.stdout.write(`${JSON.stringify(measureCumulativeReduction(size, 'incremental'))}\n`)
}
