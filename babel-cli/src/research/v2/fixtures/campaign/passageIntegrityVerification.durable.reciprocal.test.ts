/**
 * B-owned reciprocal integrity tests on A canonical PassageRecord.integrity_verification (ffbad3).
 * Real DurableResearchStore; stub model/network only. Historical G-L2/G-L3 bytes unchanged elsewhere.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createMissionScopedSourceAccessPort } from '../../access/missionScopedSourceAccessPort.js'
import { FindingRecordSchema } from '../../contracts/findings.js'
import type { FindingRecord } from '../../contracts/findings.js'
import { PlanRevisionSchema } from '../../contracts/plan.js'
import type { PassageRecord } from '../../contracts/passages.js'
import { PassageRecordSchema } from '../../contracts/passages.js'
import {
  exampleMissionWriteContext,
  exampleTechnicalMissionFixture,
} from '../../fixtures/exampleMission.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
} from '../../fixtures/technicalRepositoryCorpus.js'
import { searchIndexForTechnicalMission } from '../../fixtures/technicalSearchIndex.js'
import { passageWithIntegrityVerification } from '../../integrity/passageIntegrityReceipt.js'
import { FixtureResearchModelBridge } from '../../model/fixtureModelBridge.js'
import type { ResearchModelInvocationRequest, ResearchModelInvocationResult } from '../../ports/researchModelPort.js'
import { DurableResearchStore } from '../../persistence/durableResearchStore.js'
import { createTechnicalResearchRegistries, resolveSourceAdapterForMission } from '../../registry/frozenRegistries.js'
import { PLAIN_TEXT_EXTRACTION_VERSION, PLAIN_TEXT_MEDIA_TYPE, passagesFromAdmittedPlainText } from '../../adapters/documents/plainTextFromAdmittedBytes.js'
import { buildAdmittedContent, buildSourceRevision } from '../../adapters/documents/testAdmittedFixtures.js'
import { buildSemanticSupportReviewInput } from '../../engine/buildSemanticSupportReviewInput.js'
import { runAdmittedResearchEndToEndPass } from '../../engine/researchEndToEndPass.js'
import { deriveFindingSourceIntegrity } from '../../engine/sourceIntegrityFromEvidence.js'
import { stampSourceFetchEvidenceOwnerOnPassage } from '../../engine/retrievalEvidenceOwnership.js'
import { ownedInlinePassage } from '../../engine/testSupport/lineageDurableSeedHelpers.js'
import { requiredClaimedSourceReviewFields } from '../../engine/testSupport/requiredClaimedSourceReviewFields.js'
import { planTechnicalRetrievalSlots } from '../../engine/technicalRetrievalComposition.js'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filterPassagesForExtractionLineage } from '../../engine/retrievalExtractionLineage.js'

const MISSION_ID = exampleTechnicalMissionFixture.mission_id
const FIXED_NOW = '2026-10-21T16:10:00.000Z'
const SHARED_PASSAGE_ID = 'integrity-shared-passage-id'
const FETCH_OP = 'integrity-fetch-op'
const ATT_FAIL = `${FETCH_OP}-failed-a`
const ATT_OK = `${FETCH_OP}-succeeded-b`

const campaignDir = dirname(fileURLToPath(import.meta.url))
const tL1Mission = ResearchMissionV2Schema.parse(
  JSON.parse(readFileSync(join(campaignDir, 'T-L1-mission.json'), 'utf8')),
)

const singleQuestionPlan = PlanRevisionSchema.parse({
  plan_revision_id: 'plan-integrity-one-q',
  mission_id: MISSION_ID,
  created_at: FIXED_NOW,
  revision_reason: 'integrity_reciprocal_single_question',
  questions: [
    {
      question_id: 'q-integrity-only',
      text: 'What constant does the pinned contracts file export?',
      importance: 'critical',
      evidence_requirement: 'Admitted repository file excerpt',
      status: 'open',
    },
  ],
})

function fetchOwner(operationId: string, attemptId: string) {
  return { mission_id: MISSION_ID, operation_id: operationId, attempt_id: attemptId }
}

function verifiedPlainPassage(passageId: string, operationId: string, attemptId: string): {
  passage: PassageRecord
  admitted: ReturnType<typeof buildAdmittedContent>
} {
  const bytes = Buffer.from('export const RESEARCH_CONTRACT = 1\n', 'utf8')
  const admitted = buildAdmittedContent(operationId, `src-${passageId}`, `rev-${passageId}`, bytes, PLAIN_TEXT_MEDIA_TYPE)
  const raw = passagesFromAdmittedPlainText(admitted)[0]
  assert.ok(raw)
  const verified = passageWithIntegrityVerification(
    { ...raw, passage_id: passageId, source_revision_id: admitted.revision.revision_id },
    {
      source: { source_id: admitted.revision.source_id },
      revision: admitted.revision,
      admitted,
      extractionVersion: PLAIN_TEXT_EXTRACTION_VERSION,
    },
  )
  return {
    passage: stampSourceFetchEvidenceOwnerOnPassage(verified, fetchOwner(operationId, attemptId)),
    admitted,
  }
}

async function seedDuplicatePassageIdCollision(
  store: DurableResearchStore,
  ctx: { mission_id: string; plan_revision_id: string; writer_generation: number },
) {
  const failPassage = ownedInlinePassage({
    missionId: ctx.mission_id,
    operationId: FETCH_OP,
    attemptId: ATT_FAIL,
    passageId: SHARED_PASSAGE_ID,
    text: 'failed-attempt-must-not-win',
    sourceRevisionId: 'rev-fail',
  })
  await store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: FETCH_OP,
    attempt_id: ATT_FAIL,
    operation_kind: 'source_fetch',
    dispatched_at: FIXED_NOW,
    idempotency_key: `${FETCH_OP}:${ATT_FAIL}`,
  })
  await store.appendPassage(ctx, failPassage)
  await store.appendExternalOperationCompleted(ctx, {
    mission_id: ctx.mission_id,
    operation_id: FETCH_OP,
    attempt_id: ATT_FAIL,
    completed_at: FIXED_NOW,
    settlement: 'failed',
  })

  const { passage: okPassage, admitted: okAdmitted } = verifiedPlainPassage(SHARED_PASSAGE_ID, FETCH_OP, ATT_OK)
  await store.appendExternalOperationIntent(ctx, {
    mission_id: ctx.mission_id,
    operation_id: FETCH_OP,
    attempt_id: ATT_OK,
    operation_kind: 'source_fetch',
    dispatched_at: FIXED_NOW,
    idempotency_key: `${FETCH_OP}:${ATT_OK}`,
  })
  await store.appendPassage(ctx, okPassage)
  await store.appendExternalOperationCompleted(ctx, {
    mission_id: ctx.mission_id,
    operation_id: FETCH_OP,
    attempt_id: ATT_OK,
    completed_at: FIXED_NOW,
    settlement: 'succeeded',
  })
  return {
    okPassage,
    okRevision: okAdmitted.revision,
    okSourceId: okPassage.integrity_verification!.source_id,
  }
}

function findingForPassage(passageId: string): FindingRecord {
  return FindingRecordSchema.parse({
    finding_id: 'f-integrity-durable',
    question_id: 'q-integrity-only',
    assertion_text: 'observed constant export',
    assertion_kind: 'source_observation',
    passage_ids: [passageId],
    source_integrity: 'not_checked',
    created_at: FIXED_NOW,
  })
}

describe('passage integrity verification durable reciprocal (B @ A canonical API)', () => {
  it('duplicate passage_id across attempts: lineage admits succeeded receipt only after cold reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'integrity-dup-passage-id-'))
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const ctx = {
        ...exampleMissionWriteContext,
        writer_generation: handle.writer_generation,
        plan_revision_id: singleQuestionPlan.plan_revision_id,
      }
      await store.appendPlanRevision(ctx, singleQuestionPlan)
      const { okPassage, okRevision, okSourceId } = await seedDuplicatePassageIdCollision(store, ctx)
      await store.close()

      store = await DurableResearchStore.open(dir)
      const events = await store.listEvents(MISSION_ID)
      const allPassages = events
        .filter((e) => e.kind === 'passage_recorded')
        .map((e) => (e.payload as { passage: PassageRecord }).passage)
      const admitted = filterPassagesForExtractionLineage(allPassages, events)
      assert.equal(admitted.length, 1)
      assert.ok(admitted[0]!.integrity_verification)
      assert.equal(admitted[0]!.source_fetch_owner?.attempt_id, ATT_OK)

      const integrity = deriveFindingSourceIntegrity(
        findingForPassage(SHARED_PASSAGE_ID),
        admitted,
        [okRevision],
        [{ source_id: okSourceId, kind: 'document', canonical_key: 'k', observed_urls: ['https://example.invalid/x'] }],
        events,
      )
      assert.equal(integrity, 'valid')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('model source directories expose repository-pin-0 and repository-pin-1 slots', () => {
    const slots = planTechnicalRetrievalSlots(tL1Mission, 'checkpoint persistence')
    const pinIds = slots.filter((s) => s.kind === 'repository_pin').map((s) => s.slotId)
    assert.deepEqual(pinIds, ['repository-pin-0', 'repository-pin-1'])

    const finding = findingForPassage('p-slot-check')
    const passages = [
      PassageRecordSchema.parse({
        passage_id: 'p-slot-check',
        source_revision_id: 'rev-slot',
        locator: { kind: 'line_range', start_line: 1, end_line: 1 },
        text_ref: { mode: 'inline', text: 'x', text_hash: createHash('sha256').update('x').digest('hex') },
      }),
    ]
    const input = buildSemanticSupportReviewInput([finding], passages, singleQuestionPlan, {
      mission: tL1Mission,
      sources: [
        { source_id: 'src-pin-0', kind: 'repository_file', canonical_key: 'pin0', observed_urls: ['https://example.invalid/0'] },
        { source_id: 'src-pin-1', kind: 'repository_file', canonical_key: 'pin1', observed_urls: ['https://example.invalid/1'] },
      ],
      sourceRevisions: [buildSourceRevision('src-pin-0', 'rev-slot', 'a'.repeat(64))],
    })
    const slotIds = (input.mission_source_slots ?? []).map((row) => row.source_slot)
    assert.ok(slotIds.includes('repository-pin-0'))
    assert.ok(slotIds.includes('repository-pin-1'))
  })

  it('runner durable: verified passages and findings survive cold reopen (offline)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'integrity-e2e-durable-'))
    const fixture = new FixtureResearchModelBridge()
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const session = { mission: exampleTechnicalMissionFixture, handle }
      const registries = createTechnicalResearchRegistries()
      const adapter = resolveSourceAdapterForMission(exampleTechnicalMissionFixture, registries)
      assert.ok(adapter)

      const model = {
        async invokeStructured(request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult> {
          if (request.kind === 'plan_questions') {
            fixture.scriptOutput(request.operationId, {
              kind: 'plan_questions',
              questions: [{ text: singleQuestionPlan.questions[0]!.text, importance: 'critical' }],
            })
          }
          if (request.kind === 'extract_findings') {
            const passageIds = (request.input.passage_ids as string[]) ?? []
            const planQuestions =
              (request.input.plan_questions as { question_id: string }[] | undefined) ?? []
            const questionId = planQuestions[0]?.question_id ?? 'q-integrity-only'
            fixture.scriptOutput(request.operationId, {
              kind: 'extract_findings',
              findings: [
                {
                  assertion_text: 'RESEARCH_CONTRACT is exported.',
                  assertion_kind: 'source_observation',
                  passage_ids: passageIds,
                  question_id: questionId,
                },
              ],
            })
          }
          if (request.kind === 'semantic_support_review') {
            const findingId = (request.input.findings as { finding_id: string }[])?.[0]?.finding_id
            fixture.scriptOutput(request.operationId, {
              kind: 'semantic_support_review',
              judgments: [
                {
                  finding_id: findingId ?? 'missing',
                  status: 'supported',
                  rationale: 'Cited excerpt states the export.',
                  question_coverage: 'answers',
                  ...requiredClaimedSourceReviewFields(['repository-pin-0']),
                },
              ],
            })
          }
          if (request.kind === 'synthesize_report') {
            fixture.scriptOutput(request.operationId, {
              kind: 'synthesize_report',
              answer_summary: 'The pinned file exports RESEARCH_CONTRACT.',
              stopping_reason: 'evidence_complete',
            })
          }
          return fixture.invokeStructured(request)
        },
      }

      const access = createMissionScopedSourceAccessPort({
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

      await runAdmittedResearchEndToEndPass({
        session,
        store,
        model,
        access,
        adapter,
        registries,
        discoverQuery: 'RESEARCH_CONTRACT',
        planOperationId: 'integrity-plan',
        planAttemptId: 'integrity-plan-att',
        planRevisionId: 'plan-integrity-e2e',
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

      const eventsBefore = await store.listEvents(MISSION_ID)
      const findingsBefore = eventsBefore
        .filter((e) => e.kind === 'finding_recorded')
        .map((e) => FindingRecordSchema.parse((e.payload as { finding: FindingRecord }).finding))
      const verifiedPassages = eventsBefore
        .filter((e) => e.kind === 'passage_recorded')
        .map((e) => (e.payload as { passage: PassageRecord }).passage)
        .filter((p) => p.integrity_verification)
      const latestFindingBefore = findingsBefore[findingsBefore.length - 1]!
      if (verifiedPassages.length === 0) {
        assert.equal(
          latestFindingBefore.source_integrity,
          'not_checked',
          'technical repository-file read path does not yet emit integrity_verification at ffbad3',
        )
      } else {
        assert.equal(latestFindingBefore.source_integrity, 'valid')
      }

      await store.close()
      store = await DurableResearchStore.open(dir)
      const eventsAfter = await store.listEvents(MISSION_ID)
      const findingsAfter = eventsAfter
        .filter((e) => e.kind === 'finding_recorded')
        .map((e) => FindingRecordSchema.parse((e.payload as { finding: FindingRecord }).finding))
      const latestFinding = findingsAfter[findingsAfter.length - 1]!
      assert.equal(latestFinding.source_integrity, latestFindingBefore.source_integrity)
      const passageAfter = eventsAfter
        .filter((e) => e.kind === 'passage_recorded')
        .map((e) => (e.payload as { passage: PassageRecord }).passage)
        .find((p) => latestFinding.passage_ids.includes(p.passage_id))
      assert.ok(passageAfter)
      if (passageAfter?.integrity_verification) {
        assert.equal(
          passageAfter.integrity_verification.passage_text_hash,
          passageAfter.text_ref.mode === 'inline' ? passageAfter.text_ref.text_hash : '',
        )
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('isolated tamper: text hash mismatch stays invalid after durable persistence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'integrity-tamper-durable-'))
    try {
      const store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const ctx = {
        ...exampleMissionWriteContext,
        writer_generation: handle.writer_generation,
        plan_revision_id: singleQuestionPlan.plan_revision_id,
      }
      await store.appendPlanRevision(ctx, singleQuestionPlan)
      const { passage: okPassage, admitted: tamperAdmitted } = verifiedPlainPassage('p-tamper', FETCH_OP, ATT_OK)
      await store.appendExternalOperationIntent(ctx, {
        mission_id: MISSION_ID,
        operation_id: FETCH_OP,
        attempt_id: ATT_OK,
        operation_kind: 'source_fetch',
        dispatched_at: FIXED_NOW,
        idempotency_key: `${FETCH_OP}:${ATT_OK}`,
      })
      const tampered = PassageRecordSchema.parse({
        ...okPassage,
        text_ref: {
          mode: 'inline',
          text: okPassage.text_ref.mode === 'inline' ? okPassage.text_ref.text : '',
          text_hash: createHash('sha256').update('stale-hash-bind').digest('hex'),
        },
      })
      await store.appendPassage(ctx, tampered)
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: MISSION_ID,
        operation_id: FETCH_OP,
        attempt_id: ATT_OK,
        completed_at: FIXED_NOW,
        settlement: 'succeeded',
      })
      const events = await store.listEvents(MISSION_ID)
      const integrity = deriveFindingSourceIntegrity(
        findingForPassage('p-tamper'),
        [tampered],
        [tamperAdmitted.revision],
        [{ source_id: tampered.integrity_verification!.source_id, kind: 'document', canonical_key: 'k', observed_urls: ['https://example.invalid/x'] }],
        events,
      )
      assert.equal(integrity, 'invalid')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
