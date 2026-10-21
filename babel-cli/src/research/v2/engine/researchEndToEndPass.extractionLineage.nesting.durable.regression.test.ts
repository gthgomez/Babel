/**
 * Durable regression for nested fetch attempts and revision ownership (B-owned).
 * Characterizes bb774 nesting / revision-set OR leaks A must fix with attempt-owned evidence.
 * Uses production `filterPassagesForExtractionLineage` and `runAdmittedResearchEndToEndPass` only.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { PassageRecord } from '../contracts/passages.js'
import { ownedInlinePassage } from './testSupport/lineageDurableSeedHelpers.js'
import type { SourceRevision } from '../contracts/sources.js'
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

const FIXED_NOW = '2026-10-20T12:50:00.000Z'
const REV_RA = 'revision-RA-good'
const REV_RB = 'revision-RB-bad'

function revisionRecord(revisionId: string): SourceRevision {
  return {
    revision_id: revisionId,
    source_id: 'source-nesting-fixture',
    content_hash: createHash('sha256').update(revisionId).digest('hex'),
    retrieved_at: '2026-10-20T12:00:00.500Z',
    extraction_version: 'test/nesting',
    media_type: 'text/plain',
    completeness: 'complete',
    byte_length_received: 64,
  }
}

type NestingCase = {
  label: string
  sharedOperationId: boolean
  opA: string
  opB: string
  /** true: intent A then B before either completes; false: intent B then A */
  intentOrder: 'a_then_b' | 'b_then_a'
}

async function seedNestedRevisionLineage(
  store: DurableResearchStore,
  ctx: {
    mission_id: string
    plan_revision_id: string
    writer_generation: number
  },
  caseDef: NestingCase,
) {
  const op = caseDef.sharedOperationId ? 'shared-nested-fetch' : undefined
  const opA = caseDef.sharedOperationId ? op! : caseDef.opA
  const opB = caseDef.sharedOperationId ? op! : caseDef.opB
  const attA = `${opA}-attempt-a`
  const attB = `${opB}-attempt-b`
  const badText = 'bad-passage-from-failed-nested-attempt'
  const goodText = 'good-passage-from-succeeded-outer-attempt'
  const badId = 'nesting-bad-passage-rb'
  const goodId = 'nesting-good-passage-ra'

  const intentA = {
    mission_id: ctx.mission_id,
    operation_id: opA,
    attempt_id: attA,
    operation_kind: 'source_fetch' as const,
    dispatched_at: '2026-10-20T12:00:00.000Z',
    idempotency_key: `${opA}:${attA}`,
  }
  const intentB = {
    mission_id: ctx.mission_id,
    operation_id: opB,
    attempt_id: attB,
    operation_kind: 'source_fetch' as const,
    dispatched_at: '2026-10-20T12:00:00.050Z',
    idempotency_key: `${opB}:${attB}`,
  }

  if (caseDef.intentOrder === 'a_then_b') {
    await store.appendExternalOperationIntent(ctx, intentA)
    await store.appendExternalOperationIntent(ctx, intentB)
    await store.appendSourceRevision(ctx, revisionRecord(REV_RB))
    await store.appendPassage(
      ctx,
      ownedInlinePassage({
        missionId: ctx.mission_id,
        operationId: opB,
        attemptId: attB,
        passageId: badId,
        text: badText,
        sourceRevisionId: REV_RB,
      }),
    )
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: ctx.mission_id,
      operation_id: opB,
      attempt_id: attB,
      completed_at: '2026-10-20T12:00:01.000Z',
      settlement: 'failed',
    })
    await store.appendSourceRevision(ctx, revisionRecord(REV_RA))
    await store.appendPassage(
      ctx,
      ownedInlinePassage({
        missionId: ctx.mission_id,
        operationId: opA,
        attemptId: attA,
        passageId: goodId,
        text: goodText,
        sourceRevisionId: REV_RA,
      }),
    )
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: ctx.mission_id,
      operation_id: opA,
      attempt_id: attA,
      completed_at: '2026-10-20T12:00:02.000Z',
      settlement: 'succeeded',
    })
  } else {
    await store.appendExternalOperationIntent(ctx, intentB)
    await store.appendExternalOperationIntent(ctx, intentA)
    await store.appendSourceRevision(ctx, revisionRecord(REV_RA))
    await store.appendPassage(
      ctx,
      ownedInlinePassage({
        missionId: ctx.mission_id,
        operationId: opA,
        attemptId: attA,
        passageId: goodId,
        text: goodText,
        sourceRevisionId: REV_RA,
      }),
    )
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: ctx.mission_id,
      operation_id: opA,
      attempt_id: attA,
      completed_at: '2026-10-20T12:00:01.000Z',
      settlement: 'succeeded',
    })
    await store.appendSourceRevision(ctx, revisionRecord(REV_RB))
    await store.appendPassage(
      ctx,
      ownedInlinePassage({
        missionId: ctx.mission_id,
        operationId: opB,
        attemptId: attB,
        passageId: badId,
        text: badText,
        sourceRevisionId: REV_RB,
      }),
    )
    await store.appendExternalOperationCompleted(ctx, {
      mission_id: ctx.mission_id,
      operation_id: opB,
      attempt_id: attB,
      completed_at: '2026-10-20T12:00:02.000Z',
      settlement: 'failed',
    })
  }

  return { badId, goodId, badText, goodText, opA, opB }
}

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

