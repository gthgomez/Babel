/**
 * X-L1 owner lifecycle harness (offline, injected model).
 * Exercises supported owner cancel + durable cancelled terminal + authorized resume.
 * Not the CLI cancel-resume-once fixture journey (that manually manufactures terminal state).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  runResearchV2EnginePassOnOwner,
  runResearchV2MissionWithOwnerSession,
} from '../cli/researchV2MissionRun.js'
import { finalizeOwnerResearchRunCancellation } from '../engine/finalizeOwnerResearchRunCancellation.js'
import { ResearchEngineSession } from '../engine/researchEngineSession.js'
import { openAdmittedInspectStore } from '../control/researchStoreAdmission.js'
import { submitAdmittedOwnerCancelRequest } from '../control/storeCancelRequest.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { fixtureModelForOfflineRun } from '../cli/researchV2FixtureRunModel.js'
import {
  BlockingUntilAbortModel,
  ModelEntryLatch,
} from '../engine/testSupport/lifecycleModelEntryLatch.js'

describe('X-L1 owner lifecycle harness (offline, maps_to_acceptance_scenario X-L1)', () => {
  it('starts mission, observes active owner session, cancels, awaits cancelled terminal, resumes once with authorization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-x-l1-lifecycle-'))
    const latch = new ModelEntryLatch()
    const model = new BlockingUntilAbortModel(latch)
    const planRevisionId = 'plan-x-l1-lifecycle-001'
    try {
      const runPromise = runResearchV2MissionWithOwnerSession({
        storeDirectory: dir,
        mission: exampleTechnicalMissionFixture,
        discoverQuery: 'RESEARCH_CONTRACT',
        injectedOffline: true,
        planRevisionId,
        model,
      })

      await latch.waitForModelEntry()
      const inspectBeforeCancel = await openAdmittedInspectStore(dir)
      const sessionId = inspectBeforeCancel.sessionControl?.session_id ?? ''
      assert.ok(sessionId.length > 0, 'owner session must exist once planning model entry is latched')

      await submitAdmittedOwnerCancelRequest(dir, sessionId)
      await assert.rejects(() => runPromise)

      const inspectAfterCancel = await ResearchEngineSession.openInspect(dir)
      const eventsAfterCancel = await inspectAfterCancel.listEvents(exampleTechnicalMissionFixture.mission_id)
      const terminals = eventsAfterCancel.filter((e) => e.kind === 'terminal_receipt')
      assert.equal(terminals.length, 1)
      const cancelledReport = (terminals[0]!.payload as { report: { terminal_state: string; plan_revision_id: string } })
        .report
      assert.equal(cancelledReport.terminal_state, 'cancelled')

      const owner = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: fixtureModelForOfflineRun(),
      })
      const fence = owner.store.readMissionWriteFence(exampleTechnicalMissionFixture.mission_id)
      const resumed = await owner.resumeResearchContinuation({
        mission_id: exampleTechnicalMissionFixture.mission_id,
        expected_writer_generation: fence.writer_generation,
        host_authorization_ref: 'test-host/x-l1-lifecycle',
        acknowledged_plan_revision_id: cancelledReport.plan_revision_id,
        acknowledged_terminal_state: 'cancelled',
      })
      assert.ok(resumed.writer_generation >= fence.writer_generation)

      const continuationPass = await runResearchV2EnginePassOnOwner({
        owner,
        mission: exampleTechnicalMissionFixture,
        handle: resumed,
        discoverQuery: 'RESEARCH_CONTRACT',
        injectedOffline: true,
        activePlanRevisionId: cancelledReport.plan_revision_id,
        planRevisionId: `${cancelledReport.plan_revision_id}-continued`,
        signal: new AbortController().signal,
        model: fixtureModelForOfflineRun(),
      })
      assert.equal(continuationPass.terminal_report_emitted, true)
      const eventsAfterResume = await owner.store.listEvents(exampleTechnicalMissionFixture.mission_id)
      const terminalsAfterResume = eventsAfterResume.filter((e) => e.kind === 'terminal_receipt')
      assert.ok(terminalsAfterResume.length >= 2)
      const latestTerminal = (terminalsAfterResume.at(-1)!.payload as { report: { terminal_state: string } }).report
      assert.ok(
        latestTerminal.terminal_state === 'complete' || latestTerminal.terminal_state === 'partial',
        `continuation terminal must settle (${latestTerminal.terminal_state})`,
      )
      await owner.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('aborts before planning bootstrap without persisting bootstrap plan revision', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-x-l1-pre-bootstrap-'))
    const aborted = new AbortController()
    aborted.abort()
    try {
      const owner = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: fixtureModelForOfflineRun(),
      })
      const handle = await owner.appendMission(exampleTechnicalMissionFixture)
      await assert.rejects(
        () =>
          runResearchV2EnginePassOnOwner({
            owner,
            mission: exampleTechnicalMissionFixture,
            handle,
            discoverQuery: 'RESEARCH_CONTRACT',
            injectedOffline: true,
            planRevisionId: 'plan-x-l1-pre-bootstrap',
            signal: aborted.signal,
            model: fixtureModelForOfflineRun(),
          }),
        /planning iteration aborted/,
      )
      const events = await owner.store.listEvents(exampleTechnicalMissionFixture.mission_id)
      assert.equal(events.filter((e) => e.kind === 'plan_revised').length, 0)
      await owner.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
