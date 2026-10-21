/**
 * Engine/control slice — admitted inspect + stale recovery + cancel/resume on durable store.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DurableStoreBusyError } from '../persistence/durableStoreErrors.js'
import { DurableResearchStore } from '../persistence/durableResearchStore.js'
import { dirname, join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StoreAdmissionError } from '../control/researchStoreAdmission.js'
import {
  exampleMissionWriteContext,
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'
import { ResearchReportV2Schema } from '../contracts/plan.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import { ResearchEngineSession } from './researchEngineSession.js'

const planP1 = examplePlanRevisionFixture
const planP2 = {
  ...examplePlanRevisionFixture,
  plan_revision_id: 'plan-engine-002',
  revision_reason: 'refined_scope',
}

const controlTestDir = dirname(fileURLToPath(import.meta.url))

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'babel-research-v2-engine-'))
}

function runOwnerChildExit(storeDirectory: string): Promise<void> {
  const scriptPath = joinPath(controlTestDir, '../control/testworkers/ownerChildExit.ts')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, storeDirectory], {
      stdio: 'ignore',
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`owner child exited with code ${code}`))
    })
  })
}

describe('research engine cancel/resume control (M1.3 slice)', () => {
  it('inspect session reads terminal state without owner lock', async () => {
    const dir = await tempDir()
    const model = new FixtureResearchModelBridge()
    try {
      const owner = await ResearchEngineSession.openOwner({ storeDirectory: dir, model })
      const handle = await owner.appendMission(exampleTechnicalMissionFixture)
      const acquired = await owner.acquireWriterOwnership({
        mission_id: handle.mission_id,
        expected_writer_generation: handle.writer_generation,
      })
      const ctx = {
        ...exampleMissionWriteContext,
        writer_generation: acquired.writer_generation,
        plan_revision_id: planP1.plan_revision_id,
      }
      await owner.store.appendPlanRevision(ctx, planP1)
      await owner.appendTerminalReport(
        ctx,
        ResearchReportV2Schema.parse({
          mission_id: ctx.mission_id,
          plan_revision_id: planP1.plan_revision_id,
          terminal_state: 'cancelled',
          answer_summary: 'cancelled for inspect',
          unanswered_questions: [],
          coverage_notes: 'engine inspect',
          limitations: [],
          source_cutoff: 'unknown',
          acceptance_state: 'not_accepted',
          stopping_reason: 'user_cancel',
          finding_ids: [],
          citation_passage_ids: [],
          generated_at: '2026-10-20T12:03:00.000Z',
        }),
      )
      await assert.rejects(
        () => DurableResearchStore.open(dir),
        (e: unknown) => e instanceof DurableStoreBusyError,
      )
      const inspect = await ResearchEngineSession.openInspect(dir)
      const events = await inspect.listEvents(exampleTechnicalMissionFixture.mission_id)
      assert.ok(events.some((e) => e.kind === 'terminal_receipt'))
      assert.ok(inspect.sessionControl?.session_id)
      await owner.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('admitted stale recovery then host resume continuation journey', async () => {
    const dir = await tempDir()
    const model = new FixtureResearchModelBridge()
    try {
      let owner = await ResearchEngineSession.openOwner({ storeDirectory: dir, model })
      const handle = await owner.appendMission(exampleTechnicalMissionFixture)
      const acquired = await owner.acquireWriterOwnership({
        mission_id: handle.mission_id,
        expected_writer_generation: handle.writer_generation,
      })
      let ctx = {
        ...exampleMissionWriteContext,
        writer_generation: acquired.writer_generation,
        plan_revision_id: planP1.plan_revision_id,
      }
      await owner.store.appendPlanRevision(ctx, planP1)
      await owner.store.appendPlanRevision(ctx, planP2)
      ctx = { ...ctx, plan_revision_id: planP2.plan_revision_id }

      const billOp = 'engine-op-bill'
      const billAttempt = 'engine-att-bill'
      await owner.store.appendExternalOperationIntent(ctx, {
        mission_id: ctx.mission_id,
        operation_id: billOp,
        attempt_id: billAttempt,
        operation_kind: 'model_invoke',
        dispatched_at: '2026-10-20T12:02:00.000Z',
        idempotency_key: 'engine-bill',
      })

      await owner.appendTerminalReport(
        ctx,
        ResearchReportV2Schema.parse({
          mission_id: ctx.mission_id,
          plan_revision_id: planP2.plan_revision_id,
          terminal_state: 'cancelled',
          answer_summary: 'cancelled before recovery',
          unanswered_questions: [],
          coverage_notes: 'stale recovery slice',
          limitations: [],
          source_cutoff: 'unknown',
          acceptance_state: 'not_accepted',
          stopping_reason: 'user_cancel',
          finding_ids: [],
          citation_passage_ids: [],
          generated_at: '2026-10-20T12:03:00.000Z',
        }),
      )

      await owner.close()

      await runOwnerChildExit(dir)
      const orphanedSessionId = (
        await readFile(join(dir, '.child-owner-session'), 'utf8')
      ).trim()

      await assert.rejects(
        () =>
          ResearchEngineSession.admitStaleOwnerRecovery(dir, {
            host_authorization_ref: 'host-ops/stale-1',
            acknowledged_session_id: 'wrong-session',
          }),
        (e: unknown) => e instanceof StoreAdmissionError,
      )

      await ResearchEngineSession.admitStaleOwnerRecovery(dir, {
        host_authorization_ref: 'host-ops/stale-1',
        acknowledged_session_id: orphanedSessionId,
      })

      owner = await ResearchEngineSession.openOwner({ storeDirectory: dir, model })
      const reconcileCtx = { ...ctx, write_authority: 'usage_reconciliation' as const }
      await owner.store.appendExternalOperationReconciled(reconcileCtx, {
        mission_id: ctx.mission_id,
        operation_id: billOp,
        attempt_id: billAttempt,
        reconciled_at: '2026-10-20T12:04:00.000Z',
        prior_settlement: 'uncertain',
        resolved_settlement: 'cancelled',
        usage_settlement: {
          attempt_id: billAttempt,
          cost: { status: 'reported', amount_usd: 0.01, currency: 'USD' },
        },
        rationale: 'late bill after cancel (engine)',
      })

      const generationBeforeResume = ctx.writer_generation
      const resumed = await owner.resumeResearchContinuation({
        mission_id: ctx.mission_id,
        expected_writer_generation: generationBeforeResume,
        host_authorization_ref: 'host-ops/resume-1',
        acknowledged_plan_revision_id: planP2.plan_revision_id,
        acknowledged_terminal_state: 'cancelled',
      })
      const ctxContinued = { ...ctx, writer_generation: resumed.writer_generation }
      await owner.store.appendTerminalReport(
        ctxContinued,
        ResearchReportV2Schema.parse({
          mission_id: ctxContinued.mission_id,
          plan_revision_id: planP2.plan_revision_id,
          terminal_state: 'complete',
          answer_summary: 'completed after admitted recovery',
          unanswered_questions: [],
          coverage_notes: 'engine journey',
          limitations: [],
          source_cutoff: 'unknown',
          acceptance_state: 'accepted_with_limitations',
          stopping_reason: 'coverage_sufficient',
          finding_ids: [],
          citation_passage_ids: [],
          generated_at: '2026-10-20T12:10:00.000Z',
        }),
      )
      await owner.close()

      const inspect = await ResearchEngineSession.openInspect(dir)
      const events = await inspect.listEvents(ctx.mission_id)
      assert.equal(events.filter((e) => e.kind === 'terminal_receipt').length, 2)
      assert.equal(events.filter((e) => e.kind === 'research_continuation_resumed').length, 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('model bridge invokes fixture structured output with attempt id', async () => {
    const model = new FixtureResearchModelBridge()
    model.scriptOutput('plan-op-1', {
      kind: 'plan_questions',
      questions: [{ text: 'What changed?', importance: 'high' }],
    })
    const result = await model.invokeStructured({
      operationId: 'plan-op-1',
      attemptId: 'plan-att-1',
      kind: 'plan_questions',
      input: {},
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
  })
})
