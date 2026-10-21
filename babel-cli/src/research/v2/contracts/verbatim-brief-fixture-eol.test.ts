/**
 * Deterministic LF vs CRLF regression for locked B mission.json bytes (Windows CI).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  loadVerbatimBriefManifest,
  readVerbatimBriefBytes,
  VERBATIM_BRIEF_CORPUS_DIR,
  type VerbatimBriefCaseId,
} from '../fixtures/general-dev-brief-corpus/verbatimBriefBytes.js'

const CASE_IDS: VerbatimBriefCaseId[] = [
  'G-DEV-01',
  'G-DEV-02',
  'G-DEV-03',
  'G-DEV-04',
  'G-DEV-05',
  'G-DEV-06',
]

describe('verbatim B brief fixture byte locks (LF checkout)', () => {
  const manifest = loadVerbatimBriefManifest()

  it('G-DEV-01 documents LF vs CRLF mis-checkout hashes', () => {
    const path = join(VERBATIM_BRIEF_CORPUS_DIR, 'G-DEV-01/mission.json')
    const lf = readFileSync(path)
    const crlf = Buffer.from(lf.toString('utf8').replace(/\n/g, '\r\n'), 'utf8')
    assert.equal(lf.length, 461)
    assert.equal(crlf.length, 473)
    assert.equal(
      createHash('sha256').update(lf).digest('hex'),
      '3f2ffd46c07c67f7fbe9766c8124ca78e7e1bf02a55457ffa35720f836afe075',
    )
    assert.equal(
      createHash('sha256').update(crlf).digest('hex'),
      '2bfd039924d1c5cde963be507ca763f3350d502366d6e012b0004651ae6c04cc',
    )
  })

  for (const caseId of CASE_IDS) {
    it(`${caseId}: on-disk bytes match locked LF manifest`, () => {
      const bytes = readVerbatimBriefBytes(caseId)
      const spec = manifest.cases[caseId]
      assert.equal(bytes.length, spec.byte_length)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), spec.sha256)
      assert.notEqual(
        createHash('sha256').update(bytes).digest('hex'),
        spec.crlf_mis_checkout_sha256,
      )
    })
  }
})
