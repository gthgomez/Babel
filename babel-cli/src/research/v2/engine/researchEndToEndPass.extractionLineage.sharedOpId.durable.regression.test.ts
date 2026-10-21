/**
 * Durable regression for A dd544 extraction lineage (B-owned, pre-integration).
 * A owns `retrievalExtractionLineage` production helper; this test exercises
 * `runAdmittedResearchEndToEndPass` extract input against real store events.
 *
 * Contract: failed attempt A and succeeded attempt B sharing one `operation_id`
 * must not expose A's orphan passages to extraction (including interleaved intents).
 */
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

const FIXED_NOW = '2026-10-20T12:45:00.000Z'
const SHARED_FETCH_OP = 'shared-fetch-operation-id'

/** Set when running `npm run test:research-v2-extraction-lineage-blocked-regression` (fails until A dd544 lands). */
const RUN_BLOCKED_REGRESSION = process.env.BABEL_RESEARCH_V2_RUN_BLOCKED_REGRESSION === '1'

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

function inlinePassage(passageId: string, text: string) {
  return PassageRecordSchema.parse({
    passage_id: passageId,
    source_revision_id: `rev-${passageId}`,
    locator: { kind: 'line_range', start_line: 1, end_line: 1 },
    text_ref: {
      mode: 'inline',
      text,
      text_hash: createHash('sha256').update(text).digest('hex'),
    },
  })
}

async function seedSharedOperationLineageConflict(
  store: DurableResearchStore,
  ctx: { mission_id: string; writer_generation: number },
  interleaved: boolean,
) {
  const orphanText = 'orphan-passage-from-failed-attempt-a'
  const admittedText = 'admitted-passage-from-succeeded-attempt-b'
  const orphanId = `${SHARED_FETCH_OP}:orphan-a`
  const admittedId = `${SHARED_FETCH_OP}:admitted-b`

  if (interleaved) {
    await store.appendExternalOperationIntent(ctx, {
      mission_id: ctx.mission_id,
      operation_id: SHARED_FETCH_OP,
      attempt_id: `${SHARED_FETCH_OP}-attempt-a`,
      operation_kind: 'source_fetch',
      dispatched_at: '2026-10-20T12:00:00.000Z',
      idempotency_key: SHARED_FETCH_OP,
    })
    await store.appendExternalOperationIntent(ctx, {
      mission_id: ctx.mission_id,
      operation_id: SHARED_FETCH_OP,
      attempt_id: `${SHARED_FETCH_OP}-attempt-b`,
      operation_kind: 'source_fetch',
      dispatched_at: '2026-10-20T12:00:00.100Z',
      idempotency_key: SHARED_FETCH_OP,
    })
    await store.appendPassage(ctx, inlinePassage(orphanId, orphanText))
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: ctx.mission_id,
      operation_id: SHARED_FETCH_OP,
      attempt_id: `${SHARED_FETCH_OP}-attempt-a`,
      completed_at: '2026-10-20T12:00:01.000Z',
      settlement: 'failed',
    })
    await store.appendPassage(ctx, inlinePassage(admittedId, admittedText))
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: ctx.mission_id,
      operation_id: SHARED_FETCH_OP,
      attempt_id: `${SHARED_FETCH_OP}-attempt-b`,
      completed_at: '2026-10-20T12:00:02.000Z',
      settlement: 'succeeded',
    })
    return { orphanId, admittedId, orphanText, admittedText }
  }

  await store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: SHARED_FETCH_OP,
    attempt_id: `${SHARED_FETCH_OP}-attempt-a`,
    operation_kind: 'source_fetch',
    dispatched_at: '2026-10-20T12:00:00.000Z',
    idempotency_key: SHARED_FETCH_OP,
  })
  await store.appendPassage(ctx, inlinePassage(orphanId, orphanText))
  await store.appendExternalOperationCompleted(ctx, {
    mission_id: ctx.mission_id,
    operation_id: SHARED_FETCH_OP,
    attempt_id: `${SHARED_FETCH_OP}-attempt-a`,
    completed_at: '2026-10-20T12:00:01.000Z',
    settlement: 'failed',
  })
  await store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: SHARED_FETCH_OP,
    attempt_id: `${SHARED_FETCH_OP}-attempt-b`,
    operation_kind: 'source_fetch',
    dispatched_at: '2026-10-20T12:00:01.500Z',
    idempotency_key: SHARED_FETCH_OP,
  })
  await store.appendPassage(ctx, inlinePassage(admittedId, admittedText))
  await store.appendExternalOperationCompleted(ctx, {
    mission_id: ctx.mission_id,
    operation_id: SHARED_FETCH_OP,
    attempt_id: `${SHARED_FETCH_OP}-attempt-b`,
    completed_at: '2026-10-20T12:00:02.000Z',
    settlement: 'succeeded',
  })
  return { orphanId, admittedId, orphanText, admittedText }
}

