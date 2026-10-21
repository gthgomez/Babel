import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import type { SourceRecord } from '../contracts/sources.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import {
  sourceAdmittedForMission,
  validateMissionFetchAdmission,
  validateRedirectChainForMission,
} from './missionSourceAdmission.js'

describe('missionSourceAdmission', () => {
  it('rejects web fetch when redirect hop leaves allowed domains', () => {
    const source: SourceRecord = {
      source_id: 'web-1',
      kind: 'web',
      canonical_key: 'web:allowed.example/doc',
      observed_urls: ['https://allowed.example/doc'],
    }
    const mission: ResearchMissionV2 = {
      ...exampleTechnicalMissionFixture,
      source_policy: {
        ...exampleTechnicalMissionFixture.source_policy,
        allowed_source_classes: ['web', 'repository_file'],
        allowed_web_domains: ['allowed.example'],
      },
    }
    assert.ok(sourceAdmittedForMission(source, mission))
    const violation = validateRedirectChainForMission(
      ['https://allowed.example/doc', 'https://evil.example/final'],
      source,
      mission,
    )
    assert.ok(violation)
    const denied = validateMissionFetchAdmission(source, {
      ...mission,
      source_policy: {
        ...mission.source_policy,
        allowed_source_classes: ['repository_file'],
      },
    })
    assert.ok(denied)
  })
})
