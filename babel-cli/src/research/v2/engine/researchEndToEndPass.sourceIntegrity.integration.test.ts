import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createMissionScopedSourceAccessPort } from '../access/missionScopedSourceAccessPort.js'
import { PlanRevisionSchema } from '../contracts/plan.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
} from '../fixtures/technicalRepositoryCorpus.js'
import { searchIndexForTechnicalMission } from '../fixtures/technicalSearchIndex.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import type {
  ResearchModelInvocationRequest,
  ResearchModelInvocationResult,
  ResearchModelPort,
} from '../ports/researchModelPort.js'
import { DurableResearchStore } from '../persistence/durableResearchStore.js'
import { createTechnicalResearchRegistries, resolveSourceAdapterForMission } from '../registry/frozenRegistries.js'
import { listSourceRevisionsFromStoreEvents, listSourcesFromStoreEvents } from './listSourceRevisionsFromStoreEvents.js'
import { requiredClaimedSourceReviewFields } from './testSupport/requiredClaimedSourceReviewFields.js'
import { applyFindingSourceIntegrityFromEvidence } from './sourceIntegrityFromEvidence.js'
import { runAdmittedResearchEndToEndPass } from './researchEndToEndPass.js'
import type { FindingRecord } from '../contracts/findings.js'
import type { PassageRecord } from '../contracts/passages.js'

const FIXED_NOW = '2026-10-21T10:00:00.000Z'

const singleQuestionPlan = PlanRevisionSchema.parse({
  plan_revision_id: 'plan-integrity-e2e',
  mission_id: exampleTechnicalMissionFixture.mission_id,
  created_at: FIXED_NOW,
  revision_reason: 'integrity_e2e',
  questions: [
    {
      question_id: 'q-integrity-1',
      text: 'What does the pinned contracts file export?',
      importance: 'critical',
      evidence_requirement: 'Quoted export from admitted repository file',
      status: 'open',
    },
  ],
})

function governedAccess() {
  return createMissionScopedSourceAccessPort({
    mission: exampleTechnicalMissionFixture,
    searchIndex: searchIndexForTechnicalMission(exampleTechnicalMissionFixture),
    admittedGet: async () => ({
      ok: true,
      status: 200,
      contentType: 'text/plain',
      buffer: Buffer.from(technicalRepositoryCorpusBody, 'utf8'),
      bytesReceived: technicalRepositoryCorpusBody.length,
      truncated: false,
      requestedUrl: technicalRepositoryCorpusFinalUrl,
      finalUrl: technicalRepositoryCorpusFinalUrl,
      redirectChain: [technicalRepositoryCorpusFinalUrl],
      transportCoding: null,
    }),
  })
}