describe('research e2e extraction lineage @ nested attempts (durable, bb774 gap)', () => {
  const cases: NestingCase[] = [
    {
      label: 'same operation_id, intent A then nested B',
      sharedOperationId: true,
      opA: 'unused',
      opB: 'unused',
      intentOrder: 'a_then_b',
    },
    {
      label: 'same operation_id, intent B then nested A',
      sharedOperationId: true,
      opA: 'unused',
      opB: 'unused',
      intentOrder: 'b_then_a',
    },
    {
      label: 'distinct operation_id, intent A then nested B',
      sharedOperationId: false,
      opA: 'fetch-nested-op-a',
      opB: 'fetch-nested-op-b',
      intentOrder: 'a_then_b',
    },
    {
      label: 'distinct operation_id, intent B then nested A',
      sharedOperationId: false,
      opA: 'fetch-nested-op-a',
      opB: 'fetch-nested-op-b',
      intentOrder: 'b_then_a',
    },
  ]

  for (const caseDef of cases) {
    it(`lineage filter after close/reopen: ${caseDef.label}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'research-nested-lineage-filter-'))
      try {
        let store = await DurableResearchStore.open(dir)
        const handle = await store.appendMission(exampleTechnicalMissionFixture)
        const seedCtx = {
          ...exampleMissionWriteContext,
          writer_generation: handle.writer_generation,
          plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
        }
        await store.appendPlanRevision(seedCtx, examplePlanRevisionFixture)
        const seeded = await seedNestedRevisionLineage(store, seedCtx, caseDef)
        await store.close()

        store = await DurableResearchStore.open(dir)
        const events = await store.listEvents(seedCtx.mission_id)
        const allPassages = events
          .filter((e) => e.kind === 'passage_recorded')
          .map((e) => (e.payload as { passage: PassageRecord }).passage)
        const admitted = filterPassagesForExtractionLineage(allPassages, events).map((p) => p.passage_id)

        assert.equal(
          admitted.includes(seeded.badId),
          false,
          `${caseDef.label}: failed nested attempt RB passage must not reach extraction`,
        )
        assert.equal(
          admitted.includes(seeded.goodId),
          true,
          `${caseDef.label}: succeeded attempt RA passage must remain admitted`,
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it(`e2e extract input after close/reopen: ${caseDef.label}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'research-nested-lineage-e2e-'))
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
        const seeded = await seedNestedRevisionLineage(store, seedCtx, caseDef)
        await store.close()

        store = await DurableResearchStore.open(dir)
        const fixture = new FixtureResearchModelBridge()
        const model = {
          async invokeStructured(request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult> {
            if (request.kind === 'plan_questions') {
              fixture.scriptOutput(request.operationId, {
                kind: 'plan_questions',
                questions: [{ text: 'Nested lineage?', importance: 'high' }],
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
                answer_summary: 'nested lineage probe',
                stopping_reason: 'nested_lineage_test',
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
          planOperationId: `nested-plan-${caseDef.intentOrder}`,
          planAttemptId: 'nested-plan-att',
          planRevisionId: `plan-nested-${caseDef.sharedOperationId ? 'shared' : 'distinct'}`,
          retrievalSearchOperationId: 'nested-search',
          retrievalSearchAttemptId: 'nested-search-att',
          retrievalFetchOperationId: 'nested-fetch',
          retrievalFetchAttemptId: 'nested-fetch-att',
          extractOperationId: 'nested-extract',
          extractAttemptId: 'nested-extract-att',
          reviewOperationId: 'nested-review',
          reviewAttemptId: 'nested-review-att',
          synthesizeOperationId: 'nested-synth',
          synthesizeAttemptId: 'nested-synth-att',
          dispatchedAt: '2026-10-20T12:49:00.000Z',
          signal: new AbortController().signal,
          now: () => FIXED_NOW,
        })

        assert.equal(
          extractPassageIds.includes(seeded.badId),
          false,
          `${caseDef.label}: bad RB passage leaked to extract passage_ids`,
        )
        assert.equal(
          extractPassageTexts.includes(seeded.badText),
          false,
          `${caseDef.label}: bad RB text leaked to extract passages payload`,
        )
        assert.ok(
          extractPassageIds.includes(seeded.goodId),
          `${caseDef.label}: good RA passage must reach extract; got ${extractPassageIds.join(',')}`,
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  }
})
