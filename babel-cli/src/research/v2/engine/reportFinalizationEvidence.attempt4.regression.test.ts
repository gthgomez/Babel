import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { FindingRecordSchema } from '../contracts/findings.js'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { PlanRevisionSchema } from '../contracts/plan.js'
import { SourceRecordSchema, SourceRevisionSchema } from '../contracts/sources.js'
import { buildSynthesizedResearchReport } from './buildSynthesizedResearchReport.js'
import {
  buildHostSourceCutoff,
  buildHostStoppingReason,
  buildSourceFreshnessLimitations,
  buildTruncatedSourceDisclosureLimitations,
  deriveEvidenceBackedUnansweredQuestionIds,
} from './reportFinalizationEvidence.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const subsetPath = join(repoRoot, 'review-artifacts/general-g-l1-attempt4-evidence-subset.json')
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

function loadAttempt4Subset() {
  const subset = JSON.parse(readFileSync(subsetPath, 'utf8'))
  const source = SourceRecordSchema.parse(subset.source)
  const revision = SourceRevisionSchema.parse(subset.revision)
  const findings = subset.findings.map((f: unknown) => FindingRecordSchema.parse(f))
  return { subset, source, revision, findings }
}

describe('G-L1 attempt4 report finalization evidence (host-owned, not model self-assertion)', () => {
  it('loads sanitized ORIGINAL evidence subset fixture with six passages and six findings', () => {
    const { subset, revision, findings } = loadAttempt4Subset()
    assert.equal(subset.provenance.source_revision_content_hash, revision.content_hash)
    assert.equal(
      revision.content_hash,
      'a0afa499c0bcfcfad46229c19edd86e0907e0eade9b0f7dbbe939a861254d1dc',
    )
    assert.equal(subset.passages.length, 6)
    assert.equal(findings.length, 6)
    assert.ok(subset.passages.every((p: { passage_id: string }) => /:html:[0-5]$/.test(p.passage_id)))
    assert.ok(
      subset.provenance.extraction_command.includes(
        'extract-general-g-l1-attempt4-evidence-subset.mjs',
      ),
    )
  })

  it('derives unanswered plan questions from supported findings only (q1 answered; q2–q5 open)', () => {
    const { findings } = loadAttempt4Subset()
    const unanswered = deriveEvidenceBackedUnansweredQuestionIds(attempt4Plan, findings)
    assert.deepEqual(unanswered, [
      'q-plan-3f83793b-d454-422e-95df-ab774fb86c6c-2',
      'q-plan-3f83793b-d454-422e-95df-ab774fb86c6c-3',
      'q-plan-3f83793b-d454-422e-95df-ab774fb86c6c-4',
      'q-plan-3f83793b-d454-422e-95df-ab774fb86c6c-5',
    ])
  })

  it('surfaces truncated-source disclosure and truthful source freshness metadata', () => {
    const { source, revision } = loadAttempt4Subset()
    const truncation = buildTruncatedSourceDisclosureLimitations([revision])
    assert.equal(truncation.length, 1)
    const truncationLine = truncation[0]
    assert.ok(truncationLine)
    assert.match(truncationLine, /host_decoded_byte_limit/)
    assert.match(truncationLine, /bytes_received=200000/)
    const freshness = buildSourceFreshnessLimitations([source], [revision])
    assert.equal(freshness.length, 1)
    const freshnessLine = freshness[0]
    assert.ok(freshnessLine)
    assert.match(freshnessLine, /retrieved_at=2026-10-21T09:04:02.034Z/)
    assert.match(freshnessLine, /completeness=truncated/)
  })

  it('uses host retrieval cutoff and stopping reason instead of model synthesis prose', () => {
    const { revision, findings } = loadAttempt4Subset()
    const unanswered = deriveEvidenceBackedUnansweredQuestionIds(attempt4Plan, findings)
    const cutoff = buildHostSourceCutoff([revision])
    assert.ok(!cutoff.includes('mutually consistent'))
    assert.match(cutoff, /admitted_sources_truncated/)
    const stopping = buildHostStoppingReason({ unansweredQuestionIds: unanswered, revisions: [revision] })
    assert.equal(stopping, 'host_finalized_with_truncated_admitted_sources')
  })

  it('documents current synthesized report gap: plan-status unanswered list still lists all five questions', () => {
    const { findings, subset } = loadAttempt4Subset()
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
      modelOutput: {
        kind: 'synthesize_report',
        answer_summary: subset.terminal_report.limitations[0]?.replace(
          'unverified_model_synthesis_excluded: ',
          '',
        ) ?? 'synthesis',
        stopping_reason: subset.terminal_report.stopping_reason,
      },
      generatedAt: subset.terminal_report.generated_at,
    })
    assert.equal(report.terminal_state, 'partial')
    assert.equal(report.unanswered_questions.length, 5)
    assert.ok(!report.limitations.some((l) => l.startsWith('source_truncated:')))
    assert.match(report.source_cutoff ?? '', /mutually consistent/)
    const evidenceUnanswered = deriveEvidenceBackedUnansweredQuestionIds(attempt4Plan, findings)
    assert.notDeepEqual(report.unanswered_questions, evidenceUnanswered)
  })
})