function completePathFixtureModel(): ResearchModelPort {
  const fixture = new FixtureResearchModelBridge()
  fixture.scriptOutput('integrity-plan', {
    kind: 'plan_questions',
    questions: [
      {
        text: singleQuestionPlan.questions[0]!.text,
        importance: 'critical',
        coverage_obligations: [
          {
            obligation_id: 'ob-integrity-repository-pin-0',
            source_slot: 'repository-pin-0',
            criterion_id: 'research_contract_export',
            evidence_requirement: 'Repository excerpt documents RESEARCH_CONTRACT export.',
          },
        ],
      },
    ],
  })
  return {
    async invokeStructured(request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult> {
      if (request.kind === 'extract_findings') {
        const passageIds = (request.input.passage_ids as string[]) ?? []
        const planQuestions =
          (request.input.plan_questions as { question_id: string }[] | undefined) ?? []
        const questionId = planQuestions[0]?.question_id ?? 'q-integrity-1'
        fixture.scriptOutput(request.operationId, {
          kind: 'extract_findings',
          findings: [
            {
              assertion_text: 'The file exports a RESEARCH_CONTRACT constant.',
              assertion_kind: 'source_observation',
              passage_ids: passageIds,
              question_id: questionId,
            },
          ],
        })
      }
      if (request.kind === 'semantic_support_review') {
        type ReviewFinding = {
          finding_id: string
          cited_passages: Array<{ passage_id: string; content_status: string }>
          coverage_rubric?: { coverage_obligations: Array<{ obligation_id: string }> }
        }
        const findingsInput = (request.input.findings as ReviewFinding[]) ?? []
        fixture.scriptOutput(request.operationId, {
          kind: 'semantic_support_review',
          judgments: findingsInput.map((row) => {
            const passageIds = row.cited_passages
              .filter((p) => p.content_status === 'available')
              .map((p) => p.passage_id)
            return {
              finding_id: row.finding_id,
              status: 'supported',
              rationale: 'Cited excerpt states the export.',
              question_coverage: 'answers',
              ...requiredClaimedSourceReviewFields(['repository-pin-0']),
              obligation_coverage: (row.coverage_rubric?.coverage_obligations ?? []).map((o) => ({
                obligation_id: o.obligation_id,
                status: 'met',
                supporting_passage_ids: passageIds,
              })),
            }
          }),
        })
      }
      if (request.kind === 'synthesize_report') {
        fixture.scriptOutput(request.operationId, {
          kind: 'synthesize_report',
          answer_summary: 'The admitted repository excerpt documents the export.',
          stopping_reason: 'coverage_sufficient',
        })
      }
      return fixture.invokeStructured(request)
    },
  }
}

function latestFindings(events: Awaited<ReturnType<DurableResearchStore['listEvents']>>): FindingRecord[] {
  const byId = new Map<string, FindingRecord>()
  for (const event of events) {
    if (event.kind !== 'finding_recorded') continue
    const finding = (event.payload as { finding: FindingRecord }).finding
    byId.set(finding.finding_id, finding)
  }
  return [...byId.values()]
}

describe('source integrity end-to-end (DurableResearchStore)', () => {
  it('complete path: verified integrity, terminal complete, cold reopen preserves receipts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-integrity-e2e-'))
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const session = { mission: exampleTechnicalMissionFixture, handle }
      const registries = createTechnicalResearchRegistries()
      const adapter = resolveSourceAdapterForMission(exampleTechnicalMissionFixture, registries)
      assert.ok(adapter)

      const result = await runAdmittedResearchEndToEndPass({
        session,
        store,
        model: completePathFixtureModel(),
        access: governedAccess(),
        adapter,
        registries,
        discoverQuery: 'RESEARCH_CONTRACT',
        planOperationId: 'integrity-plan',
        planAttemptId: 'integrity-plan-att',
        planRevisionId: singleQuestionPlan.plan_revision_id,
        retrievalSearchOperationId: 'integrity-search',
        retrievalSearchAttemptId: 'integrity-search-att',
        retrievalFetchOperationId: 'integrity-fetch',
        retrievalFetchAttemptId: 'integrity-fetch-att',
        extractOperationId: 'integrity-extract',
        extractAttemptId: 'integrity-extract-att',
        reviewOperationId: 'integrity-review',
        reviewAttemptId: 'integrity-review-att',
        synthesizeOperationId: 'integrity-synth',
        synthesizeAttemptId: 'integrity-synth-att',
        dispatchedAt: FIXED_NOW,
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      })

      assert.ok(result.passageIds.length >= 1)
      let events = await store.listEvents(session.mission.mission_id)
      const passages = events
        .filter((e) => e.kind === 'passage_recorded')
        .map((e) => (e.payload as { passage: PassageRecord }).passage)
      assert.ok(passages.every((p) => p.integrity_verification !== undefined))

      const findings = latestFindings(events)
      assert.ok(findings.every((f) => f.source_integrity === 'valid'))

      const terminal = events.find((e) => e.kind === 'terminal_receipt')
      const report = (
        terminal?.payload as {
          report: { terminal_state: string; limitations?: string[]; unanswered_questions?: string[] }
        }
      ).report
      assert.ok(
        !report.limitations?.some((l) => l.startsWith('finding_source_integrity_not_verified:')),
      )
      assert.equal(report.terminal_state, 'complete', JSON.stringify(report))

      await store.close()
      store = await DurableResearchStore.open(dir)
      events = await store.listEvents(session.mission.mission_id)
      const reopenedPassages = events
        .filter((e) => e.kind === 'passage_recorded')
        .map((e) => (e.payload as { passage: PassageRecord }).passage)
      assert.ok(reopenedPassages.every((p) => p.integrity_verification !== undefined))

      const sources = listSourcesFromStoreEvents(events)
      const revisions = listSourceRevisionsFromStoreEvents(events)
      const reopenedFindings = applyFindingSourceIntegrityFromEvidence(
        latestFindings(events),
        reopenedPassages,
        revisions,
        sources,
        events,
      )
      assert.ok(reopenedFindings.every((f) => f.source_integrity === 'valid'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
