/**
 * M1.1 — durable store survives process-style close/reopen via on-disk snapshot.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { StoreContractError } from '../fixtures/fakePorts.js'
import {
  exampleMissionWriteContext,
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'
import { SourceRecordSchema } from '../contracts/sources.js'
import { ResearchReportV2Schema } from '../contracts/plan.js'
import { DurableResearchStore } from './durableResearchStore.js'

const planP1 = examplePlanRevisionFixture
const planP2 = {
  ...examplePlanRevisionFixture,
  plan_revision_id: 'plan-fixture-002',
  revision_reason: 'refined_scope',
}

async function withTempStoreDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'babel-research-v2-store-'))
}

describe('durable research store (M1.1 conformance)', () => {
  it('reopens with plan fencing and writer generation intact', async () => {
    const dir = await withTempStoreDir()
    try {
      const store1 = await DurableResearchStore.open(dir)
      const handle = await store1.appendMission(exampleTechnicalMissionFixture)
      const acquired = await store1.acquireWriterOwnership({
        mission_id: handle.mission_id,
        expected_writer_generation: handle.writer_generation,
      })
      const ctxP1 = {
        ...exampleMissionWriteContext,
        writer_generation: acquired.writer_generation,
        plan_revision_id: planP1.plan_revision_id,
      }
      await store1.appendPlanRevision(ctxP1, planP1)
      await store1.close()

      const store2 = await DurableResearchStore.open(dir)
      await assert.rejects(
        () =>
          store2.appendPlanRevision(ctxP1, {
            ...planP2,
            plan_revision_id: planP1.plan_revision_id,
          }),
        (e: unknown) => e instanceof StoreContractError,
      )
      await store2.appendPlanRevision(ctxP1, planP2)
      const ctxP2 = { ...ctxP1, plan_revision_id: planP2.plan_revision_id }
      await store2.appendSource(
        ctxP2,
        SourceRecordSchema.parse({
          source_id: 'durable-after-reopen',
          kind: 'web',
          canonical_key: 'durable',
          observed_urls: ['https://example.test/durable'],
        }),
      )
      await store2.close()

      const store3 = await DurableResearchStore.open(dir)
      const events = await store3.listEvents(exampleTechnicalMissionFixture.mission_id)
      assert.equal(events.filter((e) => e.kind === 'plan_revised').length, 2)
      assert.ok(
        events.some(
          (e) =>
            e.kind === 'source_recorded' &&
            (e.payload as { source?: { source_id?: string } }).source?.source_id ===
              'durable-after-reopen',
        ),
      )
      await assert.rejects(
        () =>
          store3.acquireWriterOwnership({
            mission_id: handle.mission_id,
            expected_writer_generation: acquired.writer_generation - 1,
          }),
        (e: unknown) => e instanceof StoreContractError,
      )
      const bumped = await store3.acquireWriterOwnership({
        mission_id: handle.mission_id,
        expected_writer_generation: acquired.writer_generation,
      })
      assert.equal(bumped.writer_generation, acquired.writer_generation + 1)
      await store3.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists terminal fence, late accounting, and host resume across reopen', async () => {
    const dir = await withTempStoreDir()
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const acquired = await store.acquireWriterOwnership({
        mission_id: handle.mission_id,
        expected_writer_generation: handle.writer_generation,
      })
      const ctxP1 = {
        ...exampleMissionWriteContext,
        writer_generation: acquired.writer_generation,
        plan_revision_id: planP1.plan_revision_id,
      }
      await store.appendPlanRevision(ctxP1, planP1)
      await store.appendPlanRevision(ctxP1, planP2)
      const ctxP2 = { ...ctxP1, plan_revision_id: planP2.plan_revision_id }

      const billOp = 'run-op-bill-durable'
      const billAttempt = 'run-att-bill-durable'
      await store.appendExternalOperationIntent(ctxP2, {
        mission_id: ctxP2.mission_id,
        operation_id: billOp,
        attempt_id: billAttempt,
        operation_kind: 'model_invoke',
        dispatched_at: '2026-10-20T12:02:00.000Z',
        idempotency_key: 'run-bill-durable',
      })
      await store.appendTerminalReport(
        ctxP2,
        ResearchReportV2Schema.parse({
          mission_id: ctxP2.mission_id,
          plan_revision_id: planP2.plan_revision_id,
          terminal_state: 'cancelled',
          answer_summary: 'cancelled before reopen',
          unanswered_questions: [],
          coverage_notes: 'durable slice',
          limitations: [],
          source_cutoff: 'unknown',
          acceptance_state: 'not_accepted',
          stopping_reason: 'user_cancel',
          finding_ids: [],
          citation_passage_ids: [],
          generated_at: '2026-10-20T12:03:00.000Z',
        }),
      )
      await store.close()

      store = await DurableResearchStore.open(dir)
      const reconcileCtx = {
        ...ctxP2,
        write_authority: 'usage_reconciliation' as const,
      }
      await store.appendExternalOperationReconciled(reconcileCtx, {
        mission_id: ctxP2.mission_id,
        operation_id: billOp,
        attempt_id: billAttempt,
        reconciled_at: '2026-10-20T12:04:00.000Z',
        prior_settlement: 'uncertain',
        resolved_settlement: 'cancelled',
        usage_settlement: {
          attempt_id: billAttempt,
          cost: { status: 'reported', amount_usd: 0.01, currency: 'USD' },
        },
        rationale: 'late bill after cancel (durable)',
      })
      await store.close()

      store = await DurableResearchStore.open(dir)
      const generationBeforeResume = ctxP2.writer_generation
      const resumed = await store.resumeResearchContinuation({
        mission_id: ctxP2.mission_id,
        expected_writer_generation: generationBeforeResume,
        host_authorization_ref: 'host-ops/durable-resume',
        acknowledged_plan_revision_id: planP2.plan_revision_id,
        acknowledged_terminal_state: 'cancelled',
      })
      const ctxContinued = {
        ...ctxP2,
        writer_generation: resumed.writer_generation,
      }
      await store.appendSource(
        ctxContinued,
        SourceRecordSchema.parse({
          source_id: 'post-resume-durable',
          kind: 'web',
          canonical_key: 'post-resume-durable',
          observed_urls: ['https://example.test/post-durable'],
        }),
      )
      await store.close()

      store = await DurableResearchStore.open(dir)
      const events = await store.listEvents(ctxP2.mission_id)
      assert.equal(events.filter((e) => e.kind === 'external_operation_reconciled').length, 1)
      assert.equal(events.filter((e) => e.kind === 'research_continuation_resumed').length, 1)
      assert.ok(
        events.some(
          (e) =>
            e.kind === 'source_recorded' &&
            (e.payload as { source?: { source_id?: string } }).source?.source_id ===
              'post-resume-durable',
        ),
      )
      await store.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
