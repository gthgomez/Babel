import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GENERAL_DOCUMENT_ADAPTER_ID } from '../adapters/documents/generalDocumentAdapter.js'
import { GENERAL_WEB_ADAPTER_ID } from '../adapters/web/generalWebAdapter.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { TECHNICAL_REPOSITORY_FILE_ADAPTER_ID } from '../profiles/technical/repositoryFileAdapter.js'
import { createCombinedResearchRegistries } from './reviewedBAdapterIntegration.js'
import {
  resolveDiscoveryAdapterForMission,
  resolveReadAdapterForSource,
} from './missionAdapterResolution.js'
import {
  GeneralMissionBriefSchema,
  normalizeGeneralMissionBrief,
} from '../contracts/normalization.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const devCorpusRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../profiles/general/fixtures/dev-corpus',
)

describe('mission adapter resolution', () => {
  it('general profile discovers via web adapter, not document', async () => {
    const registries = await createCombinedResearchRegistries()
    const brief = GeneralMissionBriefSchema.parse(
      JSON.parse(readFileSync(join(devCorpusRoot, 'G-DEV-01/mission.json'), 'utf8')),
    )
    const mission = normalizeGeneralMissionBrief(brief, {
      mission_id: 'mission-g-dev-01',
      created_at: '2026-10-20T12:00:00.000Z',
      profile_version: '0.1.0-m0',
    })
    const discovery = resolveDiscoveryAdapterForMission(mission, registries)
    assert.ok(discovery)
    assert.equal(discovery.adapterId, GENERAL_WEB_ADAPTER_ID)
    assert.notEqual(discovery.adapterId, GENERAL_DOCUMENT_ADAPTER_ID)
  })

  it('technical profile discovers via repository file adapter', async () => {
    const registries = await createCombinedResearchRegistries()
    const discovery = resolveDiscoveryAdapterForMission(exampleTechnicalMissionFixture, registries)
    assert.ok(discovery)
    assert.equal(discovery.adapterId, TECHNICAL_REPOSITORY_FILE_ADAPTER_ID)
  })

  it('read adapter follows source kind', async () => {
    const registries = await createCombinedResearchRegistries()
    const webRead = resolveReadAdapterForSource(
      {
        source_id: 's1',
        kind: 'web',
        canonical_key: 'https://example.invalid',
        observed_urls: ['https://example.invalid'],
      },
      registries,
    )
    assert.equal(webRead?.adapterId, GENERAL_WEB_ADAPTER_ID)
    const docRead = resolveReadAdapterForSource(
      {
        source_id: 's2',
        kind: 'document',
        canonical_key: 'fixture:doc',
        observed_urls: [],
      },
      registries,
      { mediaType: 'application/pdf' },
    )
    assert.equal(docRead?.adapterId, GENERAL_DOCUMENT_ADAPTER_ID)
  })
})
