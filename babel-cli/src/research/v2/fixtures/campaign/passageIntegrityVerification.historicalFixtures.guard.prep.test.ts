/**
 * PREP guard only — not passage-integrity acceptance. Ensures frozen G-L2/G-L3 replay
 * bytes are not retroactively treated as verified when A lands integrity_verification.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { FindingRecordSchema } from '../../contracts/findings.js'
import { PassageRecordSchema } from '../../contracts/passages.js'

const campaignDir = dirname(fileURLToPath(import.meta.url))

function assertHistoricalSlice(path: string, sliceKey: string): void {
  const root = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const slice = root[sliceKey] as {
    passages?: unknown[]
    findings?: Record<string, unknown>
  }
  assert.ok(slice, `missing slice ${sliceKey}`)
  for (const raw of slice.passages ?? []) {
    const passage = PassageRecordSchema.parse(raw)
    assert.equal(
      (passage as { integrity_verification?: unknown }).integrity_verification,
      undefined,
      'historical passages must not carry retroactive integrity_verification',
    )
  }
  for (const raw of Object.values(slice.findings ?? {})) {
    const finding = FindingRecordSchema.parse(raw)
    assert.equal(
      finding.source_integrity,
      'not_checked',
      'historical findings remain not_checked in original-derived replay',
    )
  }
}

describe('passage integrity verification historical fixture guard (PREP)', () => {
  it('G-L2 original-derived frozen slice has no verification and not_checked integrity', () => {
    assertHistoricalSlice(
      join(campaignDir, 'g-l2-original-derived-regression.fixture.json'),
      'cache_comparison_defect',
    )
  })

  it('G-L3 original-derived frozen slice has no verification and not_checked integrity', () => {
    assertHistoricalSlice(
      join(campaignDir, 'g-l3-original-derived-regression.fixture.json'),
      'cross_page_attribution_defect',
    )
  })
})