describe('research e2e extraction lineage @ A dd544 (durable, shared operation_id)', () => {
  async function runLineageCase(interleaved: boolean) {
    const dir = await mkdtemp(join(tmpdir(), 'research-e2e-shared-op-lineage-'))
    const extractPassageIds: string[] = []
    const extractPassageTexts: string[] = []
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const seedCtx = { ...exampleMissionWriteContext, writer_generation: handle.writer_generation }
      await store.appendPlanRevision(seedCtx, examplePlanRevisionFixture)
      const seeded = await seedSharedOperationLineageConflict(store, seedCtx, interleaved)
      await store.close()

      store = await DurableResearchStore.open(dir)
      const fixture = new FixtureResearchModelBridge()
      const model = {
        async invokeStructured(request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult> {
          if (request.kind === 'plan_questions') {
            fixture.scriptOutput(request.operationId, {
              kind: 'plan_questions',
              questions: [{ text: 'Shared op lineage?', importance: 'high' }],
            })
          }
          if (request.kind === 'extract_findings') {
            extractPassageIds.push(...((request.input.passage_ids as string[]) ?? []))
            const rows = (request.input.passages as { passage_id: string; text: string }[]) ?? []
            extractPassageTexts.push(...rows.map((r) => r.text))
            const planQuestions =
              (request.input.plan_questions as { question_id: string }[] | undefined) ?? []
            const questionId = planQuestions[0]?.question_id ?? 'q-plan-lineage-shared-1'
            fixture.scriptOutput(request.operationId, {
              kind: 'extract_findings',
              findings: [
                {
                  assertion_text: 'Observed from lineage-filtered passages only.',
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
              stopping_reason: 'lineage_shared_op_test',
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
        planOperationId: 'shared-lineage-plan',
        planAttemptId: 'shared-lineage-plan-att',
        planRevisionId: 'plan-lineage-shared-op',
        retrievalSearchOperationId: 'shared-lineage-search',
        retrievalSearchAttemptId: 'shared-lineage-search-att',
        retrievalFetchOperationId: 'shared-lineage-fetch',
        retrievalFetchAttemptId: 'shared-lineage-fetch-att',
        extractOperationId: 'shared-lineage-extract',
        extractAttemptId: 'shared-lineage-extract-att',
        reviewOperationId: 'shared-lineage-review',
        reviewAttemptId: 'shared-lineage-review-att',
        synthesizeOperationId: 'shared-lineage-synth',
        synthesizeAttemptId: 'shared-lineage-synth-att',
        dispatchedAt: '2026-10-20T12:44:00.000Z',
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      })

      assert.equal(
        extractPassageIds.includes(seeded.orphanId),
        false,
        `failed attempt A orphan must not reach extract (shared operation_id=${SHARED_FETCH_OP}, interleaved=${interleaved}); got passage_ids=${extractPassageIds.join(',')}`,
      )
      assert.equal(
        extractPassageTexts.includes(seeded.orphanText),
        false,
        `failed attempt A orphan text leaked to extract passages payload (interleaved=${interleaved})`,
      )

      const events = await store.listEvents(seedCtx.mission_id)
      assert.ok(events.some((e) => e.kind === 'passage_recorded' && (e.payload as { passage: { passage_id: string } }).passage.passage_id === seeded.orphanId))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('sequential attempts: shared operation_id excludes failed attempt A orphan from extract', async (t) => {
    if (!RUN_BLOCKED_REGRESSION) {
      t.skip(
        'Blocked until A dd544 integrates filterPassagesForExtractionLineage; run npm run test:research-v2-extraction-lineage-blocked-regression',
      )
      return
    }
    await runLineageCase(false)
  })

  it('interleaved intents: shared operation_id excludes failed attempt A orphan from extract', async (t) => {
    if (!RUN_BLOCKED_REGRESSION) {
      t.skip(
        'Blocked until A dd544 integrates filterPassagesForExtractionLineage; run npm run test:research-v2-extraction-lineage-blocked-regression',
      )
      return
    }
    await runLineageCase(true)
  })
})
