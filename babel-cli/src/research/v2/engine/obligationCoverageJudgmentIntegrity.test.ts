import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import type { QuestionRecord } from '../contracts/plan.js'
import type { PassageRecord } from '../contracts/passages.js'
import { collectObligationCoverageJudgmentIntegrityIssues } from './obligationCoverageJudgmentIntegrity.js'

const question: QuestionRecord = {
  question_id: 'q-1',
  text: 'test',
  importance: 'high',
  evidence_requirement: 'x',
  status: 'open',
  coverage_obligations: [
    {
      obligation_id: 'ob-a',
      source_slot: 'web-ref-0',
      aspect: 'technical_effect',
      technical_effect: 'max_age_or_ttl_semantics',
    },
  ],
}

const passage: PassageRecord = {
  passage_id: 'p-valid',
  source_revision_id: 'rev-1',
  locator: { kind: 'section', section_id: 'a' },
  text_ref: {
    mode: 'inline',
    text: 'max-age=3600',
    text_hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  },
}

const finding: FindingRecord = {
  finding_id: 'f-1',
  question_id: 'q-1',
  assertion_text: 'x',
  assertion_kind: 'source_observation',
  passage_ids: ['p-valid'],
  source_integrity: 'not_checked',
  created_at: '2026-10-21T12:00:00.000Z',
  plan_obligation_coverage: [
    {
      obligation_id: 'ob-a',
      status: 'met',
      supporting_passage_ids: ['p-valid', 'DOES-NOT-EXIST'],
    },
  ],
}

describe('collectObligationCoverageJudgmentIntegrityIssues', () => {
  it('flags absent passage ids before host assessment filters them', () => {
    const issues = collectObligationCoverageJudgmentIntegrityIssues(
      question,
      finding,
      new Map([['p-valid', passage]]),
    )
    assert.deepEqual(issues, ['absent_passage_id:DOES-NOT-EXIST'])
  })
})
