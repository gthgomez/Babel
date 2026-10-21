/**
 * Durable regression: failed attempt A and succeeded attempt B reuse the same passage_id
 * with distinct source_fetch_owner stamps (cfe0cd76 ID-set collision).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { PassageRecord } from '../contracts/passages.js'
import { createMissionScopedSourceAccessPort } from '../access/missionScopedSourceAccessPort.js'
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
import { filterPassagesForExtractionLineage } from './retrievalExtractionLineage.js'
import { runAdmittedResearchEndToEndPass } from './researchEndToEndPass.js'
import { ownedInlinePassage } from './testSupport/lineageDurableSeedHelpers.js'

const FIXED_NOW = '2026-10-20T12:55:00.000Z'
const SHARED_PASSAGE_ID = 'collision-reused-passage-id'
const OP = 'collision-fetch-op'
const ATT_FAIL = `${OP}-attempt-failed-a`
const ATT_OK = `${OP}-attempt-succeeded-b`
const FAIL_TEXT = 'extract-must-not-see-failed-attempt-text'
const OK_TEXT = 'extract-must-see-succeeded-attempt-text-only'

async function seedSharedPassageIdCollision(
  store: DurableResearchStore,
  ctx: { mission_id: string; plan_revision_id: string; writer_generation: number },
) {
  await store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: OP,
    attempt_id: ATT_FAIL,
    operation_kind: 'source_fetch',
    dispatched_at: '2026-10-20T12:00:00.000Z',
    idempotency_key: `${OP}:${ATT_FAIL}`,
  })
  await store.appendPassage(
    ctx,
    ownedInlinePassage({
      missionId: ctx.mission_id,
      operationId: OP,
      attemptId: ATT_FAIL,
      passageId: SHARED_PASSAGE_ID,
      text: FAIL_TEXT,
    }),
  )
  await store.appendExternalOperationCompleted(ctx, {
    mission_id: ctx.mission_id,
    operation_id: OP,
    attempt_id: ATT_FAIL,
    completed_at: '2026-10-20T12:00:01.000Z',
    settlement: 'failed',
  })
  await store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: OP,
    attempt_id: ATT_OK,
    operation_kind: 'source_fetch',
    dispatched_at: '2026-10-20T12:00:02.000Z',
    idempotency_key: `${OP}:${ATT_OK}`,
  })
  await store.appendPassage(
    ctx,
    ownedInlinePassage({
      missionId: ctx.mission_id,
      operationId: OP,
      attemptId: ATT_OK,
      passageId: SHARED_PASSAGE_ID,
      text: OK_TEXT,
    }),
  )
  await store.appendExternalOperationCompleted(ctx, {
    mission_id: ctx.mission_id,
    operation_id: OP,
    attempt_id: ATT_OK,
    completed_at: '2026-10-20T12:00:03.000Z',
    settlement: 'succeeded',
  })
}

function succeededOwner(passage: PassageRecord) {
  return (
    passage.source_fetch_owner?.mission_id === exampleMissionWriteContext.mission_id &&
    passage.source_fetch_owner?.operation_id === OP &&
    passage.source_fetch_owner?.attempt_id === ATT_OK
  )
}

describe('research e2e extraction lineage @ shared passage_id collision (cfe0cd76)', () => {
  it('lineage filter after durable reopen admits only succeeded attempt record for passage_id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-shared-passage-id-filter-'))
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const seedCtx = {
        ...exampleMissionWriteContext,
        writer_generation: handle.writer_generation,
        plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
      }
      await store.appendPlanRevision(seedCtx, examplePlanRevisionFixture)
      await seedSharedPassageIdCollision(store, seedCtx)
      await store.close()

      store = await DurableResearchStore.open(dir)
      const events = await store.listEvents(seedCtx.mission_id)
      const allPassages = events
        .filter((e) => e.kind === 'passage_recorded')
        .map((e) => (e.payload as { passage: PassageRecord }).passage)
      assert.equal(allPassages.length, 2)

      const filtered = filterPassagesForExtractionLineage(allPassages, events)
      assert.equal(
        filtered.length,
        1,
        `expected exactly one admitted passage record; got ${filtered.length}`,
      )
      const admitted = filtered[0]!
      assert.equal(admitted.passage_id, SHARED_PASSAGE_ID)
      assert.equal(succeededOwner(admitted), true)
      const inline = admitted.text_ref.mode === 'inline' ? admitted.text_ref.text : ''
      assert.equal(inline, OK_TEXT)
      assert.notEqual(inline, FAIL_TEXT)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('e2e extract input after durable reopen uses only succeeded attempt bytes for passage_id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'research-shared-passage-id-e2e-'))
    const extractPassageIds: string[] = []
    const extractPassageTexts: string[] = []
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const seedCtx = {
        ...exampleMissionWriteContext,
        writer_generation: handle.writer_generation,
        plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
      }
      await store.appendPlanRevision(seedCtx, examplePlanRevisionFixture)
      await seedSharedPassageIdCollision(store, seedCtx)
      await store.close()

      store = await DurableResearchStore.open(dir)
      const fixture = new FixtureResearchModelBridge()
      const model = {
        async invokeStructured(request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult> {
          if (request.kind === 'plan_questions') {
            fixture.scriptOutput(request.operationId, {
              kind: 'plan_questions',
              questions: [{ text: 'Shared passage id?', importance: 'high' }],
            })
          }
          if (request.kind === 'extract_findings') {
            extractPassageIds.push(...((request.input.passage_ids as string[]) ?? []))
            const rows = (request.input.passages as { passage_id: string; text: string }[]) ?? []
            extractPassageTexts.push(...rows.map((r) => r.text))
            fixture.scriptOutput(request.operationId, {
              kind: 'extract_findings',
              findings: [],
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
              answer_summary: 'collision probe',
              stopping_reason: 'shared_passage_id_collision',
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
        access: createMissionScopedSourceAccessPort({
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
        }),
        adapter,
        registries,
        discoverQuery: 'RESEARCH_CONTRACT',
        planOperationId: 'collision-plan',
        planAttemptId: 'collision-plan-att',
        planRevisionId: 'plan-collision-passage-id',
        retrievalSearchOperationId: 'collision-search',
        retrievalSearchAttemptId: 'collision-search-att',
        retrievalFetchOperationId: 'collision-fetch',
        retrievalFetchAttemptId: 'collision-fetch-att',
        extractOperationId: 'collision-extract',
        extractAttemptId: 'collision-extract-att',
        reviewOperationId: 'collision-review',
        reviewAttemptId: 'collision-review-att',
        synthesizeOperationId: 'collision-synth',
        synthesizeAttemptId: 'collision-synth-att',
        dispatchedAt: '2026-10-20T12:54:00.000Z',
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      })

      assert.equal(
        extractPassageTexts.filter((t) => t === FAIL_TEXT).length,
        0,
        'failed attempt text must not appear in extract passages payload',
      )
      assert.equal(
        extractPassageTexts.filter((t) => t === OK_TEXT).length,
        1,
        `succeeded collision record text must appear exactly once; got texts=${extractPassageTexts.join('|')}`,
      )
      assert.ok(
        extractPassageIds.includes(SHARED_PASSAGE_ID),
        'extract must include shared passage_id from succeeded owner row',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
