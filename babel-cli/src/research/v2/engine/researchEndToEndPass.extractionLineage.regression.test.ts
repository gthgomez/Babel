import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createMissionScopedSourceAccessPort } from '../access/missionScopedSourceAccessPort.js'
import { PassageRecordSchema } from '../contracts/passages.js'
import {
  exampleMissionWriteContext,
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
} from '../fixtures/technicalRepositoryCorpus.js'
import { searchIndexForTechnicalMission } from '../fixtures/technicalSearchIndex.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import type { ResearchModelInvocationRequest, ResearchModelInvocationResult } from '../ports/researchModelPort.js'
import { DurableResearchStore } from '../persistence/durableResearchStore.js'
import { createTechnicalResearchRegistries, resolveSourceAdapterForMission } from '../registry/frozenRegistries.js'
import { runAdmittedResearchEndToEndPass } from './researchEndToEndPass.js'

const FIXED_NOW = '2026-10-20T12:30:00.000Z'

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

describe('research end-to-end pass extraction lineage (resume regression)', () => {
  it('omits orphan passages from failed partial fetch after durable reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-e2e-lineage-'))
    const extractPassageIds: string[] = []
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const seedCtx = { ...exampleMissionWriteContext, writer_generation: handle.writer_generation }
      await store.appendPlanRevision(seedCtx, examplePlanRevisionFixture)
      const failedOp = 'seed-partial-failed-fetch'
      const orphanText = 'orphan-from-failed-persistence'
      await store.appendExternalOperationIntent(seedCtx, {
        mission_id: seedCtx.mission_id,
        operation_id: failedOp,
        attempt_id: `${failedOp}-att`,
        operation_kind: 'source_fetch',
        dispatched_at: '2026-10-20T12:00:00.000Z',
        idempotency_key: failedOp,
      })
      await store.appendPassage(
        seedCtx,
        PassageRecordSchema.parse({
          passage_id: `${failedOp}:orphan`,
          source_revision_id: 'rev-orphan',
          locator: { kind: 'line_range', start_line: 1, end_line: 1 },
          text_ref: {
            mode: 'inline',
            text: orphanText,
            text_hash: createHash('sha256').update(orphanText).digest('hex'),
          },
        }),
      )
      await store.appendExternalOperationCompleted(seedCtx, {
        mission_id: seedCtx.mission_id,
        operation_id: failedOp,
        attempt_id: `${failedOp}-att`,
        completed_at: '2026-10-20T12:00:01.000Z',
        settlement: 'failed',
      })
      await store.close()

      store = await DurableResearchStore.open(dir)
      const eventsBefore = await store.listEvents(seedCtx.mission_id)
      assert.ok(eventsBefore.some((e) => e.kind === 'passage_recorded'))

      const fixture = new FixtureResearchModelBridge()
      const model = {
        async invokeStructured(request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult> {
          if (request.kind === 'plan_questions') {
            fixture.scriptOutput(request.operationId, {
              kind: 'plan_questions',
              questions: [{ text: 'Lineage check?', importance: 'high' }],
            })
          }
          if (request.kind === 'extract_findings') {
            extractPassageIds.push(
              ...((request.input.passage_ids as string[]) ?? []),
            )
            const planQuestions =
              (request.input.plan_questions as { question_id: string }[] | undefined) ?? []
            const questionId = planQuestions[0]?.question_id ?? 'q-plan-lineage-001-1'
            fixture.scriptOutput(request.operationId, {
              kind: 'extract_findings',
              findings: [
                {
                  assertion_text: 'Observed from admitted retrieval only.',
                  assertion_kind: 'source_observation',
                  passage_ids: (request.input.passage_ids as string[]) ?? [],
                  question_id: questionId,
                },
              ],
            })
          }
          if (request.kind === 'semantic_support_review') {
            fixture.scriptOutput(request.operationId, {
              kind: 'semantic_support_review',
              judgments: [],
            })
          }
          if (request.kind === 'synthesize_report') {
            fixture.scriptOutput(request.operationId, {
              kind: 'synthesize_report',
              answer_summary: 'Lineage-filtered extract.',
              stopping_reason: 'lineage_test',
            })
          }
          return fixture.invokeStructured(request)
        },
      }

      const registries = createTechnicalResearchRegistries()
      const adapter = resolveSourceAdapterForMission(exampleTechnicalMissionFixture, registries)
      assert.ok(adapter)

      await runAdmittedResearchEndToEndPass({
        session: {
          mission: exampleTechnicalMissionFixture,
          handle,
          activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
        },
        store,
        model,
        access: governedAccess(),
        adapter,
        registries,
        discoverQuery: 'RESEARCH_CONTRACT',
        planOperationId: 'lineage-plan',
        planAttemptId: 'lineage-plan-att',
        planRevisionId: 'plan-lineage-001',
        retrievalSearchOperationId: 'lineage-search',
        retrievalSearchAttemptId: 'lineage-search-att',
        retrievalFetchOperationId: 'lineage-fetch',
        retrievalFetchAttemptId: 'lineage-fetch-att',
        extractOperationId: 'lineage-extract',
        extractAttemptId: 'lineage-extract-att',
        reviewOperationId: 'lineage-review',
        reviewAttemptId: 'lineage-review-att',
        synthesizeOperationId: 'lineage-synth',
        synthesizeAttemptId: 'lineage-synth-att',
        dispatchedAt: '2026-10-20T12:29:00.000Z',
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      })

      assert.ok(extractPassageIds.length >= 1)
      assert.equal(
        extractPassageIds.some((id) => id.startsWith(`${failedOp}:`)),
        false,
        'failed partial-fetch orphan must not feed extraction',
      )
      const eventsAfter = await store.listEvents(seedCtx.mission_id)
      assert.equal(eventsAfter.filter((e) => e.kind === 'passage_recorded').length >= 2, true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
