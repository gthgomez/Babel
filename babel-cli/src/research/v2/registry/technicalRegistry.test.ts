import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { FakeSourceAccessPort } from '../fixtures/fakePorts.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
  technicalRepositoryCorpusSource,
} from '../fixtures/technicalRepositoryCorpus.js'
import { TECHNICAL_REPOSITORY_FILE_ADAPTER_ID } from '../profiles/technical/repositoryFileAdapter.js'
import { createTechnicalResearchRegistries } from './frozenRegistries.js'

describe('technical research registries (M1.2)', () => {
  it('resolves technical profile and repository-file adapter', () => {
    const { sourceAdapters, profiles } = createTechnicalResearchRegistries()
    const profile = profiles.get(
      exampleTechnicalMissionFixture.profile_id,
      exampleTechnicalMissionFixture.profile_version,
    )
    assert.ok(profile)
    assert.ok(profile!.preferredSourceClasses.includes('repository_file'))
    const adapter = sourceAdapters.getAdapter(TECHNICAL_REPOSITORY_FILE_ADAPTER_ID)
    assert.ok(adapter)
    assert.equal(sourceAdapters.listAdapters().length, 1)
  })

  it('wires adapter read end-to-end through registry lookup', async () => {
    const { sourceAdapters } = createTechnicalResearchRegistries()
    const adapter = sourceAdapters.getAdapter(TECHNICAL_REPOSITORY_FILE_ADAPTER_ID)
    assert.ok(adapter)
    const access = new FakeSourceAccessPort([
      {
        source: technicalRepositoryCorpusSource,
        body: technicalRepositoryCorpusBody,
        mediaType: 'text/plain',
        finalUrl: technicalRepositoryCorpusFinalUrl,
      },
    ])
    const read = await adapter!.read(
      {
        operationId: 'reg-read-1',
        source: technicalRepositoryCorpusSource,
        signal: new AbortController().signal,
      },
      access,
    )
    assert.equal(read.status, 'ok')
  })
})
