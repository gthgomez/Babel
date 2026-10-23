/**
 * Independent d9 review FIX — durable store concurrency, flush failure, snapshot integrity.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  InMemoryResearchStore,
  StoreContractError,
  type InMemoryResearchStoreSnapshot,
} from '../fixtures/fakePorts.js'
import {
  exampleMissionWriteContext,
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'
import { ResearchReportV2Schema } from '../contracts/plan.js'
import { DurableStoreBusyError, DurableStoreSnapshotError } from './durableStoreErrors.js'
import {
  DURABLE_RESEARCH_STORE_SNAPSHOT_FILE,
  DurableResearchStore,
  setDurableStoreFlushDelayMsForTest,
} from './durableResearchStore.js'

const planP1 = examplePlanRevisionFixture
const planP2 = {
  ...examplePlanRevisionFixture,
  plan_revision_id: 'plan-fixture-repair-002',
  revision_reason: 'refined_scope',
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'babel-research-v2-repair-'))
}

describe('durable store d9 review repairs', () => {
  it('rejects a second open handle on the same directory (no lost plan update)', async () => {
    const dir = await tempDir()
    try {
      const storeA = await DurableResearchStore.open(dir)
      await assert.rejects(
        () => DurableResearchStore.open(dir),
        (e: unknown) => e instanceof DurableStoreBusyError,
      )
      const handle = await storeA.appendMission(exampleTechnicalMissionFixture)
      const acquired = await storeA.acquireWriterOwnership({
        mission_id: handle.mission_id,
        expected_writer_generation: handle.writer_generation,
      })
      const ctxP1 = {
        ...exampleMissionWriteContext,
        writer_generation: acquired.writer_generation,
        plan_revision_id: planP1.plan_revision_id,
      }
      await storeA.appendPlanRevision(ctxP1, planP1)
      await storeA.close()

      const storeB = await DurableResearchStore.open(dir)
      const events = await storeB.listEvents(exampleTechnicalMissionFixture.mission_id)
      assert.equal(events.filter((e) => e.kind === 'plan_revised').length, 1)
      await storeB.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not cache mission memory when flush fails (EISDIR tmp) and allows retry', async () => {
    const dir = await tempDir()
    try {
      const tmpPath = join(dir, `${DURABLE_RESEARCH_STORE_SNAPSHOT_FILE}.tmp`)
      await mkdir(tmpPath)
      const store = await DurableResearchStore.open(dir)
      await assert.rejects(() => store.appendMission(exampleTechnicalMissionFixture))
      const eventsWhileOpen = await store.listEvents(exampleTechnicalMissionFixture.mission_id)
      assert.equal(eventsWhileOpen.length, 0)
      await store.close()
      await rm(tmpPath, { recursive: true, force: true })

      const reopened = await DurableResearchStore.open(dir)
      const eventsOnDisk = await reopened.listEvents(exampleTechnicalMissionFixture.mission_id)
      assert.equal(eventsOnDisk.length, 0)
      const handle = await reopened.appendMission(exampleTechnicalMissionFixture)
      assert.equal(handle.mission_id, exampleTechnicalMissionFixture.mission_id)
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects malformed snapshot: terminal event with null terminal fence', async () => {
    const dir = await tempDir()
    try {
      const memory = new InMemoryResearchStore()
      const handle = await memory.appendMission(exampleTechnicalMissionFixture)
      const acquired = await memory.acquireWriterOwnership({
        mission_id: handle.mission_id,
        expected_writer_generation: handle.writer_generation,
      })
      const ctx = {
        ...exampleMissionWriteContext,
        writer_generation: acquired.writer_generation,
        plan_revision_id: planP1.plan_revision_id,
      }
      await memory.appendPlanRevision(ctx, planP1)
      await memory.appendPlanRevision(ctx, planP2)
      const ctxP2 = { ...ctx, plan_revision_id: planP2.plan_revision_id }
      const cancelled = ResearchReportV2Schema.parse({
        mission_id: ctxP2.mission_id,
        plan_revision_id: planP2.plan_revision_id,
        terminal_state: 'cancelled',
        answer_summary: 'cancelled',
        unanswered_questions: [],
        coverage_notes: 'repair test',
        limitations: [],
        source_cutoff: 'unknown',
        acceptance_state: 'not_accepted',
        stopping_reason: 'user_cancel',
        finding_ids: [],
        citation_passage_ids: [],
        generated_at: '2026-10-20T12:03:00.000Z',
      })
      await memory.appendTerminalReport(ctxP2, cancelled)

      const corrupted = memory.exportSnapshot()
      const missionId = exampleTechnicalMissionFixture.mission_id
      const fenceEntry = corrupted.missions.find(([id]) => id === missionId)
      assert.ok(fenceEntry)
      fenceEntry![1].terminalReport = null

      const snapshotPath = join(dir, DURABLE_RESEARCH_STORE_SNAPSHOT_FILE)
      await writeFile(snapshotPath, `${JSON.stringify(corrupted)}\n`, 'utf8')

      await assert.rejects(
        () => DurableResearchStore.open(dir),
        (e: unknown) =>
          e instanceof StoreContractError &&
          /terminal fence disagrees/.test(e.message),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('restoreSnapshot fails closed on inconsistent fence vs events', () => {
    const missionId = exampleTechnicalMissionFixture.mission_id
    const snapshot: InMemoryResearchStoreSnapshot = {
      schema_version: 1,
      events: [
        {
          eventId: 'evt-1',
          missionId,
          kind: 'mission_created',
          recordedAt: '2026-10-20T12:00:00.000Z',
          payload: { mission: exampleTechnicalMissionFixture },
        },
      ],
      missions: [
        [
          missionId,
          {
            writerGeneration: 1,
            activePlanRevisionId: 'plan-not-in-events',
            terminalReport: null,
            retainedTerminalReceipt: null,
          },
        ],
      ],
      operations: [],
    }
    assert.throws(
      () => InMemoryResearchStore.restoreSnapshot(snapshot),
      (e: unknown) =>
        e instanceof StoreContractError && /active plan revision disagrees/.test((e as Error).message),
    )
  })

  it('open rejects invalid JSON snapshot', async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, DURABLE_RESEARCH_STORE_SNAPSHOT_FILE), '{not-json', 'utf8')
      await assert.rejects(
        () => DurableResearchStore.open(dir),
        (e: unknown) => e instanceof DurableStoreSnapshotError,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serializes concurrent acquire on one handle during slow flush', async () => {
    const dir = await tempDir()
    try {
      setDurableStoreFlushDelayMsForTest(40)
      const store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const missionId = handle.mission_id
      const results = await Promise.allSettled([
        store.acquireWriterOwnership({
          mission_id: missionId,
          expected_writer_generation: 1,
        }),
        store.acquireWriterOwnership({
          mission_id: missionId,
          expected_writer_generation: 1,
        }),
      ])
      const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<DurableResearchStore['acquireWriterOwnership']>>
      >[]
      const rejected = results.filter((r) => r.status === 'rejected')
      assert.equal(fulfilled.length, 1)
      assert.equal(rejected.length, 1)
      assert.equal(fulfilled[0]?.value.writer_generation, 2)
      await store.close()
    } finally {
      setDurableStoreFlushDelayMsForTest(0)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('close drains in-flight mutation before releasing exclusive lock', async () => {
    const dir = await tempDir()
    try {
      setDurableStoreFlushDelayMsForTest(50)
      const store = await DurableResearchStore.open(dir)
      const persisted = store.appendMission(exampleTechnicalMissionFixture)
      const closed = store.close()
      await Promise.all([persisted, closed])
      const reopened = await DurableResearchStore.open(dir)
      const events = await reopened.listEvents(exampleTechnicalMissionFixture.mission_id)
      assert.equal(events.filter((e) => e.kind === 'mission_created').length, 1)
      await reopened.close()
    } finally {
      setDurableStoreFlushDelayMsForTest(0)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects snapshot when operations map entry removed but intent events remain', async () => {
    const dir = await tempDir()
    try {
      const memory = new InMemoryResearchStore()
      const handle = await memory.appendMission(exampleTechnicalMissionFixture)
      const acquired = await memory.acquireWriterOwnership({
        mission_id: handle.mission_id,
        expected_writer_generation: handle.writer_generation,
      })
      const ctx = {
        ...exampleMissionWriteContext,
        writer_generation: acquired.writer_generation,
        plan_revision_id: planP1.plan_revision_id,
      }
      await memory.appendPlanRevision(ctx, planP1)
      await memory.appendExternalOperationIntent(ctx, {
        mission_id: ctx.mission_id,
        operation_id: 'op-map-missing',
        attempt_id: 'att-map-missing',
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:00.000Z',
        idempotency_key: 'map-missing',
      })
      await memory.appendExternalOperationCompleted(ctx, {
        mission_id: ctx.mission_id,
        operation_id: 'op-map-missing',
        attempt_id: 'att-map-missing',
        completed_at: '2026-10-20T12:00:01.000Z',
        settlement: 'succeeded',
      })
      const tampered = memory.exportSnapshot()
      tampered.operations = []

      await writeFile(
        join(dir, DURABLE_RESEARCH_STORE_SNAPSHOT_FILE),
        `${JSON.stringify(tampered)}\n`,
        'utf8',
      )
      await assert.rejects(
        () => DurableResearchStore.open(dir),
        (e: unknown) =>
          e instanceof StoreContractError &&
          /operations map size disagrees|missing event-derived operation entry/.test(
            (e as Error).message,
          ),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects snapshot when operations map completion diverges from completion event', async () => {
    const dir = await tempDir()
    try {
      const memory = new InMemoryResearchStore()
      const handle = await memory.appendMission(exampleTechnicalMissionFixture)
      const acquired = await memory.acquireWriterOwnership({
        mission_id: handle.mission_id,
        expected_writer_generation: handle.writer_generation,
      })
      const ctx = {
        ...exampleMissionWriteContext,
        writer_generation: acquired.writer_generation,
        plan_revision_id: planP1.plan_revision_id,
      }
      await memory.appendPlanRevision(ctx, planP1)
      await memory.appendExternalOperationIntent(ctx, {
        mission_id: ctx.mission_id,
        operation_id: 'op-map-drift',
        attempt_id: 'att-map-drift',
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:00.000Z',
        idempotency_key: 'map-drift',
      })
      await memory.appendExternalOperationCompleted(ctx, {
        mission_id: ctx.mission_id,
        operation_id: 'op-map-drift',
        attempt_id: 'att-map-drift',
        completed_at: '2026-10-20T12:00:01.000Z',
        settlement: 'succeeded',
      })
      const tampered = memory.exportSnapshot()
      const entry = tampered.operations[0]
      assert.ok(entry)
      if (entry[1].completion) {
        entry[1].completion = { ...entry[1].completion, settlement: 'failed' }
      }

      await writeFile(
        join(dir, DURABLE_RESEARCH_STORE_SNAPSHOT_FILE),
        `${JSON.stringify(tampered)}\n`,
        'utf8',
      )
      await assert.rejects(
        () => DurableResearchStore.open(dir),
        (e: unknown) =>
          e instanceof StoreContractError &&
          /operations map entry disagrees with event-derived state/.test((e as Error).message),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('after successful persist, reopen reads committed snapshot', async () => {
    const dir = await tempDir()
    try {
      const store = await DurableResearchStore.open(dir)
      await store.appendMission(exampleTechnicalMissionFixture)
      await store.close()
      const raw = await readFile(join(dir, DURABLE_RESEARCH_STORE_SNAPSHOT_FILE), 'utf8')
      assert.ok(raw.includes('mission_created'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
