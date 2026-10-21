import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import {
  planTechnicalRetrievalSlots,
  resolveRepositorySlotDiscoverQuery,
} from './technicalRetrievalComposition.js'

const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')

describe('technicalRetrievalComposition discover query', () => {
  it('uses per-pin discover_query when declared', () => {
    const mission = ResearchMissionV2Schema.parse(
      JSON.parse(readFileSync(join(campaignDir, 'T-L1-mission.json'), 'utf8')),
    )
    const slots = planTechnicalRetrievalSlots(mission, '__global_fallback_unused__')
    const repoSlots = slots.filter((s) => s.kind === 'repository_pin')
    assert.equal(repoSlots.length, 2)
    assert.equal(repoSlots[0]?.discoverQuery, 'persistence durableresearchstore.ts')
    assert.equal(repoSlots[1]?.discoverQuery, 'pregel checkpoint')
    assert.equal(repoSlots[0]?.repositoryPin?.commit_sha, mission.pinned_target_repository?.commit_sha)
    assert.equal(
      repoSlots[1]?.repositoryPin?.commit_sha,
      mission.source_policy.selected_repository_refs?.[0]?.commit_sha,
    )
  })

  it('falls back to global discover query when pin omits discover_query', () => {
    const pin = {
      provider: 'github' as const,
      repo_id: 'github:org/repo',
      full_name: 'org/repo',
      commit_sha: 'a'.repeat(40),
    }
    assert.equal(resolveRepositorySlotDiscoverQuery(pin, 'global terms'), 'global terms')
  })
})
