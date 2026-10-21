import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { ResearchEngineSession } from './researchEngineSession.js'
import { ensureAdmittedBootstrapPlanShell } from './admittedBootstrapPlanShell.js'

describe('ensureAdmittedBootstrapPlanShell', () => {
  it('appends bootstrap shell once and exposes active plan revision on fence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-research-v2-bootstrap-shell-'))
    try {
      const owner = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: { invokeStructured: async () => ({ status: 'cancelled', operationId: 'x', usageSettlement: { attempt_id: 'a', cost: { status: 'unknown' } } }) },
      })
      const handle = await owner.appendMission(exampleTechnicalMissionFixture)
      const first = await ensureAdmittedBootstrapPlanShell({
        store: owner.store,
        mission: exampleTechnicalMissionFixture,
        handle,
        planRevisionId: 'plan-shell-test',
        createdAt: '2026-10-21T14:00:00.000Z',
      })
      assert.equal(first.appended_shell, true)
      assert.equal(first.bootstrapPlanRevisionId, 'plan-shell-test-bootstrap')
      const second = await ensureAdmittedBootstrapPlanShell({
        store: owner.store,
        mission: exampleTechnicalMissionFixture,
        handle: first.handle,
        planRevisionId: 'plan-shell-test',
        createdAt: '2026-10-21T14:00:00.000Z',
      })
      assert.equal(second.appended_shell, false)
      const fence = owner.store.readMissionWriteFence(exampleTechnicalMissionFixture.mission_id)
      assert.equal(fence.active_plan_revision_id, 'plan-shell-test-bootstrap')
      await owner.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
