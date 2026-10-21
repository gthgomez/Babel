import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'
import pins from './T-L1-T-L2-PINNED-VERSIONS.json' with { type: 'json' }

const missionPath = join(dirname(fileURLToPath(import.meta.url)), 'T-L2-mission.json')

describe('T-L2 paper/code PDF campaign mission', () => {
  it('parses technical mission with pinned repo and selected arXiv PDF ref', () => {
    const mission = ResearchMissionV2Schema.parse(JSON.parse(readFileSync(missionPath, 'utf8')))
    assert.equal(mission.mission_id, 'mission-t-l2-paper-code-pdf')
    assert.equal(mission.profile_id, pins.profile.profile_id)
    assert.deepEqual(mission.source_policy.allowed_source_classes, ['repository_file', 'document'])
    assert.deepEqual(mission.source_policy.selected_document_refs, [pins.t_l2_paper.canonical_url])
    assert.equal(mission.pinned_target_repository?.commit_sha, pins.babel_repository.commit_sha)
    const domains = mission.source_policy.allowed_web_domains ?? []
    assert.ok(domains.includes('arxiv.org'))
    assert.ok(domains.includes('raw.githubusercontent.com'))
  })
})
