import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { PassageRecord } from '../contracts/passages.js'
import { PassageRecordSchema } from '../contracts/passages.js'
import type { SourceFetchEvidenceOwner } from '../contracts/retrievalEvidenceOwnership.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import {
  exampleMissionWriteContext,
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'
import { DurableResearchStore } from '../persistence/durableResearchStore.js'
import {
  extractionLineageReportLimitations,
  filterPassagesForExtractionLineage,
  passageIdsForExtractionLineage,
  passageIsAdmittedForExtractionLineage,
  succeededSourceFetchAttemptOwnerKeys,
} from './retrievalExtractionLineage.js'

const MISSION_ID = 'mission-a'

function fetchOwner(operationId: string, attemptId: string): SourceFetchEvidenceOwner {
  return fetchOwnerForMission(MISSION_ID, operationId, attemptId)
}

function fetchOwnerForMission(
  missionId: string,
  operationId: string,
  attemptId: string,
): SourceFetchEvidenceOwner {
  return {
    mission_id: missionId,
    operation_id: operationId,
    attempt_id: attemptId,
  }
}

function passage(
  id: string,
  sourceRevisionId = 'rev-1',
  owner?: SourceFetchEvidenceOwner,
  inlineText?: string,
): PassageRecord {
  const text = inlineText ?? `text-for-${id}`
  return PassageRecordSchema.parse({
    passage_id: id,
    source_revision_id: sourceRevisionId,
    locator: { kind: 'line_range', start_line: 1, end_line: 1 },
    text_ref: {
      mode: 'inline',
      text,
      text_hash: createHash('sha256').update(text).digest('hex'),
    },
    ...(owner ? { source_fetch_owner: owner } : {}),
  })
}

function fetchIntent(operationId: string, attemptId = `${operationId}-att`): ResearchStoreEvent {
  return {
    eventId: `intent-${operationId}-${attemptId}`,
    missionId: MISSION_ID,
    kind: 'external_operation_intent',
    recordedAt: '2026-10-20T12:00:00.000Z',
    payload: {
      intent: {
        mission_id: MISSION_ID,
        operation_id: operationId,
        attempt_id: attemptId,
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:00.000Z',
        idempotency_key: `${operationId}:${attemptId}`,
      },
    },
  }
}

function passageRecorded(passageEntry: PassageRecord): ResearchStoreEvent {
  return {
    eventId: `passage-${passageEntry.passage_id}`,
    missionId: MISSION_ID,
    kind: 'passage_recorded',
    recordedAt: '2026-10-20T12:00:00.500Z',
    payload: { passage: passageEntry },
  }
}

function fetchCompletion(
  operationId: string,
  settlement: 'succeeded' | 'failed' | 'cancelled',
  attemptId = `${operationId}-att`,
): ResearchStoreEvent {
  return {
    eventId: `completion-${operationId}-${attemptId}`,
    missionId: MISSION_ID,
    kind: 'external_operation_completed',
    recordedAt: '2026-10-20T12:00:01.000Z',
    payload: {
      completion: {
        mission_id: MISSION_ID,
        operation_id: operationId,
        attempt_id: attemptId,
        completed_at: '2026-10-20T12:00:01.000Z',
        settlement,
      },
    },
  }
}

