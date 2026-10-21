import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { ResearchEngineSession } from './researchEngineSession.js'
import { finalizeCancelledOwnerRunAndClose } from './ownerSessionCancellationFinalize.js'
import { finalizeOwnerResearchRunCancellation } from './finalizeOwnerResearchRunCancellation.js'
import { fixtureModelForOfflineRun } from '../cli/researchV2FixtureRunModel.js'

describe('ownerSessionCancellationFinalize', () => {
  it('pre-bootstrap cancel: mission without plan yields pre_bootstrap_no_active_plan and no terminal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-research-v2-pre-bootstrap-cancel-'))
    const abort = new AbortController()
    try {
      const owner = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: fixtureModelForOfflineRun(),
      })
      await owner.appendMission(exampleTechnicalMissionFixture)
      abort.abort()
      const outcome = await finalizeCancelledOwnerRunAndClose({
        owner,
        mission: exampleTechnicalMissionFixture,
        missionAppended: true,
        signal: abort.signal,
      })
      assert.deepEqual(outcome, {
        cancellation_finalize: {
          status: 'not_appended',
          reason: 'pre_bootstrap_no_active_plan',
        },
      })
      const events = await owner.store.listEvents(exampleTechnicalMissionFixture.mission_id)
      assert.equal(events.filter((e) => e.kind === 'terminal_receipt').length, 0)
      await owner.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('finalizeOwnerResearchRunCancellation reports pre_bootstrap_no_active_plan directly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-research-v2-pre-bootstrap-direct-'))
    try {
      const owner = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: fixtureModelForOfflineRun(),
      })
      await owner.appendMission(exampleTechnicalMissionFixture)
      const outcome = await finalizeOwnerResearchRunCancellation({
        store: owner.store,
        mission: exampleTechnicalMissionFixture,
      })
      assert.deepEqual(outcome, {
        status: 'not_appended',
        reason: 'pre_bootstrap_no_active_plan',
      })
      await owner.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
