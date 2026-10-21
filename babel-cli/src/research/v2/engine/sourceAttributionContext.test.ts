import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import {
  buildMissionSourceSlotAttribution,
  passageReferencesUnfetchedConfiguredSlot,
  slotHasAdmittedFetch,
} from './sourceAttributionContext.js'
import {
  gL3OriginalDerivedPassages,
  gL3OriginalDerivedRevisions,
  gL3OriginalDerivedSources,
} from './testSupport/gL3OriginalDerivedRegression.js'

const gL3Mission = ResearchMissionV2Schema.parse(
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign/G-L3-mission.json'),
      'utf8',
    ),
  ),
)

describe('sourceAttributionContext', () => {
  it('marks missing web-ref-1 as fetch_failed_or_missing for G-L3 derived slice', () => {
    const directory = buildMissionSourceSlotAttribution(
      gL3Mission,
      gL3OriginalDerivedSources,
      gL3OriginalDerivedRevisions,
    )
    assert.equal(directory[1]?.fetch_status, 'fetch_failed_or_missing')
    const provenanceIndex = new Map(
      gL3OriginalDerivedRevisions.map((revision) => {
        const source = gL3OriginalDerivedSources.find((s) => s.source_id === revision.source_id)!
        return [revision.revision_id, { source, revision }]
      }),
    )
    assert.equal(slotHasAdmittedFetch('web-ref-0', provenanceIndex), true)
    assert.equal(slotHasAdmittedFetch('web-ref-1', provenanceIndex), false)
  })

  it('detects link-only reference to unfetched devguide URL in downloads passage', () => {
    const directory = buildMissionSourceSlotAttribution(
      gL3Mission,
      gL3OriginalDerivedSources,
      gL3OriginalDerivedRevisions,
    )
    const passage = gL3OriginalDerivedPassages[0]!
    const text = passage.text_ref.mode === 'inline' ? passage.text_ref.text : ''
    assert.deepEqual(passageReferencesUnfetchedConfiguredSlot(text, directory), ['web-ref-1'])
  })
})
