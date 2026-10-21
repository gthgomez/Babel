import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { PlanRevision } from '../contracts/plan.js'
import { PlanRevisionSchema } from '../contracts/plan.js'
import type { SourceRevision } from '../contracts/sources.js'
import { buildSynthesizedResearchReport } from './buildSynthesizedResearchReport.js'
import {
  deriveSourceCutoffFromRevisions,
  deriveVerifiedEvidenceLimitations,
} from './researchReportFinalization.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'

const SINGLE_QUESTION_ID = 'q-only'

function singleQuestionPlan(planRevisionId = 'plan-single-q'): PlanRevision {
  return PlanRevisionSchema.parse({
    plan_revision_id: planRevisionId,
    mission_id: exampleTechnicalMissionFixture.mission_id,
    created_at: '2026-10-21T09:00:00.000Z',
    revision_reason: 'fixture',
    questions: [
      {
        question_id: SINGLE_QUESTION_ID,
        text: 'Single plan question',
        importance: 'high',
        evidence_requirement: 'Official pages',
        status: 'open',
      },
    ],
  })
}

const baseRevision: SourceRevision = {
  revision_id: 'rev-base',
  source_id: 'src-1',
  content_hash: 'c'.repeat(64),
  retrieved_at: '2026-10-21T09:00:00.000Z',
  extraction_version: 'test/1',
  media_type: 'text/html',
  completeness: 'complete',
}

const basePassage: PassageRecord = {
  passage_id: 'p-1',
  source_revision_id: baseRevision.revision_id,
  locator: { kind: 'section', section_id: 'sec-1' },
  text_ref: { mode: 'inline', text: 'snippet', text_hash: 'd'.repeat(64) },
}

const supportedReview = {
  status: 'supported' as const,
  reviewer: 'r',
  reviewer_version: '0',
  rationale: 'ok',
  reviewed_at: '2026-10-21T09:04:00.000Z',
}

function supportedFinding(
  id: string,
  integrity: FindingRecord['source_integrity'],
  passageIds: string[] = ['p-1'],
): FindingRecord {
  return {
    finding_id: id,
    question_id: SINGLE_QUESTION_ID,
    assertion_text: `Assertion ${id}`,
    assertion_kind: 'source_observation',
    passage_ids: passageIds,
    source_integrity: integrity,
    semantic_support: supportedReview,
    created_at: '2026-10-21T09:04:00.000Z',
  }
}

function buildSingleQuestionReport(params: {
  plan?: PlanRevision
  findings: FindingRecord[]
  passages?: PassageRecord[]
  sourceRevisions?: SourceRevision[]
  additionalLimitations?: string[]
}) {
  const plan = params.plan ?? singleQuestionPlan()
  return buildSynthesizedResearchReport({
    mission: exampleTechnicalMissionFixture,
    plan,
    ctx: {
      mission_id: exampleTechnicalMissionFixture.mission_id,
      plan_revision_id: plan.plan_revision_id,
      writer_generation: 1,
    },
    findings: params.findings,
    passages: params.passages ?? [],
    sourceRevisions: params.sourceRevisions ?? [],
    ...(params.additionalLimitations
      ? { additionalLimitations: params.additionalLimitations }
      : {}),
    modelOutput: {
      kind: 'synthesize_report',
      answer_summary: 'Model claims complete coverage.',
      stopping_reason: 'coverage_sufficient',
    },
    generatedAt: '2026-10-21T09:04:40.000Z',
  })
}

