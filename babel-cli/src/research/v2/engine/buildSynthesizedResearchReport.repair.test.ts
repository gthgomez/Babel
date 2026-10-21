import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import { examplePlanRevisionFixture, exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import {
  buildCitationQualifiedAnswerSummary,
  buildSynthesizedResearchReport,
} from './buildSynthesizedResearchReport.js'

const finding = (id: string, status: FindingRecord['semantic_support']): FindingRecord => ({
  finding_id: id,
  question_id: 'q-1',
  assertion_text: `Assertion ${id}`,
  assertion_kind: 'source_observation',
  passage_ids: ['p-1'],
  source_integrity: 'not_checked',
  semantic_support: status,
  created_at: '2026-10-20T00:00:00.000Z',
})

describe('buildSynthesizedResearchReport repairs', () => {
  it('qualifies model answer_summary when findings are not all supported', () => {
    const summary = buildCitationQualifiedAnswerSummary(
      [
        finding('f-1', {
          status: 'contradicted',
          reviewer: 'r',
          reviewer_version: '0',
          rationale: 'x',
          reviewed_at: '2026-10-20T00:00:00.000Z',
        }),
      ],
      'This sounds definitive but cites every ID.',
    )
    assert.match(summary, /contradicted:f-1/)
    assert.match(summary, /qualified/)
  })

  it('links report finding_ids to supported findings only', () => {
    const report = buildSynthesizedResearchReport({
      mission: exampleTechnicalMissionFixture,
      plan: examplePlanRevisionFixture,
      ctx: {
        mission_id: exampleTechnicalMissionFixture.mission_id,
        plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
        writer_generation: 1,
      },
      findings: [
        finding('supported-1', {
          status: 'supported',
          reviewer: 'r',
          reviewer_version: '0',
          rationale: 'ok',
          reviewed_at: '2026-10-20T00:00:00.000Z',
        }),
        finding('bad-1', {
          status: 'insufficient',
          reviewer: 'r',
          reviewer_version: '0',
          rationale: 'weak',
          reviewed_at: '2026-10-20T00:00:00.000Z',
        }),
      ],
      modelOutput: {
        kind: 'synthesize_report',
        answer_summary: 'Everything is settled.',
        stopping_reason: 'test',
      },
      generatedAt: '2026-10-20T02:00:00.000Z',
    })
    assert.deepEqual(report.finding_ids, ['supported-1'])
    assert.ok(report.limitations.includes('report_excludes_unsupported_findings'))
  })
})
