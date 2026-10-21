import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import { examplePlanRevisionFixture, exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import {
  buildCitationQualifiedAnswerSummary,
  buildSynthesizedResearchReport,
  buildVerifiedReportAssertions,
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
  it('does not treat free-form model synthesis as verified fact in answer_summary', () => {
    const supported = finding('supported-1', {
      status: 'supported',
      reviewer: 'r',
      reviewer_version: '0',
      rationale: 'ok',
      reviewed_at: '2026-10-20T00:00:00.000Z',
    })
    const report = buildSynthesizedResearchReport({
      mission: exampleTechnicalMissionFixture,
      plan: examplePlanRevisionFixture,
      ctx: {
        mission_id: exampleTechnicalMissionFixture.mission_id,
        plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
        writer_generation: 1,
      },
      findings: [supported],
      modelOutput: {
        kind: 'synthesize_report',
        answer_summary: 'This sounds definitive but is unverified prose.',
        stopping_reason: 'test',
      },
      generatedAt: '2026-10-20T02:00:00.000Z',
    })
    assert.match(report.answer_summary, /\[supported:supported-1\]/)
    assert.ok(!report.answer_summary.includes('unverified prose'))
    assert.ok(
      report.limitations.some((l) => l.startsWith('unverified_model_synthesis_excluded:')),
    )
    assert.ok(report.stopping_reason.startsWith('single_pass_host_finalization'))
    assert.equal(report.source_cutoff, 'unknown')
  })

  it('buildVerifiedReportAssertions only includes supported findings', () => {
    const assertions = buildVerifiedReportAssertions([
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
    ])
    assert.deepEqual(assertions.map((a) => a.finding_id), ['supported-1'])
    assert.match(buildCitationQualifiedAnswerSummary(assertions), /supported-1/)
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