describe('retrievalExtractionLineage', () => {
  it('admits passages only when write-time owner matches a succeeded source_fetch attempt', () => {
    const failedPassage = passage('fetch-failed:0', 'rev-f', fetchOwner('fetch-failed', 'att-fail'))
    const okPassages = [
      passage('fetch-ok', 'rev-ok', fetchOwner('fetch-ok', 'att-ok')),
      passage('fetch-ok:1', 'rev-ok', fetchOwner('fetch-ok', 'att-ok')),
    ]
    const events = [
      fetchIntent('fetch-failed', 'att-fail'),
      passageRecorded(failedPassage),
      fetchCompletion('fetch-failed', 'failed', 'att-fail'),
      fetchIntent('fetch-ok', 'att-ok'),
      passageRecorded(okPassages[0]!),
      passageRecorded(okPassages[1]!),
      fetchCompletion('fetch-ok', 'succeeded', 'att-ok'),
    ]
    const passages = [failedPassage, ...okPassages]
    const filtered = filterPassagesForExtractionLineage(passages, events)
    assert.deepEqual(filtered.map((p) => p.passage_id), ['fetch-ok', 'fetch-ok:1'])
  })

  it('does not cross-admit colliding passage_id: failed owner row excluded when id admitted on success', () => {
    const sharedId = 'fetch-op:L1'
    const failedText = 'failed-attempt-excerpt'
    const successText = 'succeeded-attempt-excerpt'
    const failedRow = passage(
      sharedId,
      'rev-fail',
      fetchOwner('fetch-op', 'att-fail'),
      failedText,
    )
    const successRow = passage(
      sharedId,
      'rev-ok',
      fetchOwner('fetch-op', 'att-ok'),
      successText,
    )
    const events = [
      fetchIntent('fetch-op', 'att-fail'),
      passageRecorded(failedRow),
      fetchCompletion('fetch-op', 'failed', 'att-fail'),
      fetchIntent('fetch-op', 'att-ok'),
      passageRecorded(successRow),
      fetchCompletion('fetch-op', 'succeeded', 'att-ok'),
    ]
    const filtered = filterPassagesForExtractionLineage([failedRow, successRow], events)
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0]?.passage_id, sharedId)
    assert.equal(
      filtered[0]?.text_ref.mode === 'inline' ? filtered[0].text_ref.text : '',
      successText,
    )
    assert.equal(passageIsAdmittedForExtractionLineage(failedRow, events), false)
    assert.equal(passageIsAdmittedForExtractionLineage(successRow, events), true)
  })

  it('colliding passage_id: ownerless legacy row excluded while succeeded owner row kept', () => {
    const sharedId = 'pdf:page:1'
    const legacyRow = passage(sharedId, 'rev-legacy', undefined, 'legacy-unowned-text')
    const ownedRow = passage(
      sharedId,
      'rev-ok',
      fetchOwner('pdf-fetch', 'att-ok'),
      'owned-success-text',
    )
    const events = [
      fetchIntent('pdf-fetch', 'att-ok'),
      passageRecorded(legacyRow),
      passageRecorded(ownedRow),
      fetchCompletion('pdf-fetch', 'succeeded', 'att-ok'),
    ]
    const filtered = filterPassagesForExtractionLineage([legacyRow, ownedRow], events)
    assert.equal(filtered.length, 1)
    assert.equal(
      filtered[0]?.text_ref.mode === 'inline' ? filtered[0].text_ref.text : '',
      'owned-success-text',
    )
    assert.deepEqual(extractionLineageReportLimitations([legacyRow, ownedRow], events), [
      'extraction_lineage_excluded_ownerless_legacy_passage_count:1',
    ])
  })

  it('excludes legacy passages without source_fetch_owner (fail closed)', () => {
    const owned = passage('owned', 'rev-1', fetchOwner('fetch-ok', 'att-ok'))
    const legacy = passage('legacy-no-owner')
    const events = [
      fetchIntent('fetch-ok', 'att-ok'),
      passageRecorded(legacy),
      passageRecorded(owned),
      fetchCompletion('fetch-ok', 'succeeded', 'att-ok'),
    ]
    assert.deepEqual(
      filterPassagesForExtractionLineage([legacy, owned], events).map((p) => p.passage_id),
      ['owned'],
    )
  })

  it('same operation_id: nested B-then-A completion does not admit B-owned passage on A success', () => {
    const op = 'shared-fetch-op'
    const bad = passage('bad', 'rev-b', fetchOwner(op, 'att-b'))
    const good = passage('good', 'rev-a', fetchOwner(op, 'att-a'))
    const events = [
      fetchIntent(op, 'att-a'),
      fetchIntent(op, 'att-b'),
      passageRecorded(bad),
      fetchCompletion(op, 'failed', 'att-b'),
      passageRecorded(good),
      fetchCompletion(op, 'succeeded', 'att-a'),
    ]
    assert.deepEqual(
      filterPassagesForExtractionLineage([bad, good], events).map((p) => p.passage_id),
      ['good'],
    )
  })

  it('same operation_id: nested A-then-B completion does not admit A-owned orphan on B success', () => {
    const op = 'shared-fetch-op'
    const orphanA = passage('orphan-a', 'rev-a', fetchOwner(op, 'att-a'))
    const goodB = passage('good-b', 'rev-b', fetchOwner(op, 'att-b'))
    const events = [
      fetchIntent(op, 'att-a'),
      fetchIntent(op, 'att-b'),
      passageRecorded(orphanA),
      fetchCompletion(op, 'failed', 'att-a'),
      passageRecorded(goodB),
      fetchCompletion(op, 'succeeded', 'att-b'),
    ]
    assert.deepEqual(
      filterPassagesForExtractionLineage([orphanA, goodB], events).map((p) => p.passage_id),
      ['good-b'],
    )
  })

  it('distinct operation_ids: prefix-like passage_id cannot cross-admit without owner match', () => {
    const bad = passage('fetch-b:html:0', 'rev-b', fetchOwner('fetch-b', 'att-b'))
    const good = passage('passage-hash-ok', 'rev-a', fetchOwner('fetch-a', 'att-a'))
    const events = [
      fetchIntent('fetch-a', 'att-a'),
      fetchIntent('fetch-b', 'att-b'),
      passageRecorded(bad),
      fetchCompletion('fetch-b', 'failed', 'att-b'),
      passageRecorded(good),
      fetchCompletion('fetch-a', 'succeeded', 'att-a'),
    ]
    assert.deepEqual(
      filterPassagesForExtractionLineage([bad, good], events).map((p) => p.passage_id),
      ['passage-hash-ok'],
    )
  })

  it('returns empty extraction set when no succeeded source_fetch attempt keys exist', () => {
    const events = [fetchIntent('only-failed', 'att-fail'), fetchCompletion('only-failed', 'failed', 'att-fail')]
    const passages = [passage('only-failed:0', 'rev', fetchOwner('only-failed', 'att-fail'))]
    assert.deepEqual(filterPassagesForExtractionLineage(passages, events), [])
    assert.deepEqual(succeededSourceFetchAttemptOwnerKeys(events), new Set())
  })

  it('durable close/reopen: owner-tagged evidence survives filtering after reopen', async () => {
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
        attempt_id: 'att-fail',
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:00.000Z',
        idempotency_key: `${failedOp}:att-fail`,
      })
      await store.appendPassage(
        ctx,
        passage(
          `${failedOp}:orphan`,
          'rev-f',
          fetchOwnerForMission(ctx.mission_id, failedOp, 'att-fail'),
        ),
      )
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: ctx.mission_id,
        operation_id: failedOp,
        attempt_id: 'att-fail',
        completed_at: '2026-10-20T12:00:01.000Z',
        settlement: 'failed',
      })
      const okOp = 'resumed-fetch-ok'
      await store.appendExternalOperationIntent(ctx, {
        mission_id: ctx.mission_id,
        operation_id: okOp,
        attempt_id: 'att-ok',
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:02.000Z',
        idempotency_key: `${okOp}:att-ok`,
      })
      await store.appendPassage(
        ctx,
        passage(okOp, 'rev-ok', fetchOwnerForMission(ctx.mission_id, okOp, 'att-ok')),
      )
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: ctx.mission_id,
        operation_id: okOp,
        attempt_id: 'att-ok',
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

  it('durable close/reopen: colliding passage_id keeps succeeded attempt text only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-lineage-collision-'))
    const sharedId = 'composed-fetch:L1'
    const failedText = 'collision-failed-body'
    const successText = 'collision-succeeded-body'
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const ctx = { ...exampleMissionWriteContext, writer_generation: handle.writer_generation }
      await store.appendPlanRevision(ctx, examplePlanRevisionFixture)
      const op = 'collision-fetch-op'
      await store.appendExternalOperationIntent(ctx, {
        mission_id: ctx.mission_id,
        operation_id: op,
        attempt_id: 'att-fail',
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:00.000Z',
        idempotency_key: `${op}:att-fail`,
      })
      await store.appendPassage(
        ctx,
        passage(
          sharedId,
          'rev-f',
          fetchOwnerForMission(ctx.mission_id, op, 'att-fail'),
          failedText,
        ),
      )
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: ctx.mission_id,
        operation_id: op,
        attempt_id: 'att-fail',
        completed_at: '2026-10-20T12:00:01.000Z',
        settlement: 'failed',
      })
      await store.appendExternalOperationIntent(ctx, {
        mission_id: ctx.mission_id,
        operation_id: op,
        attempt_id: 'att-ok',
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:02.000Z',
        idempotency_key: `${op}:att-ok`,
      })
      await store.appendPassage(
        ctx,
        passage(
          sharedId,
          'rev-ok',
          fetchOwnerForMission(ctx.mission_id, op, 'att-ok'),
          successText,
        ),
      )
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: ctx.mission_id,
        operation_id: op,
        attempt_id: 'att-ok',
        completed_at: '2026-10-20T12:00:03.000Z',
        settlement: 'succeeded',
      })
      await store.close()

      store = await DurableResearchStore.open(dir)
      const events = await store.listEvents(ctx.mission_id)
      const allPassages = events
        .filter((e) => e.kind === 'passage_recorded')
        .map((e) => (e.payload as { passage: PassageRecord }).passage)
      const forExtract = filterPassagesForExtractionLineage(allPassages, events)
      assert.equal(forExtract.length, 1)
      assert.equal(
        forExtract[0]?.text_ref.mode === 'inline' ? forExtract[0].text_ref.text : '',
        successText,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('durable close/reopen: same operation_id failed then succeeded retry keeps only retry owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-lineage-retry-'))
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const ctx = { ...exampleMissionWriteContext, writer_generation: handle.writer_generation }
      await store.appendPlanRevision(ctx, examplePlanRevisionFixture)
      const op = 'retry-fetch-op'
      await store.appendExternalOperationIntent(ctx, {
        mission_id: ctx.mission_id,
        operation_id: op,
        attempt_id: 'att-fail',
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:00.000Z',
        idempotency_key: `${op}:att-fail`,
      })
      await store.appendPassage(
        ctx,
        passage(
          `${op}:orphan`,
          'rev-f',
          fetchOwnerForMission(ctx.mission_id, op, 'att-fail'),
        ),
      )
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: ctx.mission_id,
        operation_id: op,
        attempt_id: 'att-fail',
        completed_at: '2026-10-20T12:00:01.000Z',
        settlement: 'failed',
      })
      await store.appendExternalOperationIntent(ctx, {
        mission_id: ctx.mission_id,
        operation_id: op,
        attempt_id: 'att-retry',
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:02.000Z',
        idempotency_key: `${op}:att-retry`,
      })
      await store.appendPassage(
        ctx,
        passage(
          `${op}:retry`,
          'rev-r',
          fetchOwnerForMission(ctx.mission_id, op, 'att-retry'),
        ),
      )
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: ctx.mission_id,
        operation_id: op,
        attempt_id: 'att-retry',
        completed_at: '2026-10-20T12:00:03.000Z',
        settlement: 'succeeded',
      })
      await store.close()

      store = await DurableResearchStore.open(dir)
      const events = await store.listEvents(ctx.mission_id)
      const allPassages = events
        .filter((e) => e.kind === 'passage_recorded')
        .map((e) => (e.payload as { passage: PassageRecord }).passage)
      const forExtract = filterPassagesForExtractionLineage(allPassages, events)
      assert.deepEqual(forExtract.map((p) => p.passage_id), [`${op}:retry`])
      assert.deepEqual(passageIdsForExtractionLineage(allPassages, events), [`${op}:retry`])
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
      attempt_id: 'att-fail',
      operation_kind: 'source_fetch',
      dispatched_at: '2026-10-20T12:00:00.000Z',
      idempotency_key: `${failedOp}:att-fail`,
    })
    await store.appendPassage(
      ctx,
      passage(
        `${failedOp}:leftover`,
        'rev-f',
        fetchOwnerForMission(ctx.mission_id, failedOp, 'att-fail'),
      ),
    )
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: ctx.mission_id,
      operation_id: failedOp,
      attempt_id: 'att-fail',
      completed_at: '2026-10-20T12:00:01.000Z',
      settlement: 'failed',
    })
    const events = await store.listEvents(ctx.mission_id)
    const allPassages = events
      .filter((e) => e.kind === 'passage_recorded')
      .map((e) => (e.payload as { passage: PassageRecord }).passage)
    assert.deepEqual(filterPassagesForExtractionLineage(allPassages, events), [])
  })
})
