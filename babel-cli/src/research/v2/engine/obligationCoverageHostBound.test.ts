import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assessObligationCoverageHostBound,
  obligationCitationStructuralCompleteness,
} from './obligationCoverageHostBound.js'
import type { FindingRecord } from '../contracts/findings.js'
import type { QuestionRecord } from '../contracts/plan.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'

const question: QuestionRecord = {
  question_id: 'q-1',
  text: 'test',
  importance: 'high',
  evidence_requirement: 'x',
  status: 'open',
  coverage_obligations: [
    {
      obligation_id: 'ob-audience',
      source_slot: 'web-ref-0',
      aspect: 'audience_intent',
    },
  ],
}

const source: SourceRecord = {
  source_id: 's-1',
  kind: 'web',
  canonical_key: 'https://example.test',
  observed_urls: ['https://example.test'],
  coverage_source_slot: 'web-ref-0',
}

const revision: SourceRevision = {
  revision_id: 'rev-1',
  source_id: 's-1',
  content_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  retrieved_at: '2026-10-21T12:00:00.000Z',
  extraction_version: 'v1',
  media_type: 'text/html',
  completeness: 'complete',
}

const passage: PassageRecord = {
  passage_id: 'p-1',
  source_revision_id: 'rev-1',
  locator: { kind: 'section', section_id: 'a' },
  text_ref: {
    mode: 'inline',
    text: 'This document is intended for a single user.',
    text_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
}

const finding: FindingRecord = {
  finding_id: 'f-1',
  question_id: 'q-1',
  assertion_text: 'audience claim',
  assertion_kind: 'source_observation',
  passage_ids: ['p-1'],
  source_integrity: 'not_checked',
  created_at: '2026-10-21T12:00:00.000Z',
  plan_obligation_coverage: [
    {
      obligation_id: 'ob-audience',
      status: 'met',
      supporting_passage_ids: ['p-1'],
    },
  ],
}

describe('obligationCoverageHostBound', () => {
  it('accepts model met judgment when slot and completeness validate', () => {
    const provenanceIndex = new Map([
      ['rev-1', { source, revision }],
    ])
    const result = assessObligationCoverageHostBound(question, finding, {
      passageById: new Map([['p-1', passage]]),
      provenanceIndex,
    })
    assert.equal(result.satisfiesRequiredFacets, true)
  })

  it('rejects met on truncated technical citation without topic regex', () => {
    const truncatedPassage: PassageRecord = {
      ...passage,
      extraction_notes: ['inline_text_truncated:host_decoded_byte_limit'],
    }
    const truncRevision: SourceRevision = {
      ...revision,
      completeness: 'truncated',
    }
    assert.equal(
      obligationCitationStructuralCompleteness(
        truncatedPassage,
        {
          obligation_id: 'ob-tech',
          source_slot: 'web-ref-0',
          aspect: 'technical_effect',
          technical_effect: 'max_age_or_ttl_semantics',
        },
        { source, revision: truncRevision },
      ),
      false,
    )
  })

  it('rejects met judgment when supporting passage is from wrong slot', () => {
    const wrongSource = { ...source, coverage_source_slot: 'web-ref-1' }
    const provenanceIndex = new Map([['rev-1', { source: wrongSource, revision }]])
    const result = assessObligationCoverageHostBound(question, finding, {
      passageById: new Map([['p-1', passage]]),
      provenanceIndex,
    })
    assert.equal(result.satisfiesRequiredFacets, false)
  })
})
