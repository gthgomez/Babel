import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCombinedResearchRegistries } from './reviewedBAdapterIntegration.js'
import { TECHNICAL_REPOSITORY_FILE_ADAPTER_ID } from '../profiles/technical/repositoryFileAdapter.js'

describe('reviewed B adapter integration (local combined branch)', () => {
  it('keeps technical registry when B modules are absent', async () => {
    const registries = await createCombinedResearchRegistries()
    assert.deepEqual(registries.bAdaptersRegistered, [])
    assert.ok(registries.sourceAdapters.getAdapter(TECHNICAL_REPOSITORY_FILE_ADAPTER_ID))
  })
})