describe('researchReportFinalization native review regressions (single-question partial predicate)', () => {
  it('source_cutoff compares instants with timezone offsets (not lexicographic strings)', () => {
    const lexicographicallyGreaterButEarlierInstant: SourceRevision = {
      ...baseRevision,
      revision_id: 'rev-plus-two',
      retrieved_at: '2026-10-21T10:00:00+02:00',
    }
    const laterInstant: SourceRevision = {
      ...baseRevision,
      revision_id: 'rev-zulu',
      retrieved_at: '2026-10-21T09:00:00Z',
    }
    assert.equal(
      deriveSourceCutoffFromRevisions([lexicographicallyGreaterButEarlierInstant, laterInstant]),
      '2026-10-21T09:00:00.000Z',
    )
    assert.equal(
      deriveSourceCutoffFromRevisions([
        { ...baseRevision, retrieved_at: 'not-an-instant' },
      ]),
      'unknown',
    )
  })

  it('complete control: verified evidence on a one-question mission yields complete', () => {
    const report = buildSingleQuestionReport({
      findings: [supportedFinding('f-good', 'valid')],
      passages: [basePassage],
      sourceRevisions: [baseRevision],
    })
    assert.equal(report.terminal_state, 'complete')
    assert.deepEqual(report.unanswered_questions, [])
    assert.equal(report.stopping_reason, 'single_pass_evidence_complete')
    assert.equal(report.source_cutoff, '2026-10-21T09:00:00.000Z')
    assert.ok(!report.limitations.some((l) => l.startsWith('finding_source_integrity_not_verified:')))
  })

  it('partial: supported finding with not_checked source_integrity (one question, zero unanswered)', () => {
    const report = buildSingleQuestionReport({
      findings: [supportedFinding('f1', 'not_checked')],
      passages: [basePassage],
      sourceRevisions: [baseRevision],
    })
    assert.deepEqual(report.unanswered_questions, [])
    assert.equal(report.terminal_state, 'partial')
    assert.ok(
      report.limitations.some((l) =>
        l.startsWith('finding_source_integrity_not_verified:f1:not_checked'),
      ),
    )
    assert.ok(report.stopping_reason.includes('evidence_verification_limits_recorded'))
  })

  it('partial: supported finding with invalid source_integrity', () => {
    const report = buildSingleQuestionReport({
      findings: [supportedFinding('f1', 'invalid')],
      passages: [basePassage],
      sourceRevisions: [baseRevision],
    })
    assert.deepEqual(report.unanswered_questions, [])
    assert.equal(report.terminal_state, 'partial')
    assert.ok(
      report.limitations.some((l) =>
        l.startsWith('finding_source_integrity_not_verified:f1:invalid'),
      ),
    )
  })

  it('partial: supported finding cites missing passage id', () => {
    const limitations = deriveVerifiedEvidenceLimitations({
      findings: [supportedFinding('f1', 'valid', ['missing-passage'])],
      passages: [basePassage],
      sourceRevisions: [baseRevision],
    })
    assert.ok(limitations.some((l) => l.startsWith('finding_cites_missing_passage:')))
    const report = buildSingleQuestionReport({
      findings: [supportedFinding('f1', 'valid', ['missing-passage'])],
      passages: [basePassage],
      sourceRevisions: [baseRevision],
    })
    assert.deepEqual(report.unanswered_questions, [])
    assert.equal(report.terminal_state, 'partial')
  })

  it('partial: passage references absent source revision', () => {
    const orphanPassage: PassageRecord = {
      ...basePassage,
      passage_id: 'p-orphan',
      source_revision_id: 'rev-missing',
    }
    const report = buildSingleQuestionReport({
      findings: [supportedFinding('f1', 'valid', ['p-orphan'])],
      passages: [orphanPassage],
      sourceRevisions: [baseRevision],
    })
    assert.deepEqual(report.unanswered_questions, [])
    assert.equal(report.terminal_state, 'partial')
    assert.ok(
      report.limitations.some((l) =>
        l.startsWith('passage_missing_source_revision:p-orphan:rev-missing'),
      ),
    )
  })

  for (const completeness of ['metadata_only', 'unavailable', 'extraction_failed'] as const) {
    it(`partial: source revision completeness ${completeness}`, () => {
      const revision: SourceRevision = { ...baseRevision, completeness }
      const report = buildSingleQuestionReport({
        findings: [supportedFinding('f1', 'valid')],
        passages: [basePassage],
        sourceRevisions: [revision],
      })
      assert.deepEqual(report.unanswered_questions, [])
      assert.equal(report.terminal_state, 'partial')
      assert.ok(
        report.limitations.some((l) =>
          l.startsWith(`source_revision_incomplete:${revision.revision_id}:${completeness}`),
        ),
      )
    })
  }

  it('partial: runtime failed-slot additionalLimitations with otherwise good evidence', () => {
    const report = buildSingleQuestionReport({
      findings: [supportedFinding('f1', 'valid')],
      passages: [basePassage],
      sourceRevisions: [baseRevision],
      additionalLimitations: ['composed_retrieval_slot_failed:slot-2:unsupported'],
    })
    assert.deepEqual(report.unanswered_questions, [])
    assert.equal(report.terminal_state, 'partial')
    assert.ok(report.stopping_reason.includes('runtime_slot_limits_recorded'))
    assert.ok(
      report.limitations.some((l) =>
        l.startsWith('composed_retrieval_slot_failed:slot-2:unsupported'),
      ),
    )
  })
})
