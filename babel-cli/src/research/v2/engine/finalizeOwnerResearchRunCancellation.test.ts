import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runResearchV2MissionWithOwnerSession } from '../cli/researchV2MissionRun.js'
import { finalizeOwnerResearchRunCancellation } from './finalizeOwnerResearchRunCancellation.js'
import { ResearchEngineSession } from './researchEngineSession.js'
import { openAdmittedInspectStore } from '../control/researchStoreAdmission.js'
import { submitAdmittedOwnerCancelRequest } from '../control/storeCancelRequest.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import type { ResearchModelPort } from '../ports/researchModelPort.js'
import { runResearchV2EnginePassOnOwner } from '../cli/researchV2MissionRun.js'

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
})
