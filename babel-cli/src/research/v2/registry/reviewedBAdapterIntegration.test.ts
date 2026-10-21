import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GENERAL_DOCUMENT_ADAPTER_ID } from '../adapters/documents/generalDocumentAdapter.js'
import { GENERAL_PROFILE_ID, GENERAL_PROFILE_VERSION } from '../profiles/general/generalProfileDefinition.js'
import { createCombinedResearchRegistries } from './reviewedBAdapterIntegration.js'
import { TECHNICAL_REPOSITORY_FILE_ADAPTER_ID } from '../profiles/technical/repositoryFileAdapter.js'

describe('reviewed B adapter integration (local combined branch)', () => {
  it('registers reviewed B document adapter and general profile from 196098d9 exports', async () => {
    const registries = await createCombinedResearchRegistries()
    assert.deepEqual(registries.bAdaptersRegistered, [`documents/${GENERAL_DOCUMENT_ADAPTER_ID}`])
    assert.deepEqual(registries.bAdaptersRepairInProgress, [])
    assert.ok(registries.sourceAdapters.getAdapter(TECHNICAL_REPOSITORY_FILE_ADAPTER_ID))
    assert.ok(registries.sourceAdapters.getAdapter(GENERAL_DOCUMENT_ADAPTER_ID))
    assert.ok(registries.profiles.get(GENERAL_PROFILE_ID, GENERAL_PROFILE_VERSION))
  })
})
