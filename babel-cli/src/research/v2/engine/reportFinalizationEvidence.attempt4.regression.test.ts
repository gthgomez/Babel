import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { FindingRecord } from '../contracts/findings.js'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { PlanRevisionSchema } from '../contracts/plan.js'
import { buildSynthesizedResearchReport } from './buildSynthesizedResearchReport.js'
import { deriveUnansweredPlanQuestionIds } from './researchReportFinalization.js'
import { findingsFromExtractModelOutput } from './findingsFromModelOutput.js'
import { loadAttempt4EvidenceSubset } from './testSupport/attempt4EvidenceSubset.js'
import { applyAttempt4DerivedQuestionCoverageOverlay } from './testSupport/attempt4QuestionCoverageDerived.js'

const gL1MissionPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/campaign/G-L1-mission.json',
)

const attempt4Plan = PlanRevisionSchema.parse({
  plan_revision_id: 'plan-3f83793b-d454-422e-95df-ab774fb86c6c',
  mission_id: 'mission-g-l1-general-live-attempt4',
  created_at: '2026-10-21T09:04:01.204Z',
  questions: [
    {
      question_id: 'q-plan-3f83793b-d454-422e-95df-ab774fb86c6c-1',
      text: 'What is the latest stable Python release version as of 2026-10-21 according to official python.org sources?',
      importance: 'critical',
      evidence_requirement: 'Host-admitted plan question; refine locators during retrieval',
      status: 'open',
    },
    {
      question_id: 'q-plan-3f83793b-d454-422e-95df-ab774fb86c6c-2',
      text: 'What is the official release date of that latest stable Python version?',
      importance: 'critical',
      evidence_requirement: 'Host-admitted plan question; refine locators during retrieval',
      status: 'open',
    },
    {
      question_id: 'q-plan-3f83793b-d454-422e-95df-ab774fb86c6c-3',
      text: 'Which official python.org page or pages provide the authoritative statement of the latest stable version and its release date?',
      importance: 'high',
      evidence_requirement: 'Host-admitted plan question; refine locators during retrieval',
      status: 'open',
    },
    {
      question_id: 'q-plan-3f83793b-d454-422e-95df-ab774fb86c6c-4',
      text: 'Does python.org list any newer prerelease (alpha, beta, or release candidate) as of 2026-10-21, and how is it distinguished from the latest stable release?',
      importance: 'high',
      evidence_requirement: 'Host-admitted plan question; refine locators during retrieval',
      status: 'open',
    },
    {
      question_id: 'q-plan-3f83793b-d454-422e-95df-ab774fb86c6c-5',
      text: 'Do the official python.org pages agree on the latest stable version and release date, or is there any conflict or unreadable page that creates uncertainty?',
      importance: 'medium',
      evidence_requirement: 'Host-admitted plan question; refine locators during retrieval',
      status: 'open',
    },
  ],
  revision_reason: 'e2e_model_planning',
})

const ALL_FIVE_QUESTION_IDS = attempt4Plan.questions.map((q) => q.question_id)
const UNANSWERED_AFTER_Q1_SUPPORTED = ALL_FIVE_QUESTION_IDS.slice(1)

describe('G-L1 attempt4 evidence subset (historical) + fef78559 finalizer', () => {
  it('preserves ORIGINAL subset artifact and extract binding on plan.questions[0]', () => {
    const { provenance, revision, passages, findings } = loadAttempt4EvidenceSubset()
    assert.equal(
      revision.content_hash,
      'a0afa499c0bcfcfad46229c19edd86e0907e0eade9b0f7dbbe939a861254d1dc',
    )
    assert.equal(passages.length, 6)
    assert.equal(findings.length, 6)
    const firstQuestionId = attempt4Plan.questions[0]?.question_id
    assert.ok(firstQuestionId)
    assert.ok(findings.every((f: FindingRecord) => f.question_id === firstQuestionId))
    assert.ok(
      String(provenance.extraction_command).includes(
        'extract-general-g-l1-attempt4-evidence-subset.mjs',
      ),
    )
    const rebound = findingsFromExtractModelOutput({
      operationId: 'op-attempt4-shape',
      plan: attempt4Plan,
      passages,
      createdAt: '2026-10-21T09:04:28.000Z',
      modelOutput: {
        kind: 'extract_findings',
        findings: findings.map((f) => ({
          assertion_text: f.assertion_text,
          assertion_kind: f.assertion_kind,
          passage_ids: f.passage_ids,
          question_id: f.question_id,
        })),
      },
    })
    assert.ok(
      rebound.every((f) => f.question_id === firstQuestionId),
      'rebound preserves per-finding question_id from extract output',
    )
  })

  it('records historical terminal report (pre-fef78559 builder) with all five unanswered and model prose cutoff', () => {
    const { terminal_report } = loadAttempt4EvidenceSubset()
    assert.equal(terminal_report.terminal_state, 'partial')
    assert.deepEqual(terminal_report.unanswered_questions, ALL_FIVE_QUESTION_IDS)
    assert.match(String(terminal_report.source_cutoff), /mutually consistent/)
  })

  it('rebuilds attempt4 with canonical finalizer: partial, per-question unanswered, truncation, corrected coverage_notes', () => {
    const { revision, passages, findings: historicalFindings, terminal_report } =
      loadAttempt4EvidenceSubset()
    const findings = applyAttempt4DerivedQuestionCoverageOverlay(historicalFindings)
    const mission = ResearchMissionV2Schema.parse({
      ...JSON.parse(readFileSync(gL1MissionPath, 'utf8')),
      mission_id: 'mission-g-l1-general-live-attempt4',
    })
    const report = buildSynthesizedResearchReport({
      mission,
      plan: attempt4Plan,
      ctx: {
        mission_id: mission.mission_id,
        plan_revision_id: attempt4Plan.plan_revision_id,
        writer_generation: 3,
      },
      findings,
      passages,
      sourceRevisions: [revision],
      modelOutput: {
        kind: 'synthesize_report',
        answer_summary: 'Model synthesis must not drive coverage.',
        stopping_reason: String(terminal_report.stopping_reason),
      },
      generatedAt: String(terminal_report.generated_at),
    })
    assert.equal(report.terminal_state, 'partial')
    assert.deepEqual(
      deriveUnansweredPlanQuestionIds(attempt4Plan, findings),
      UNANSWERED_AFTER_Q1_SUPPORTED,
    )
    assert.deepEqual(report.unanswered_questions, UNANSWERED_AFTER_Q1_SUPPORTED)
    assert.match(report.coverage_notes, /question_coverage/)
    assert.match(report.coverage_notes, /question_coverage answers/)
    assert.equal(report.source_cutoff, '2026-10-21T09:04:02.034Z')
    assert.ok(report.stopping_reason.startsWith('single_pass_host_finalization'))
    assert.ok(
      report.limitations.some((l) =>
        l.startsWith('source_revision_truncated:host_decoded_byte_limit'),
      ),
    )
    assert.ok(
      report.limitations.some((l) =>
        l.startsWith('finding_source_integrity_not_verified:'),
      ),
    )
    assert.ok(
      report.limitations.some((l) =>
        l.startsWith('unverified_model_stopping_prose_excluded:'),
      ),
    )
    assert.notDeepEqual(report.unanswered_questions, terminal_report.unanswered_questions)
  })
})
