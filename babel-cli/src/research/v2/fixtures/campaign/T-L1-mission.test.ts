import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'
import pins from './T-L1-T-L2-PINNED-VERSIONS.json' with { type: 'json' }

const missionPath = join(dirname(fileURLToPath(import.meta.url)), 'T-L1-mission.json')

describe('T-L1 architecture-comparison campaign mission', () => {
  it('parses technical profile mission with two pinned repositories and per-pin discover queries', () => {
    const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
    assert.equal(mission.mission_id, 'mission-t-l1-architecture-comparison')
    assert.equal(mission.profile_id, pins.profile.profile_id)
    assert.equal(mission.profile_version, pins.profile.profile_version)
    assert.deepEqual(mission.source_policy.allowed_source_classes, ['repository_file'])
    assert.equal(mission.pinned_target_repository?.commit_sha, pins.babel_repository.commit_sha)
    assert.equal(mission.pinned_target_repository?.discover_query, 'research v2 persistence')
    assert.equal(mission.source_policy.selected_repository_refs?.length, 1)
    assert.equal(
      mission.source_policy.selected_repository_refs?.[0]?.commit_sha,
      pins.reference_repository.commit_sha,
    )
    assert.equal(
      mission.source_policy.selected_repository_refs?.[0]?.discover_query,
      'libs checkpoint',
    )
    assert.equal(mission.model_route.provider, 'openrouter')
    assert.equal(mission.model_route.fixture_route, undefined)
  })
})
