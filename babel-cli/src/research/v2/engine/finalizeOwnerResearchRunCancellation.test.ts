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
  constructor(
    private readonly inner = new FixtureResearchModelBridge(),
    private readonly onModelEntry?: (kind: string) => void,
  ) {}

  async invokeStructured(request: Parameters<ResearchModelPort['invokeStructured']>[0]) {
    this.onModelEntry?.(request.kind)
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
      assert.equal(appended.status, 'terminal_appended')
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
      assert.ok(firstAttempts.some((id) => id.includes('cli-run-plan-att-wg')))

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
      const firstPlanAttempt = firstAttempts.find((id) => /^cli-run-plan-att-wg\d+-/.test(id))
      const secondPlanAttempt = secondAttempts.find((id) =>
        id.startsWith(`cli-run-plan-att-wg${resumed.writer_generation}-`),
      )
      assert.ok(firstPlanAttempt)
      assert.ok(secondPlanAttempt)
      assert.notEqual(firstPlanAttempt, secondPlanAttempt)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('early cancel during plan_questions persists cancelled terminal after durable store reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-research-v2-early-cancel-reopen-'))
    let planQuestionsEntered = false
    const model = new BlockingUntilAbortModel(undefined, (kind) => {
      if (kind === 'plan_questions') {
        planQuestionsEntered = true
      }
    })
    try {
      const runPromise = runResearchV2MissionWithOwnerSession({
        storeDirectory: dir,
        mission: exampleTechnicalMissionFixture,
        discoverQuery: 'RESEARCH_CONTRACT',
        injectedOffline: true,
        planRevisionId: 'plan-early-cancel-reopen',
        model,
      })

      for (let i = 0; i < 80; i += 1) {
        await new Promise((r) => setTimeout(r, 25))
        if (planQuestionsEntered) break
      }
      assert.equal(planQuestionsEntered, true, 'expected model plan_questions entry latch')

      let sessionId = ''
      for (let i = 0; i < 40; i += 1) {
        const inspect = await openAdmittedInspectStore(dir)
        sessionId = inspect.sessionControl?.session_id ?? ''
        if (sessionId) break
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(sessionId.length > 0)
      await submitAdmittedOwnerCancelRequest(dir, sessionId)

      await assert.rejects(() => runPromise)

      const reopened = await ResearchEngineSession.openInspect(dir)
      const events = await reopened.listEvents(exampleTechnicalMissionFixture.mission_id)
      const plans = events.filter((e) => e.kind === 'plan_revised')
      assert.ok(plans.length >= 1)
      const terminals = events.filter((e) => e.kind === 'terminal_receipt')
      assert.equal(terminals.length, 1)
      const report = (terminals[0]!.payload as { report: { terminal_state: string; plan_revision_id: string } })
        .report
      assert.equal(report.terminal_state, 'cancelled')
      assert.equal(report.plan_revision_id, 'plan-early-cancel-reopen-bootstrap')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('B regression 1693fb0d: watcher cancel → resume → planning cancel → second resume opens third owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-research-v2-b1693fb0d-'))
    const model = new BlockingUntilAbortModel()
    const planBase = 'plan-b1693fb0d-cancel-resume-twice'
    try {
      const firstRun = runResearchV2MissionWithOwnerSession({
        storeDirectory: dir,
        mission: exampleTechnicalMissionFixture,
        discoverQuery: 'RESEARCH_CONTRACT',
        injectedOffline: true,
        planRevisionId: planBase,
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

      const inspect1 = await ResearchEngineSession.openInspect(dir)
      const terminals1 = (await inspect1.listEvents(exampleTechnicalMissionFixture.mission_id)).filter(
        (e) => e.kind === 'terminal_receipt',
      )
      assert.equal(terminals1.length, 1)
      const cancelled1 = (terminals1[0]!.payload as { report: { plan_revision_id: string } }).report

      const owner2 = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: fixtureModelForOfflineRun(),
      })
      const fence1 = owner2.store.readMissionWriteFence(exampleTechnicalMissionFixture.mission_id)
      const resumed1 = await owner2.resumeResearchContinuation({
        mission_id: exampleTechnicalMissionFixture.mission_id,
        expected_writer_generation: fence1.writer_generation,
        host_authorization_ref: 'test-host/b1693fb0d-resume-1',
        acknowledged_plan_revision_id: cancelled1.plan_revision_id,
        acknowledged_terminal_state: 'cancelled',
      })
      const cancel2 = new AbortController()
      const watcher2 = owner2.watchExternalCancelRequests(cancel2)
      const continued1 = `${cancelled1.plan_revision_id}-continued`
      const secondRun = runResearchV2EnginePassOnOwner({
        owner: owner2,
        mission: exampleTechnicalMissionFixture,
        handle: resumed1,
        discoverQuery: 'RESEARCH_CONTRACT',
        injectedOffline: true,
        activePlanRevisionId: cancelled1.plan_revision_id,
        planRevisionId: continued1,
        signal: cancel2.signal,
        model,
      })
      await new Promise((r) => setTimeout(r, 40))
      cancel2.abort()
      watcher2.stop()
      await assert.rejects(() => secondRun)
      await finalizeOwnerResearchRunCancellation({
        store: owner2.store,
        mission: exampleTechnicalMissionFixture,
      })
      const fence2 = owner2.store.readMissionWriteFence(exampleTechnicalMissionFixture.mission_id)
      const events2 = await owner2.store.listEvents(exampleTechnicalMissionFixture.mission_id)
      assert.equal(events2.filter((e) => e.kind === 'terminal_receipt').length, 2)
      const cancelled2 = (
        events2.filter((e) => e.kind === 'terminal_receipt').at(-1)!.payload as {
          report: { plan_revision_id: string }
        }
      ).report
      await owner2.close()

      const owner3 = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: fixtureModelForOfflineRun(),
      })
      const resumed2 = await owner3.resumeResearchContinuation({
        mission_id: exampleTechnicalMissionFixture.mission_id,
        expected_writer_generation: fence2.writer_generation,
        host_authorization_ref: 'test-host/b1693fb0d-resume-2',
        acknowledged_plan_revision_id: cancelled2.plan_revision_id,
        acknowledged_terminal_state: 'cancelled',
      })
      assert.ok(resumed2.writer_generation > resumed1.writer_generation)
      await owner3.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
