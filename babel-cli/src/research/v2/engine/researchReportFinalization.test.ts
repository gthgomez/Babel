import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import { PlanRevisionSchema } from '../contracts/plan.js'
import type { SourceRevision } from '../contracts/sources.js'
import {
  buildSynthesizedResearchReport,
} from './buildSynthesizedResearchReport.js'
import {
  deriveSourceCutoffFromRevisions,
  deriveUnansweredPlanQuestionIds,
} from './researchReportFinalization.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'

const plan = PlanRevisionSchema.parse({
  plan_revision_id: 'plan-g-l1-like',
  mission_id: exampleTechnicalMissionFixture.mission_id,
  created_at: '2026-10-21T09:00:00.000Z',
  revision_reason: 'fixture',
  questions: Array.from({ length: 5 }, (_, index) => ({
    question_id: `q-${index + 1}`,
    text: `Question ${index + 1}`,
    importance: 'high',
    evidence_requirement: 'Official python.org pages',
    status: 'open',
  })),
})

const finding = (
  id: string,
  questionId: string,
  status: FindingRecord['semantic_support'],
): FindingRecord => ({
  finding_id: id,
  question_id: questionId,
  assertion_text: `Assertion ${id}`,
  assertion_kind: 'source_observation',
  passage_ids: ['p-1'],
  source_integrity: 'not_checked',
  semantic_support: status,
  created_at: '2026-10-21T09:04:00.000Z',
})

const truncatedRevision: SourceRevision = {
  revision_id: 'rev-html-trunc',
  source_id: 'src-python-downloads',
  content_hash: 'a'.repeat(64),
  retrieved_at: '2026-10-21T09:04:02.034Z',
  extraction_version: 'general-static-html/0.1.0',
  media_type: 'text/html',
  completeness: 'truncated',
  byte_length_received: 200_000,
  truncation_reason: 'host_decoded_byte_limit',
}

const passage = (id: string, truncated: boolean): PassageRecord => ({
  passage_id: id,
  source_revision_id: truncatedRevision.revision_id,
  locator: { kind: 'section', section_id: `sec-${id}` },
  text_ref: { mode: 'inline', text: 'snippet', text_hash: 'b'.repeat(64) },
  extraction_notes: truncated
    ? ['static_html_extractor', 'inline_text_truncated:1000_codepoints_1000_utf16_to_500_utf16']
    : ['static_html_extractor'],
})

describe('researchReportFinalization', () => {
  it('derives unanswered questions from supported findings per question_id (not plan.status)', () => {
    const findings = [
      finding('f1', 'q-1', {
        status: 'supported',
        reviewer: 'r',
        reviewer_version: '0',
        rationale: 'ok',
        reviewed_at: '2026-10-21T09:04:00.000Z',
      }),
      finding('f2', 'q-1', {
        status: 'supported',
        reviewer: 'r',
        reviewer_version: '0',
        rationale: 'ok',
        reviewed_at: '2026-10-21T09:04:00.000Z',
      }),
    ]
    assert.deepEqual(deriveUnansweredPlanQuestionIds(plan, findings), ['q-2', 'q-3', 'q-4', 'q-5'])
  })

  it('uses latest retrieved_at instant normalized to UTC for source_cutoff', () => {
    assert.equal(
      deriveSourceCutoffFromRevisions([truncatedRevision]),
      '2026-10-21T09:04:02.034Z',
    )
  })

  it('G-L1-like partial report: truncation + 4/5 sections, model prose not used for cutoff/stopping', () => {
    const supported = finding('supported-1', 'q-1', {
      status: 'supported',
      reviewer: 'r',
      reviewer_version: '0',
      rationale: 'version line visible',
      reviewed_at: '2026-10-21T09:04:00.000Z',
    })
    const passages = [
      passage('html:0', false),
      passage('html:1', false),
      passage('html:2', false),
      passage('html:3', true),
      passage('html:4', false),
    ]
    const report = buildSynthesizedResearchReport({
      mission: exampleTechnicalMissionFixture,
      plan,
      ctx: {
        mission_id: exampleTechnicalMissionFixture.mission_id,
        plan_revision_id: plan.plan_revision_id,
        writer_generation: 1,
      },
      findings: [supported],
      passages,
      sourceRevisions: [truncatedRevision],
      modelOutput: {
        kind: 'synthesize_report',
        answer_summary: 'Model claims every question is answered.',
        stopping_reason: 'coverage_sufficient',
      },
      generatedAt: '2026-10-21T09:04:40.000Z',
    })
    assert.equal(report.terminal_state, 'partial')
    assert.equal(report.source_cutoff, '2026-10-21T09:04:02.034Z')
    assert.ok(report.stopping_reason.startsWith('single_pass_host_finalization'))
    assert.ok(!report.stopping_reason.includes('coverage_sufficient'))
    assert.deepEqual(report.unanswered_questions, ['q-2', 'q-3', 'q-4', 'q-5'])
    assert.ok(
      report.limitations.some((l) => l.startsWith('source_revision_truncated:host_decoded_byte_limit')),
    )
    assert.ok(report.limitations.some((l) => l.startsWith('passage_inline_text_truncated:')))
    assert.ok(
      report.limitations.some((l) =>
        l.startsWith('unverified_model_stopping_prose_excluded:'),
      ),
    )
  })
})
