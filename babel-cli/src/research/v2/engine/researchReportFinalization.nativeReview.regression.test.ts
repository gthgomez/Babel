import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'
import { PlanRevisionSchema } from '../contracts/plan.js'
import type { SourceRevision } from '../contracts/sources.js'
import { buildSynthesizedResearchReport } from './buildSynthesizedResearchReport.js'
import {
  deriveSourceCutoffFromRevisions,
  deriveVerifiedEvidenceLimitations,
} from './researchReportFinalization.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'

const plan = PlanRevisionSchema.parse({
  plan_revision_id: 'plan-native-review',
  mission_id: exampleTechnicalMissionFixture.mission_id,
  created_at: '2026-10-21T09:00:00.000Z',
  revision_reason: 'fixture',
  questions: Array.from({ length: 5 }, (_, index) => ({
    question_id: `q-${index + 1}`,
    text: `Question ${index + 1}`,
    importance: 'high',
    evidence_requirement: 'Official pages',
    status: 'open',
  })),
})

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
  questionId: string,
  integrity: FindingRecord['source_integrity'],
  passageIds: string[] = ['p-1'],
): FindingRecord {
  return {
    finding_id: id,
    question_id: questionId,
    assertion_text: `Assertion ${id}`,
    assertion_kind: 'source_observation',
    passage_ids: passageIds,
    source_integrity: integrity,
    semantic_support: supportedReview,
    created_at: '2026-10-21T09:04:00.000Z',
  }
}

function buildReport(params: {
  findings: FindingRecord[]
  passages?: PassageRecord[]
  sourceRevisions?: SourceRevision[]
  additionalLimitations?: string[]
}) {
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

describe('researchReportFinalization native fef78559 review regressions', () => {
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

  it('requires partial when semantically supported findings lack verified source_integrity', () => {
    const report = buildReport({
      findings: [supportedFinding('f1', 'q-1', 'not_checked')],
      passages: [basePassage],
      sourceRevisions: [baseRevision],
    })
    assert.equal(report.terminal_state, 'partial')
    assert.ok(
      report.limitations.some((l) =>
        l.startsWith('finding_source_integrity_not_verified:f1:not_checked'),
      ),
    )
  })

  it('requires partial for invalid source_integrity on supported findings', () => {
    const report = buildReport({
      findings: [supportedFinding('f1', 'q-1', 'invalid')],
      passages: [basePassage],
      sourceRevisions: [baseRevision],
    })
    assert.equal(report.terminal_state, 'partial')
  })

  it('requires partial when supported finding cites a missing passage id', () => {
    const limitations = deriveVerifiedEvidenceLimitations({
      findings: [supportedFinding('f1', 'q-1', 'valid', ['missing-passage'])],
      passages: [basePassage],
      sourceRevisions: [baseRevision],
    })
    assert.ok(limitations.some((l) => l.startsWith('finding_cites_missing_passage:')))
    const report = buildReport({
      findings: [supportedFinding('f1', 'q-1', 'valid', ['missing-passage'])],
      passages: [basePassage],
      sourceRevisions: [baseRevision],
    })
    assert.equal(report.terminal_state, 'partial')
  })

  it('requires partial when passage references an absent source revision', () => {
    const orphanPassage: PassageRecord = {
      ...basePassage,
      passage_id: 'p-orphan',
      source_revision_id: 'rev-missing',
    }
    const report = buildReport({
      findings: [supportedFinding('f1', 'q-1', 'valid', ['p-orphan'])],
      passages: [orphanPassage],
      sourceRevisions: [baseRevision],
    })
    assert.equal(report.terminal_state, 'partial')
    assert.ok(
      report.limitations.some((l) =>
        l.startsWith('passage_missing_source_revision:p-orphan:rev-missing'),
      ),
    )
  })

  for (const completeness of ['metadata_only', 'unavailable', 'extraction_failed'] as const) {
    it(`requires partial for source revision completeness ${completeness}`, () => {
      const revision: SourceRevision = { ...baseRevision, completeness }
      const report = buildReport({
        findings: [supportedFinding('f1', 'q-1', 'valid')],
        passages: [basePassage],
        sourceRevisions: [revision],
      })
      assert.equal(report.terminal_state, 'partial')
      assert.ok(
        report.limitations.some((l) =>
          l.startsWith(`source_revision_incomplete:${revision.revision_id}:${completeness}`),
        ),
      )
    })
  }

  it('requires partial for q1 supported plus failed-slot additionalLimitations', () => {
    const report = buildReport({
      findings: [supportedFinding('f1', 'q-1', 'valid')],
      passages: [basePassage],
      sourceRevisions: [baseRevision],
      additionalLimitations: ['composed_retrieval_slot_failed:slot-2:unsupported'],
    })
    assert.equal(report.terminal_state, 'partial')
    assert.ok(report.stopping_reason.includes('runtime_slot_limits_recorded'))
    assert.deepEqual(report.unanswered_questions, ['q-2', 'q-3', 'q-4', 'q-5'])
  })
})
