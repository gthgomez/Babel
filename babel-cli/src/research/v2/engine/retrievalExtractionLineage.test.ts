import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { PassageRecord } from '../contracts/passages.js'
import { PassageRecordSchema } from '../contracts/passages.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import {
  exampleMissionWriteContext,
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'
import { DurableResearchStore } from '../persistence/durableResearchStore.js'
import {
  filterPassagesForExtractionLineage,
  passageIdsForExtractionLineage,
  succeededSourceFetchOperationIds,
} from './retrievalExtractionLineage.js'

function passage(id: string): PassageRecord {
  const text = `text-for-${id}`
  return PassageRecordSchema.parse({
    passage_id: id,
    source_revision_id: 'rev-1',
    locator: { kind: 'line_range', start_line: 1, end_line: 1 },
    text_ref: {
      mode: 'inline',
      text,
      text_hash: createHash('sha256').update(text).digest('hex'),
    },
  })
}

function fetchIntent(operationId: string): ResearchStoreEvent {
  return {
    eventId: `intent-${operationId}`,
    missionId: 'mission-a',
    kind: 'external_operation_intent',
    recordedAt: '2026-10-20T12:00:00.000Z',
    payload: {
      intent: {
        mission_id: 'mission-a',
        operation_id: operationId,
        attempt_id: `${operationId}-att`,
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:00.000Z',
        idempotency_key: operationId,
      },
    },
  }
}

function passageRecorded(passage: PassageRecord): ResearchStoreEvent {
  return {
    eventId: `passage-${passage.passage_id}`,
    missionId: 'mission-a',
    kind: 'passage_recorded',
    recordedAt: '2026-10-20T12:00:00.500Z',
    payload: { passage },
  }
}

function fetchCompletion(
  operationId: string,
  settlement: 'succeeded' | 'failed' | 'cancelled',
): ResearchStoreEvent {
  return {
    eventId: `completion-${operationId}`,
    missionId: 'mission-a',
    kind: 'external_operation_completed',
    recordedAt: '2026-10-20T12:00:01.000Z',
    payload: {
      completion: {
        mission_id: 'mission-a',
        operation_id: operationId,
        attempt_id: `${operationId}-att`,
        completed_at: '2026-10-20T12:00:01.000Z',
        settlement,
      },
    },
  }
}

describe('retrievalExtractionLineage', () => {
  it('admits passages only for source_fetch operations that settled succeeded', () => {
    const failedPassage = passage('fetch-failed:0')
    const okPassages = [passage('fetch-ok'), passage('fetch-ok:1')]
    const events = [
      fetchIntent('fetch-failed'),
      passageRecorded(failedPassage),
      fetchCompletion('fetch-failed', 'failed'),
      fetchIntent('fetch-ok'),
      passageRecorded(okPassages[0]!),
      passageRecorded(okPassages[1]!),
      fetchCompletion('fetch-ok', 'succeeded'),
    ]
    const passages = [failedPassage, ...okPassages]
    const filtered = filterPassagesForExtractionLineage(passages, events)
    assert.deepEqual(filtered.map((p) => p.passage_id), ['fetch-ok', 'fetch-ok:1'])
    assert.deepEqual(passageIdsForExtractionLineage(passages, events), ['fetch-ok', 'fetch-ok:1'])
  })

  it('admits technical-style passage ids when recorded before succeeded fetch completion', () => {
    const technicalPassage = passage('passage-deadbeefdeadbeefdeadbeef')
    const events = [
      fetchIntent('fetch-tech'),
      passageRecorded(technicalPassage),
      fetchCompletion('fetch-tech', 'succeeded'),
    ]
    assert.deepEqual(
      filterPassagesForExtractionLineage([technicalPassage], events).map((p) => p.passage_id),
      ['passage-deadbeefdeadbeefdeadbeef'],
    )
  })

  it('returns empty extraction set when no succeeded source_fetch lineage exists', () => {
    const events = [fetchIntent('only-failed'), fetchCompletion('only-failed', 'failed')]
    const passages = [passage('only-failed:0')]
    assert.deepEqual(filterPassagesForExtractionLineage(passages, events), [])
    assert.deepEqual(succeededSourceFetchOperationIds(events), new Set())
  })

  it('durable close/reopen: orphan partial-fetch passages stay in store but drop out of extraction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-lineage-resume-'))
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const ctx = { ...exampleMissionWriteContext, writer_generation: handle.writer_generation }
      await store.appendPlanRevision(ctx, examplePlanRevisionFixture)
      const failedOp = 'partial-failed-fetch'
      await store.appendExternalOperationIntent(ctx, {
        mission_id: ctx.mission_id,
        operation_id: failedOp,
        attempt_id: `${failedOp}-att`,
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:00.000Z',
        idempotency_key: failedOp,
      })
      await store.appendPassage(ctx, passage(`${failedOp}:orphan`))
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: ctx.mission_id,
        operation_id: failedOp,
        attempt_id: `${failedOp}-att`,
        completed_at: '2026-10-20T12:00:01.000Z',
        settlement: 'failed',
      })
      const okOp = 'resumed-fetch-ok'
      await store.appendExternalOperationIntent(ctx, {
        mission_id: ctx.mission_id,
        operation_id: okOp,
        attempt_id: `${okOp}-att`,
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:02.000Z',
        idempotency_key: okOp,
      })
      await store.appendPassage(ctx, passage(okOp))
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: ctx.mission_id,
        operation_id: okOp,
        attempt_id: `${okOp}-att`,
        completed_at: '2026-10-20T12:00:03.000Z',
        settlement: 'succeeded',
      })
      await store.close()

      store = await DurableResearchStore.open(dir)
      const events = await store.listEvents(ctx.mission_id)
      const allPassages = events
        .filter((e) => e.kind === 'passage_recorded')
        .map((e) => (e.payload as { passage: PassageRecord }).passage)
      assert.equal(allPassages.length, 2)
      const forExtract = filterPassagesForExtractionLineage(allPassages, events)
      assert.deepEqual(forExtract.map((p) => p.passage_id), [okOp])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('in-memory store retains full passage history while lineage filters extract input', async () => {
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(exampleTechnicalMissionFixture)
    const ctx = { ...exampleMissionWriteContext, writer_generation: handle.writer_generation }
    await store.appendPlanRevision(ctx, examplePlanRevisionFixture)
    const failedOp = 'mem-partial-failed'
    await store.appendExternalOperationIntent(ctx, {
      mission_id: ctx.mission_id,
      operation_id: failedOp,
      attempt_id: `${failedOp}-att`,
      operation_kind: 'source_fetch',
      dispatched_at: '2026-10-20T12:00:00.000Z',
      idempotency_key: failedOp,
    })
    await store.appendPassage(ctx, passage(`${failedOp}:leftover`))
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: ctx.mission_id,
      operation_id: failedOp,
      attempt_id: `${failedOp}-att`,
      completed_at: '2026-10-20T12:00:01.000Z',
      settlement: 'failed',
    })
    const events = await store.listEvents(ctx.mission_id)
    assert.equal(events.filter((e) => e.kind === 'passage_recorded').length, 1)
    const allPassages = events
      .filter((e) => e.kind === 'passage_recorded')
      .map((e) => (e.payload as { passage: PassageRecord }).passage)
    assert.deepEqual(filterPassagesForExtractionLineage(allPassages, events), [])
  })
})
