import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { PlanRevisionSchema } from '../contracts/plan.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import type { SourceAccessPort } from '../ports/sourceAccessPort.js'
import type { SourceAdapter } from '../ports/sourceAdapter.js'
import { runAdmittedRetrievalIteration } from './researchRetrievalLoop.js'
import { normalizedWebTargetKey } from '../access/missionWebRetrievalSelection.js'

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')
const FIXED_NOW = '2026-10-21T10:35:00.000Z'

function loadG2Mission() {
  return ResearchMissionV2Schema.parse(
    JSON.parse(readFileSync(join(campaignDir, 'G-L2-mission.json'), 'utf8')),
  )
}

describe('general multi-web production routing (G-L2 fixture)', () => {
  it('direct-acquires both selected_web_refs when discover returns no hits', async () => {
    const mission = loadG2Mission()
    const refs = mission.source_policy.selected_web_refs ?? []
    assert.equal(refs.length, 2)
    const plan = PlanRevisionSchema.parse(
      JSON.parse(readFileSync(join(campaignDir, 'G-L2-two-question-plan.fixture.json'), 'utf8')),
    )
    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(mission)
    await store.appendPlanRevision(
      {
        mission_id: handle.mission_id,
        plan_revision_id: plan.plan_revision_id,
        writer_generation: handle.writer_generation,
      },
      plan,
    )
    const session = {
      mission,
      handle,
      activePlanRevisionId: plan.plan_revision_id,
    }
    const fetchedUrls: string[] = []
    const access: SourceAccessPort = {
      async search() {
        return { operationId: 'search', status: 'ok', hits: [] }
      },
      async fetchContent() {
        throw new Error('general routing test uses adapter.read only')
      },
    }
    const adapter: SourceAdapter = {
      adapterId: 'g-l2-routing-fixture',
      supportedKinds: ['web'],
      async discover(request) {
        return { operationId: request.operationId, status: 'ok', candidates: [] }
      },
      async read(request) {
        const url = request.source.observed_urls[0] ?? ''
        fetchedUrls.push(normalizedWebTargetKey(url))
        const revisionId = `rev-${request.operationId}`
        return {
          operationId: request.operationId,
          status: 'ok',
          revision: {
            revision_id: revisionId,
            source_id: request.source.source_id,
            content_hash: 'a'.repeat(64),
            retrieved_at: FIXED_NOW,
            extraction_version: 'fixture',
            media_type: 'text/html',
            completeness: 'complete',
          },
          passages: [
            {
              passage_id: `${request.operationId}:p0`,
              source_revision_id: revisionId,
              locator: { kind: 'line_range', start_line: 1, end_line: 1 },
              text_ref: { mode: 'inline', text: `body for ${url}`, text_hash: 'b'.repeat(64) },
            },
          ],
          extraction_version: 'fixture',
        }
      },
    }
    const result = await runAdmittedRetrievalIteration({
      session,
      store,
      access,
      adapter,
      activePlan: plan,
      discoverQuery: 'Cache-Control max-age MDN Cloudflare',
      searchOperationId: 'g-l2-search',
      searchAttemptId: 'g-l2-search-att',
      fetchOperationId: 'g-l2-fetch',
      fetchAttemptId: 'g-l2-fetch-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    assert.equal(result.sources.length, 2)
    assert.equal(fetchedUrls.length, 2)
    for (const ref of refs) {
      assert.ok(fetchedUrls.includes(normalizedWebTargetKey(ref)))
    }
    for (const source of result.sources) {
      assert.ok(refs.some((ref) => normalizedWebTargetKey(ref) === source.observed_urls[0]))
    }
  })
})
