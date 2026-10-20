import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FindingRecordSchema } from './findings.js'
import { ResearchMissionV2Schema } from './mission.js'
import { PassageRecordSchema } from './passages.js'
import { ResearchStateSnapshotV2Schema } from './plan.js'
import { SourceRevisionSchema } from './sources.js'
import { RESEARCH_V2_CONTRACT_VERSION } from './version.js'
import {
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'

describe('research v2 contracts', () => {
  it('parses example technical mission fixture', () => {
    const parsed = ResearchMissionV2Schema.parse(exampleTechnicalMissionFixture)
    assert.equal(parsed.contract_version, RESEARCH_V2_CONTRACT_VERSION)
    assert.equal(parsed.as_of, '2026-10-20')
    assert.equal(parsed.jurisdiction, 'unknown')
  })

  it('rejects invented citation passage without valid hash', () => {
    assert.throws(() =>
      PassageRecordSchema.parse({
        passage_id: 'p1',
        source_revision_id: 'r1',
        locator: { kind: 'page', start: 1 },
        text_ref: { mode: 'inline', text: 'hello', text_hash: 'not-a-hash' },
      }),
    )
  })

  it('keeps source integrity separate from semantic support', () => {
    const finding = FindingRecordSchema.parse({
      finding_id: 'f1',
      question_id: 'q1',
      assertion_text: 'Observed export omits bytes when incomplete.',
      assertion_kind: 'source_observation',
      passage_ids: ['p1'],
      source_integrity: 'not_checked',
      created_at: '2026-10-20T12:00:00.000Z',
    })
    assert.equal(finding.semantic_support, undefined)
    assert.equal(finding.source_integrity, 'not_checked')
  })

  it('bundles snapshot shape for inspect/resume design', () => {
    const snapshot = ResearchStateSnapshotV2Schema.parse({
      mission: exampleTechnicalMissionFixture,
      plan: examplePlanRevisionFixture,
      sources: [],
      source_revisions: [],
      passages: [],
      findings: [],
    })
    assert.equal(snapshot.mission.mission_id, snapshot.plan.mission_id)
  })

  it('metadata-only completeness is explicit on revisions', () => {
    const rev = SourceRevisionSchema.parse({
      revision_id: 'rev-1',
      source_id: 'src-1',
      content_hash: 'a'.repeat(64),
      retrieved_at: '2026-10-20T12:00:00.000Z',
      extraction_version: 'search-snippet-1',
      media_type: 'text/plain',
      completeness: 'metadata_only',
    })
    assert.equal(rev.completeness, 'metadata_only')
  })
})
