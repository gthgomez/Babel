import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import { buildSynthesizeReportModelInput } from './buildSynthesizeReportModelInput.js'

const base: FindingRecord = {
  finding_id: 'f-1',
  question_id: 'q-1',
  assertion_text: 'Claim',
  assertion_kind: 'source_observation',
  passage_ids: ['p-1'],
  source_integrity: 'not_checked',
  created_at: '2026-10-20T00:00:00.000Z',
}

describe('buildSynthesizeReportModelInput', () => {
  it('includes semantic_support and question_coverage separately for synthesis', () => {
    const input = buildSynthesizeReportModelInput([
      {
        ...base,
        semantic_support: {
          status: 'supported',
          reviewer: 'r',
          reviewer_version: '0',
          rationale: 'passages ok',
          reviewed_at: '2026-10-20T01:00:00.000Z',
        },
        question_coverage: {
          status: 'tangential',
          reviewer: 'r',
          reviewer_version: '0',
          rationale: 'does not answer question',
          reviewed_at: '2026-10-20T01:00:00.000Z',
        },
      },
    ])
    assert.equal(input.findings[0]?.semantic_support, 'supported')
    assert.equal(input.findings[0]?.claimed_source_attribution, 'not_assessed')
    assert.equal(input.findings[0]?.question_coverage, 'tangential')
  })

  it('defaults missing judgments to not_checked and not_assessed', () => {
    const input = buildSynthesizeReportModelInput([base])
    assert.equal(input.findings[0]?.semantic_support, 'not_checked')
    assert.equal(input.findings[0]?.question_coverage, 'not_assessed')
  })
})
