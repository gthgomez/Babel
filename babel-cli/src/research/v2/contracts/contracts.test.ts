import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CostProvenanceSchema } from './common.js'
import { FindingRecordSchema } from './findings.js'
import { ResearchMissionV2Schema } from './mission.js'
import { PassageRecordSchema, PassageLocatorSchema, PassageTextRefSchema } from './passages.js'
import { ResearchStateSnapshotV2Schema } from './plan.js'
import { SourceRevisionSchema } from './sources.js'
import { RESEARCH_V2_CONTRACT_VERSION } from './version.js'
import { normalizeGeneralMissionBrief } from './normalization.js'
import {
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'

describe('research v2 contracts', () => {
  it('parses example technical mission fixture', () => {
    const parsed = ResearchMissionV2Schema.parse(exampleTechnicalMissionFixture)
    assert.equal(parsed.contract_version, RESEARCH_V2_CONTRACT_VERSION)
    assert.equal(parsed.model_route.fixture_route, true)
  })

  it('rejects invalid passage text reference shapes', () => {
    assert.throws(() =>
      PassageTextRefSchema.parse({
        mode: 'inline',
        text_hash: 'a'.repeat(64),
      }),
    )
    assert.throws(() =>
      PassageTextRefSchema.parse({
        mode: 'blob_ref',
        text_hash: 'a'.repeat(64),
      }),
    )
  })

  it('rejects page zero and inverted line ranges', () => {
    assert.throws(() =>
      PassageLocatorSchema.parse({ kind: 'page', start_page: 0 }),
    )
    assert.throws(() =>
      PassageLocatorSchema.parse({ kind: 'line_range', start_line: 3, end_line: 1 }),
    )
  })

  it('accepts valid PDF page locator', () => {
    const locator = PassageLocatorSchema.parse({ kind: 'page', start_page: 2, end_page: 2 })
    assert.equal(locator.kind, 'page')
  })

  it('cost unknown must not carry fake amount', () => {
    assert.throws(() =>
      CostProvenanceSchema.parse({ status: 'unknown', amount_usd: 0 }),
    )
    const reported = CostProvenanceSchema.parse({
      status: 'reported',
      amount_usd: 0.01,
      currency: 'USD',
    })
    assert.equal(reported.status, 'reported')
  })

  it('normalizes general mission brief without cast', () => {
    const mission = normalizeGeneralMissionBrief(
      {
        profile_id: 'general',
        primary_question: 'What is the fee?',
        as_of: '2026-06-15',
        constraints: { currency: 'USD' },
      },
      {
        mission_id: 'mission-g-dev-03',
        created_at: '2026-10-20T12:00:00.000Z',
        profile_version: '0.0.0-checkpoint',
      },
    )
    assert.equal(mission.model_route.fixture_route, true)
    assert.ok(mission.constraints.some((c) => c.includes('currency')))
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

  it('issued passage requires revision binding', () => {
    const passage = PassageRecordSchema.parse({
      passage_id: 'passage-issued-1',
      source_revision_id: 'rev-1',
      locator: { kind: 'page', start_page: 1 },
      text_ref: { mode: 'inline', text: 'hello', text_hash: 'a'.repeat(64) },
    })
    assert.equal(passage.source_revision_id, 'rev-1')
  })
})
