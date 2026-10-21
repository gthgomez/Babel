/**
 * Union evidence: A bootstrap shell (8dd8807d) + B runner latch patterns.
 * Covers windows before model inference — not during-inference cancel (ModelEntryLatch).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runResearchV2MissionWithOwnerSession } from '../cli/researchV2MissionRun.js'
import { openAdmittedInspectStore } from '../control/researchStoreAdmission.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { ResearchEngineSession } from './researchEngineSession.js'
import { finalizeCancelledOwnerRunAndClose } from './ownerSessionCancellationFinalize.js'
import type { ResearchModelPort } from '../ports/researchModelPort.js'

class InvokeCountingModel implements ResearchModelPort {
  constructor(public invokeCount = 0) {}

  async invokeStructured(request: Parameters<ResearchModelPort['invokeStructured']>[0]) {
    this.invokeCount += 1
    return {
      status: 'cancelled' as const,
      operationId: request.operationId,
      usageSettlement: { attempt_id: request.attemptId, cost: { status: 'unknown' as const } },
    }
  }
}

async function assertOwnerReleased(storeDirectory: string): Promise<void> {
  const inspect = await openAdmittedInspectStore(storeDirectory)
  assert.equal(inspect.sessionControl, null, 'owner session control must be released after close')
}

describe('early cancel bootstrap union reciprocal (actual runner, offline)', () => {
  it('prior-aborted signal: bootstrap shell admitted, zero model calls, cancelled terminal after reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-early-cancel-prior-abort-'))
    const aborted = new AbortController()
    aborted.abort()
    const model = new InvokeCountingModel()
    const planId = 'plan-union-prior-abort'
    try {
      await assert.rejects(() =>
        runResearchV2MissionWithOwnerSession({
          storeDirectory: dir,
          mission: exampleTechnicalMissionFixture,
          discoverQuery: 'RESEARCH_CONTRACT',
          injectedOffline: true,
          planRevisionId: planId,
          signal: aborted.signal,
          model,
        }),
      )
      assert.equal(model.invokeCount, 0)

      const reopened = await ResearchEngineSession.openInspect(dir)
      const events = await reopened.listEvents(exampleTechnicalMissionFixture.mission_id)
      const terminals = events.filter((e) => e.kind === 'terminal_receipt')
      assert.equal(terminals.length, 1)
      const report = (terminals[0]!.payload as { report: { terminal_state: string; plan_revision_id: string } })
        .report
      assert.equal(report.terminal_state, 'cancelled')
      assert.equal(report.plan_revision_id, `${planId}-bootstrap`)
      assert.ok(events.some((e) => e.kind === 'plan_revised'))
      await assertOwnerReleased(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('mission admitted before bootstrap init: zero model calls, no terminal until shell, owner released', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-early-cancel-pre-bootstrap-barrier-'))
    const cancel = new AbortController()
    cancel.abort()
    const model = new InvokeCountingModel()
    const planId = 'plan-union-pre-bootstrap-barrier'
    try {
      const owner = await ResearchEngineSession.openOwner({ storeDirectory: dir, model })
      const handle = await owner.appendMission(exampleTechnicalMissionFixture)
      const closeOutcome = await finalizeCancelledOwnerRunAndClose({
        owner,
        mission: exampleTechnicalMissionFixture,
        missionAppended: true,
        signal: cancel.signal,
      })
      assert.equal(model.invokeCount, 0)
      assert.equal(closeOutcome.cancellation_finalize.status, 'not_appended')
      if (closeOutcome.cancellation_finalize.status === 'not_appended') {
        assert.equal(
          closeOutcome.cancellation_finalize.reason,
          'pre_bootstrap_no_active_plan',
        )
      }

      const eventsBeforeClose = await owner.store.listEvents(exampleTechnicalMissionFixture.mission_id)
      assert.equal(eventsBeforeClose.filter((e) => e.kind === 'terminal_receipt').length, 0)
      assert.equal(eventsBeforeClose.filter((e) => e.kind === 'plan_revised').length, 0)
      await owner.close()

      const reopened = await ResearchEngineSession.openInspect(dir)
      const events = await reopened.listEvents(exampleTechnicalMissionFixture.mission_id)
      assert.equal(events.filter((e) => e.kind === 'terminal_receipt').length, 0)
      assert.ok(events.some((e) => e.kind === 'mission_created'))
      await assertOwnerReleased(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
