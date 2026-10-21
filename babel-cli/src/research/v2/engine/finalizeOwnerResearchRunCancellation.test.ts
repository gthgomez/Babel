import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  runResearchV2EnginePassOnOwner,
  runResearchV2MissionWithOwnerSession,
} from '../cli/researchV2MissionRun.js'
import { finalizeOwnerResearchRunCancellation } from './finalizeOwnerResearchRunCancellation.js'
import { ResearchEngineSession } from './researchEngineSession.js'
import { openAdmittedInspectStore } from '../control/researchStoreAdmission.js'
import { submitAdmittedOwnerCancelRequest } from '../control/storeCancelRequest.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { fixtureModelForOfflineRun } from '../cli/researchV2FixtureRunModel.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import type { ResearchModelPort } from '../ports/researchModelPort.js'

class BlockingUntilAbortModel implements ResearchModelPort {
  constructor(private readonly inner = new FixtureResearchModelBridge()) {}

  async invokeStructured(request: Parameters<ResearchModelPort['invokeStructured']>[0]) {
    await new Promise<void>((resolve) => {
      if (request.signal.aborted) {
        resolve()
        return
      }
      const onAbort = (): void => {
        request.signal.removeEventListener('abort', onAbort)
        resolve()
      }
      request.signal.addEventListener('abort', onAbort)
    })
    if (request.signal.aborted) {
      return {
        status: 'cancelled' as const,
        operationId: request.operationId,
        usageSettlement: { attempt_id: request.attemptId, cost: { status: 'unknown' as const } },
      }
    }
    return this.inner.invokeStructured(request)
  }
}

