import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { generalAdapterCatalog } from '../profiles/general/generalAdapterCatalog.js'
import { GENERAL_PROFILE_ID, GENERAL_PROFILE_VERSION } from '../profiles/general/generalProfileDefinition.js'
import { createCombinedResearchRegistries } from './reviewedBAdapterIntegration.js'
import { TECHNICAL_REPOSITORY_FILE_ADAPTER_ID } from '../profiles/technical/repositoryFileAdapter.js'

describe('reviewed B adapter integration (local combined branch)', () => {
  it('registers generalAdapterCatalog document and web factories', async () => {
    const registries = await createCombinedResearchRegistries()
    assert.deepEqual(registries.bAdaptersRegistered, [
      `documents/${generalAdapterCatalog.document.adapterId}`,
      `web/${generalAdapterCatalog.web.adapterId}`,
    ])
    assert.ok(registries.sourceAdapters.getAdapter(TECHNICAL_REPOSITORY_FILE_ADAPTER_ID))
    assert.ok(registries.sourceAdapters.getAdapter(generalAdapterCatalog.document.adapterId))
    assert.ok(registries.sourceAdapters.getAdapter(generalAdapterCatalog.web.adapterId))
    assert.ok(registries.profiles.get(GENERAL_PROFILE_ID, GENERAL_PROFILE_VERSION))
  })
})