describe('finalizeOwnerResearchRunCancellation', () => {
  it('settles pending model intent and appends cancelled terminal receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-research-v2-owner-cancel-'))
    const model = new BlockingUntilAbortModel()
    const abortController = new AbortController()
    try {
      const owner = await ResearchEngineSession.openOwner({ storeDirectory: dir, model })
      const watcher = owner.watchExternalCancelRequests(abortController)
      const handle = await owner.appendMission(exampleTechnicalMissionFixture)
      const runPromise = runResearchV2EnginePassOnOwner({
        owner,
        mission: exampleTechnicalMissionFixture,
        handle,
        discoverQuery: 'RESEARCH_CONTRACT',
        injectedOffline: true,
        planRevisionId: 'plan-owner-cancel-001',
        signal: abortController.signal,
        model,
      })
      await new Promise((r) => setTimeout(r, 30))
      abortController.abort()
      await assert.rejects(() => runPromise)
      watcher.stop()
      const appended = await finalizeOwnerResearchRunCancellation({
        store: owner.store,
        mission: exampleTechnicalMissionFixture,
        now: () => '2026-10-21T12:00:00.000Z',
      })
      assert.equal(appended, true)
      const events = await owner.store.listEvents(exampleTechnicalMissionFixture.mission_id)
      const terminals = events.filter((e) => e.kind === 'terminal_receipt')
      assert.equal(terminals.length, 1)
      const report = (terminals[0]!.payload as { report: { terminal_state: string } }).report
      assert.equal(report.terminal_state, 'cancelled')
      const completed = events.filter((e) => e.kind === 'external_operation_completed')
      assert.ok(completed.length >= 1)
      await owner.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runResearchV2MissionWithOwnerSession persists cancelled terminal when external cancel aborts inference', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-research-v2-owner-cancel-run-'))
    const model = new BlockingUntilAbortModel()
    try {
      const runPromise = runResearchV2MissionWithOwnerSession({
        storeDirectory: dir,
        mission: exampleTechnicalMissionFixture,
        discoverQuery: 'RESEARCH_CONTRACT',
        injectedOffline: true,
        planRevisionId: 'plan-owner-cancel-run-001',
        model,
      })

      let sessionId = ''
      for (let i = 0; i < 50; i += 1) {
        await new Promise((r) => setTimeout(r, 20))
        const inspect = await openAdmittedInspectStore(dir)
        sessionId = inspect.sessionControl?.session_id ?? ''
        if (sessionId) break
      }
      assert.ok(sessionId.length > 0)
      await submitAdmittedOwnerCancelRequest(dir, sessionId)
      await assert.rejects(() => runPromise)

      const inspect = await ResearchEngineSession.openInspect(dir)
      const events = await inspect.listEvents(exampleTechnicalMissionFixture.mission_id)
      const terminals = events.filter((e) => e.kind === 'terminal_receipt')
      assert.equal(terminals.length, 1)
      const report = (terminals[0]!.payload as { report: { terminal_state: string } }).report
      assert.equal(report.terminal_state, 'cancelled')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cancel → resume continuation → cancel uses distinct attempt ids and real terminal receipts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-research-v2-cancel-resume-cancel-'))
    const model = new BlockingUntilAbortModel()
    try {
      const firstRun = runResearchV2MissionWithOwnerSession({
        storeDirectory: dir,
        mission: exampleTechnicalMissionFixture,
        discoverQuery: 'RESEARCH_CONTRACT',
        injectedOffline: true,
        planRevisionId: 'plan-cancel-resume-001',
        model,
      })
      let sessionId = ''
      for (let i = 0; i < 50; i += 1) {
        await new Promise((r) => setTimeout(r, 20))
        const inspect = await openAdmittedInspectStore(dir)
        sessionId = inspect.sessionControl?.session_id ?? ''
        if (sessionId) break
      }
      assert.ok(sessionId)
      await submitAdmittedOwnerCancelRequest(dir, sessionId)
      await assert.rejects(() => firstRun)

      const inspectAfterFirst = await ResearchEngineSession.openInspect(dir)
      const eventsAfterFirst = await inspectAfterFirst.listEvents(exampleTechnicalMissionFixture.mission_id)
      const firstTerminals = eventsAfterFirst.filter((e) => e.kind === 'terminal_receipt')
      assert.equal(firstTerminals.length, 1)
      const cancelledReport = (firstTerminals[0]!.payload as { report: { plan_revision_id: string } })
        .report
      const firstAttempts = eventsAfterFirst
        .filter((e) => e.kind === 'external_operation_intent')
        .map((e) => (e.payload as { intent: { attempt_id: string } }).intent.attempt_id)
      assert.ok(firstAttempts.some((id) => id.includes('plan-cancel-resume-001')))

      const owner = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: fixtureModelForOfflineRun(),
      })
      const fence = owner.store.readMissionWriteFence(exampleTechnicalMissionFixture.mission_id)
      const resumed = await owner.resumeResearchContinuation({
        mission_id: exampleTechnicalMissionFixture.mission_id,
        expected_writer_generation: fence.writer_generation,
        host_authorization_ref: 'test-host/cancel-resume',
        acknowledged_plan_revision_id: cancelledReport.plan_revision_id,
        acknowledged_terminal_state: 'cancelled',
      })
      const cancelController = new AbortController()
      const watcher = owner.watchExternalCancelRequests(cancelController)
      const continuedPlanId = `${cancelledReport.plan_revision_id}-continued`
      const secondRun = runResearchV2EnginePassOnOwner({
        owner,
        mission: exampleTechnicalMissionFixture,
        handle: resumed,
        discoverQuery: 'RESEARCH_CONTRACT',
        injectedOffline: true,
        activePlanRevisionId: cancelledReport.plan_revision_id,
        planRevisionId: continuedPlanId,
        signal: cancelController.signal,
        model,
      })
      await new Promise((r) => setTimeout(r, 40))
      cancelController.abort()
      watcher.stop()
      await assert.rejects(() => secondRun)
      await finalizeOwnerResearchRunCancellation({
        store: owner.store,
        mission: exampleTechnicalMissionFixture,
      })
      await owner.close()

      const inspectFinal = await ResearchEngineSession.openInspect(dir)
      const eventsFinal = await inspectFinal.listEvents(exampleTechnicalMissionFixture.mission_id)
      const terminals = eventsFinal.filter((e) => e.kind === 'terminal_receipt')
      assert.equal(terminals.length, 2)
      const secondAttempts = eventsFinal
        .filter((e) => e.kind === 'external_operation_intent')
        .map((e) => (e.payload as { intent: { attempt_id: string } }).intent.attempt_id)
      const firstPlanAttempt = firstAttempts.find((id) => id.includes('cli-run-plan-att'))
      const secondPlanAttempt = secondAttempts.find((id) => id.includes(continuedPlanId))
      assert.ok(firstPlanAttempt)
      assert.ok(secondPlanAttempt)
      assert.notEqual(firstPlanAttempt, secondPlanAttempt)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
