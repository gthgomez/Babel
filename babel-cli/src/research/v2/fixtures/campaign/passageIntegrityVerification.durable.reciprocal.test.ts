/**
 * B-owned durable reciprocals on A canonical PassageRecord.integrity_verification.
 * Agent A ffbad3 already wired technical repository receipt emission; B’s earlier selective
 * file-level union omitted that production slice (restored from A ef9655cf, not fe52 replay).
 * Real DurableResearchStore; stub network/model only. Historical G-L2/G-L3 bytes unchanged elsewhere.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { createGovernedSourceAccessPort } from '../../access/governedSourceAccessPort.js'
import { createMissionProductionSearchProvider } from '../../access/createMissionProductionSearchProvider.js'
import type { GitHubTreeEntry } from '../../access/pinnedRepositoryFileSearchProvider.js'
import { createMissionScopedSourceAccessPort } from '../../access/missionScopedSourceAccessPort.js'
import { FindingRecordSchema } from '../../contracts/findings.js'
import type { FindingRecord } from '../../contracts/findings.js'
import { PlanRevisionSchema } from '../../contracts/plan.js'
import type { PassageRecord } from '../../contracts/passages.js'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'
import type { SourceRecord, SourceRevision } from '../../contracts/sources.js'
import {
  exampleMissionWriteContext,
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../../fixtures/exampleMission.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
} from '../../fixtures/technicalRepositoryCorpus.js'
import { searchIndexForTechnicalMission } from '../../fixtures/technicalSearchIndex.js'
import { passageWithIntegrityVerification } from '../../integrity/passageIntegrityReceipt.js'
import { FixtureResearchModelBridge } from '../../model/fixtureModelBridge.js'
import type {
  ResearchModelInvocationRequest,
  ResearchModelInvocationResult,
  ResearchModelPort,
} from '../../ports/researchModelPort.js'
import { DurableResearchStore } from '../../persistence/durableResearchStore.js'
import { createTechnicalResearchRegistries, resolveSourceAdapterForMission } from '../../registry/frozenRegistries.js'
import { createCombinedResearchRegistries } from '../../registry/reviewedBAdapterIntegration.js'
import { resolveDiscoveryAdapterForMission } from '../../registry/missionAdapterResolution.js'
import { PLAIN_TEXT_EXTRACTION_VERSION, PLAIN_TEXT_MEDIA_TYPE, passagesFromAdmittedPlainText } from '../../adapters/documents/plainTextFromAdmittedBytes.js'
import { buildAdmittedContent } from '../../adapters/documents/testAdmittedFixtures.js'
import { buildSemanticSupportReviewInput } from '../../engine/buildSemanticSupportReviewInput.js'
import { listSourceRevisionsFromStoreEvents, listSourcesFromStoreEvents } from '../../engine/listSourceRevisionsFromStoreEvents.js'
import { runAdmittedResearchEndToEndPass } from '../../engine/researchEndToEndPass.js'
import { runAdmittedComposedRetrievalIteration } from '../../engine/researchComposedRetrievalLoop.js'
import { deriveFindingSourceIntegrity, applyFindingSourceIntegrityFromEvidence } from '../../engine/sourceIntegrityFromEvidence.js'
import {
  stampSourceFetchEvidenceOwnerOnPassage,
  stampSourceFetchEvidenceOwnerOnRevision,
} from '../../engine/retrievalEvidenceOwnership.js'
import { requiredClaimedSourceReviewFields } from '../../engine/testSupport/requiredClaimedSourceReviewFields.js'
import { deriveVerifiedEvidenceLimitations } from '../../engine/researchReportFinalization.js'
const MISSION_ID = exampleTechnicalMissionFixture.mission_id
const FIXED_NOW = '2026-10-21T16:30:00.000Z'
const campaignDir = dirname(fileURLToPath(import.meta.url))

const SHARED_PASSAGE_ID = 'integrity-shared-passage-id'
const SHARED_REVISION_ID = 'rev-shared-integrity'
const FETCH_OK = 'integrity-fetch-ok'
const ATT_OK = 'integrity-att-ok'
const FETCH_FAIL = 'integrity-fetch-fail'
const ATT_FAIL = 'integrity-att-fail'

const singleQuestionPlan = PlanRevisionSchema.parse({
  plan_revision_id: 'plan-integrity-e2e',
  mission_id: MISSION_ID,
  created_at: FIXED_NOW,
  revision_reason: 'integrity_reciprocal_single_question',
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

function fetchOwner(operationId: string, attemptId: string) {
  return { mission_id: MISSION_ID, operation_id: operationId, attempt_id: attemptId }
}

function verifiedRepositoryPassage(params: {
  passageId: string
  revisionId: string
  sourceId: string
  operationId: string
  attemptId: string
  lineText: string
}): { passage: PassageRecord; revision: SourceRevision; source: SourceRecord } {
  const bytes = Buffer.from(params.lineText, 'utf8')
  const admitted = buildAdmittedContent(
    params.operationId,
    params.sourceId,
    params.revisionId,
    bytes,
    PLAIN_TEXT_MEDIA_TYPE,
  )
  const raw = passagesFromAdmittedPlainText(admitted)[0]
  assert.ok(raw)
  const owner = fetchOwner(params.operationId, params.attemptId)
  const revision = stampSourceFetchEvidenceOwnerOnRevision(admitted.revision, owner)
  const verified = passageWithIntegrityVerification(
    {
      ...raw,
      passage_id: params.passageId,
      source_revision_id: params.revisionId,
    },
    {
      source: { source_id: params.sourceId },
      revision: admitted.revision,
      admitted,
      extractionVersion: PLAIN_TEXT_EXTRACTION_VERSION,
    },
  )
  const passage = stampSourceFetchEvidenceOwnerOnPassage(verified, owner)
  const source: SourceRecord = {
    source_id: params.sourceId,
    kind: 'repository_file',
    canonical_key: `github:test/${params.sourceId}`,
    observed_urls: ['https://example.invalid/repo/file'],
    coverage_source_slot: 'repository-pin-0',
  }
  return { passage, revision, source }
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

function governedTechnicalAccess() {
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
      if (request.kind === 'plan_questions') {
        return fixture.invokeStructured(request)
      }
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

function treeFromPaths(paths: string[]): GitHubTreeEntry[] {
  return paths.map((path) => ({ path, type: 'blob' }))
}

function assertTerminalComplete(events: Awaited<ReturnType<DurableResearchStore['listEvents']>>): void {
  const terminal = events.find((e) => e.kind === 'terminal_receipt')
  const report = (
    terminal?.payload as {
      report: {
        terminal_state: string
        limitations?: string[]
      }
    }
  ).report
  assert.ok(report)
  assert.ok(
    !report.limitations?.some((l) => l.startsWith('finding_source_integrity_not_verified:')),
  )
  assert.equal(report.terminal_state, 'complete', JSON.stringify(report))
}

describe('passage integrity verification durable reciprocal (B @ A canonical API)', () => {
  it('composed T-L1 retrieval persists repository-pin-0/1 sources (not discover-primary)', async () => {
    const mission = ResearchMissionV2Schema.parse(
      JSON.parse(readFileSync(join(campaignDir, 'T-L1-mission.json'), 'utf8')),
    )
    const babelPath = 'babel-cli/src/research/v2/persistence/durableResearchStore.ts'
    const langPath = 'libs/langgraph/langgraph/pregel/_checkpoint.py'
    const globalUnused = 'compare pinned repositories persistence execution policy'

    const baseSearch = createMissionProductionSearchProvider({
      mission,
      fetchRepositoryTree: async ({ apiUrl }) => {
        if (apiUrl.includes('gthgomez/Babel')) {
          return { ok: true, status: 200, entries: treeFromPaths([babelPath]) }
        }
        if (apiUrl.includes('langchain-ai/langgraph')) {
          return { ok: true, status: 200, entries: treeFromPaths([langPath]) }
        }
        return { ok: false, status: 404, entries: [], message: `unexpected tree ${apiUrl}` }
      },
    })

    const babelRaw = `https://raw.githubusercontent.com/${mission.pinned_target_repository!.full_name}/${mission.pinned_target_repository!.commit_sha}/${babelPath}`
    const langRaw = `https://raw.githubusercontent.com/${mission.source_policy.selected_repository_refs![0]!.full_name}/${mission.source_policy.selected_repository_refs![0]!.commit_sha}/${langPath}`

    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider: baseSearch,
      admittedGet: async ({ url }: { url: string }) => {
        const body =
          url === babelRaw || url.includes(babelPath)
            ? Buffer.from('export const durable = 1\n', 'utf8')
            : url === langRaw || url.includes(langPath)
              ? Buffer.from('# pregel checkpoint module\n', 'utf8')
              : null
        if (!body) {
          return {
            ok: false,
            status: 404,
            contentType: 'text/plain',
            buffer: Buffer.alloc(0),
            bytesReceived: 0,
            truncated: false,
            requestedUrl: url,
            finalUrl: url,
            redirectChain: [url],
            transportCoding: null,
          }
        }
        return {
          ok: true,
          status: 200,
          contentType: 'text/plain',
          buffer: body,
          bytesReceived: body.length,
          truncated: false,
          requestedUrl: url,
          finalUrl: url,
          redirectChain: [url],
          transportCoding: null,
        }
      },
    })

    const registries = await createCombinedResearchRegistries()
    const discovery = resolveDiscoveryAdapterForMission(mission, registries)
    assert.ok(discovery)

    const dir = await mkdtemp(join(tmpdir(), 'integrity-tl1-composed-slots-'))
    try {
      const store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(mission)
      const plan = { ...examplePlanRevisionFixture, mission_id: mission.mission_id }
      await store.appendPlanRevision(
        {
          mission_id: mission.mission_id,
          plan_revision_id: plan.plan_revision_id,
          writer_generation: handle.writer_generation,
        },
        plan,
      )

      await runAdmittedComposedRetrievalIteration({
        session: {
          mission,
          handle,
          activePlanRevisionId: plan.plan_revision_id,
        },
        store,
        access,
        adapter: discovery,
        registries,
        activePlan: plan,
        discoverQuery: globalUnused,
        searchOperationId: 'integrity-tl1-search',
        searchAttemptId: 'integrity-tl1-search-att',
        fetchOperationId: 'integrity-tl1-fetch',
        fetchAttemptId: 'integrity-tl1-fetch-att',
        dispatchedAt: FIXED_NOW,
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      })

      const events = await store.listEvents(mission.mission_id)
      const sources = listSourcesFromStoreEvents(events)
      const slots = sources.map((s) => s.coverage_source_slot).filter(Boolean)
      assert.deepEqual([...new Set(slots)].sort(), ['repository-pin-0', 'repository-pin-1'])
      assert.ok(!slots.includes('discover-primary'))

      const revisions = listSourceRevisionsFromStoreEvents(events)
      const passages = events
        .filter((e) => e.kind === 'passage_recorded')
        .map((e) => (e.payload as { passage: PassageRecord }).passage)
      assert.ok(passages.length >= 2)

      const reviewInput = buildSemanticSupportReviewInput(
        [
          FindingRecordSchema.parse({
            finding_id: 'f-slot-bind',
            question_id: plan.questions[0]!.question_id,
            assertion_text: 'synthetic',
            assertion_kind: 'source_observation',
            passage_ids: [passages[0]!.passage_id],
            source_integrity: 'not_checked',
            created_at: FIXED_NOW,
          }),
        ],
        passages,
        plan,
        { mission, sources, sourceRevisions: revisions },
      )
      const directorySlots = (reviewInput.mission_source_slots ?? []).map((r) => r.source_slot)
      assert.ok(directorySlots.includes('repository-pin-0'))
      assert.ok(directorySlots.includes('repository-pin-1'))
      const cited = reviewInput.findings[0]?.cited_passages[0]?.source_attribution?.coverage_source_slot
      assert.ok(cited === 'repository-pin-0' || cited === 'repository-pin-1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists succeeded A then failed B reusing revision/passage ids; A owner-bound evidence stays valid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'integrity-a-then-b-dup-'))
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const ctx = {
        ...exampleMissionWriteContext,
        writer_generation: handle.writer_generation,
        plan_revision_id: singleQuestionPlan.plan_revision_id,
      }
      await store.appendPlanRevision(ctx, singleQuestionPlan)

      const sourceId = 'src-shared-integrity'
      const a = verifiedRepositoryPassage({
        passageId: SHARED_PASSAGE_ID,
        revisionId: SHARED_REVISION_ID,
        sourceId,
        operationId: FETCH_OK,
        attemptId: ATT_OK,
        lineText: 'export const RESEARCH_CONTRACT = 1\n',
      })

      await store.appendExternalOperationIntent(ctx, {
        mission_id: MISSION_ID,
        operation_id: FETCH_OK,
        attempt_id: ATT_OK,
        operation_kind: 'source_fetch',
        dispatched_at: FIXED_NOW,
        idempotency_key: `${FETCH_OK}:${ATT_OK}`,
      })
      await store.appendSource(ctx, a.source)
      await store.appendSourceRevision(ctx, a.revision)
      await store.appendPassage(ctx, a.passage)
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: MISSION_ID,
        operation_id: FETCH_OK,
        attempt_id: ATT_OK,
        completed_at: FIXED_NOW,
        settlement: 'succeeded',
      })

      const failOwner = fetchOwner(FETCH_FAIL, ATT_FAIL)
      const failedRevision = stampSourceFetchEvidenceOwnerOnRevision(
        { ...a.revision, content_hash: 'f'.repeat(64) },
        failOwner,
      )
      await store.appendExternalOperationIntent(ctx, {
        mission_id: MISSION_ID,
        operation_id: FETCH_FAIL,
        attempt_id: ATT_FAIL,
        operation_kind: 'source_fetch',
        dispatched_at: FIXED_NOW,
        idempotency_key: `${FETCH_FAIL}:${ATT_FAIL}`,
      })
      await store.appendSourceRevision(ctx, failedRevision)
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: MISSION_ID,
        operation_id: FETCH_FAIL,
        attempt_id: ATT_FAIL,
        completed_at: FIXED_NOW,
        settlement: 'failed',
      })

      await store.close()
      store = await DurableResearchStore.open(dir)
      const events = await store.listEvents(MISSION_ID)
      const revisions = listSourceRevisionsFromStoreEvents(events)
      const sources = listSourcesFromStoreEvents(events)

      const integrity = deriveFindingSourceIntegrity(
        FindingRecordSchema.parse({
          finding_id: 'f-dup-ab',
          question_id: 'q-integrity-1',
          assertion_text: 'export observed',
          assertion_kind: 'source_observation',
          passage_ids: [SHARED_PASSAGE_ID],
          source_integrity: 'not_checked',
          created_at: FIXED_NOW,
        }),
        [a.passage],
        revisions,
        sources,
        events,
      )
      assert.equal(integrity, 'valid')

      const failPassageOwner = fetchOwner(FETCH_FAIL, `${ATT_FAIL}-passage`)
      await store.appendExternalOperationIntent(ctx, {
        mission_id: MISSION_ID,
        operation_id: FETCH_FAIL,
        attempt_id: `${ATT_FAIL}-passage`,
        operation_kind: 'source_fetch',
        dispatched_at: FIXED_NOW,
        idempotency_key: `${FETCH_FAIL}:${ATT_FAIL}-passage`,
      })
      await store.appendPassage(
        ctx,
        stampSourceFetchEvidenceOwnerOnPassage(
          PassageRecordSchema.parse({
            ...a.passage,
            text_ref: {
              mode: 'inline',
              text: 'failed-attempt-passage-row',
              text_hash: createHash('sha256').update('failed-attempt-passage-row', 'utf8').digest('hex'),
            },
          }),
          failPassageOwner,
        ),
      )
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: MISSION_ID,
        operation_id: FETCH_FAIL,
        attempt_id: `${ATT_FAIL}-passage`,
        completed_at: FIXED_NOW,
        settlement: 'failed',
      })
      const eventsWithFailedPassageRow = await store.listEvents(MISSION_ID)
      const withFailedRow = deriveFindingSourceIntegrity(
        FindingRecordSchema.parse({
          finding_id: 'f-dup-failed-row',
          question_id: 'q-integrity-1',
          assertion_text: 'export observed',
          assertion_kind: 'source_observation',
          passage_ids: [SHARED_PASSAGE_ID],
          source_integrity: 'not_checked',
          created_at: FIXED_NOW,
        }),
        [a.passage],
        revisions,
        sources,
        eventsWithFailedPassageRow,
      )
      assert.equal(
        withFailedRow,
        'valid',
        'failed duplicate B passage row must be excluded; succeeded A owner-bound evidence stays valid',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('true ambiguity: two succeeded owners with materially different passage_id records → not_checked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'integrity-true-ambiguity-'))
    try {
      const store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const ctx = {
        ...exampleMissionWriteContext,
        writer_generation: handle.writer_generation,
        plan_revision_id: singleQuestionPlan.plan_revision_id,
      }
      await store.appendPlanRevision(ctx, singleQuestionPlan)

      const a = verifiedRepositoryPassage({
        passageId: SHARED_PASSAGE_ID,
        revisionId: 'rev-amb-a',
        sourceId: 'src-amb-a',
        operationId: 'fetch-amb-a',
        attemptId: 'att-amb-a',
        lineText: 'owner-a excerpt\n',
      })
      await store.appendExternalOperationIntent(ctx, {
        mission_id: MISSION_ID,
        operation_id: 'fetch-amb-a',
        attempt_id: 'att-amb-a',
        operation_kind: 'source_fetch',
        dispatched_at: FIXED_NOW,
        idempotency_key: 'fetch-amb-a:att-amb-a',
      })
      await store.appendSource(ctx, a.source)
      await store.appendSourceRevision(ctx, a.revision)
      await store.appendPassage(ctx, a.passage)
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: MISSION_ID,
        operation_id: 'fetch-amb-a',
        attempt_id: 'att-amb-a',
        completed_at: FIXED_NOW,
        settlement: 'succeeded',
      })

      const b = verifiedRepositoryPassage({
        passageId: SHARED_PASSAGE_ID,
        revisionId: 'rev-amb-b',
        sourceId: 'src-amb-b',
        operationId: 'fetch-amb-b',
        attemptId: 'att-amb-b',
        lineText: 'owner-b materially different excerpt\n',
      })
      await store.appendExternalOperationIntent(ctx, {
        mission_id: MISSION_ID,
        operation_id: 'fetch-amb-b',
        attempt_id: 'att-amb-b',
        operation_kind: 'source_fetch',
        dispatched_at: FIXED_NOW,
        idempotency_key: 'fetch-amb-b:att-amb-b',
      })
      await store.appendSource(ctx, b.source)
      await store.appendSourceRevision(ctx, b.revision)
      await store.appendPassage(ctx, b.passage)
      await store.appendExternalOperationCompleted(ctx, {
        mission_id: MISSION_ID,
        operation_id: 'fetch-amb-b',
        attempt_id: 'att-amb-b',
        completed_at: FIXED_NOW,
        settlement: 'succeeded',
      })

      const events = await store.listEvents(MISSION_ID)
      const result = deriveFindingSourceIntegrity(
        FindingRecordSchema.parse({
          finding_id: 'f-true-ambiguity',
          question_id: 'q-integrity-1',
          assertion_text: 'ambiguous',
          assertion_kind: 'source_observation',
          passage_ids: [SHARED_PASSAGE_ID],
          source_integrity: 'not_checked',
          created_at: FIXED_NOW,
        }),
        [a.passage, b.passage],
        listSourceRevisionsFromStoreEvents(events),
        listSourcesFromStoreEvents(events),
        events,
      )
      assert.equal(result, 'not_checked')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runner: verified receipts, valid findings, supported/answers, terminal complete; cold persistence reopen preserves state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'integrity-runner-complete-reopen-'))
    try {
      let store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(exampleTechnicalMissionFixture)
      const session = { mission: exampleTechnicalMissionFixture, handle }
      const registries = createTechnicalResearchRegistries()
      const adapter = resolveSourceAdapterForMission(exampleTechnicalMissionFixture, registries)
      assert.ok(adapter)

      await runAdmittedResearchEndToEndPass({
        session,
        store,
        model: completePathFixtureModel(),
        access: governedTechnicalAccess(),
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

      let events = await store.listEvents(MISSION_ID)
      const passages = events
        .filter((e) => e.kind === 'passage_recorded')
        .map((e) => (e.payload as { passage: PassageRecord }).passage)
      const verified = passages.filter((p) => p.integrity_verification)
      assert.ok(verified.length > 0, 'adapter must emit integrity_verification receipts on admitted passages')

      const findings = latestFindings(events)
      assert.ok(findings.length > 0)
      assert.ok(findings.every((f) => f.source_integrity === 'valid'))
      assert.ok(
        findings.every((f) => f.semantic_support?.status === 'supported' && f.question_coverage?.status === 'answers'),
      )
      assertTerminalComplete(events)

      await store.close()
      store = await DurableResearchStore.open(dir)
      events = await store.listEvents(MISSION_ID)
      const reopenedPassages = events
        .filter((e) => e.kind === 'passage_recorded')
        .map((e) => (e.payload as { passage: PassageRecord }).passage)
      assert.ok(reopenedPassages.some((p) => p.integrity_verification))

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
      assertTerminalComplete(events)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('helper deriveFindingSourceIntegrity rejects tamper; finalizer boundary records unverified supported findings', () => {
    const { passage, revision, source } = verifiedRepositoryPassage({
      passageId: 'p-tamper-helper',
      revisionId: 'rev-tamper',
      sourceId: 'src-tamper',
      operationId: FETCH_OK,
      attemptId: ATT_OK,
      lineText: 'line one\n',
    })
    const tampered = PassageRecordSchema.parse({
      ...passage,
      text_ref: {
        mode: 'inline',
        text: passage.text_ref.mode === 'inline' ? passage.text_ref.text : '',
        text_hash: createHash('sha256').update('stale-hash-bind').digest('hex'),
      },
    })
    const tamperEvents = [
      {
        eventId: 'intent-tamper',
        missionId: MISSION_ID,
        kind: 'external_operation_intent' as const,
        recordedAt: FIXED_NOW,
        payload: {
          intent: {
            mission_id: MISSION_ID,
            operation_id: FETCH_OK,
            attempt_id: ATT_OK,
            operation_kind: 'source_fetch',
            dispatched_at: FIXED_NOW,
            idempotency_key: `${FETCH_OK}:${ATT_OK}`,
          },
        },
      },
      {
        eventId: 'done-tamper',
        missionId: MISSION_ID,
        kind: 'external_operation_completed' as const,
        recordedAt: FIXED_NOW,
        payload: {
          completion: {
            mission_id: MISSION_ID,
            operation_id: FETCH_OK,
            attempt_id: ATT_OK,
            completed_at: FIXED_NOW,
            settlement: 'succeeded',
          },
        },
      },
    ]
    const helperResult = deriveFindingSourceIntegrity(
      FindingRecordSchema.parse({
        finding_id: 'f-tamper',
        question_id: 'q-integrity-1',
        assertion_text: 'tampered',
        assertion_kind: 'source_observation',
        passage_ids: [tampered.passage_id],
        source_integrity: 'not_checked',
        created_at: FIXED_NOW,
      }),
      [tampered],
      [revision],
      [source],
      tamperEvents,
    )
    assert.equal(helperResult, 'invalid')

    const supportedTamperedFinding = FindingRecordSchema.parse({
      finding_id: 'f-finalizer-boundary',
      question_id: 'q-integrity-1',
      assertion_text: 'supported but integrity invalid',
      assertion_kind: 'source_observation',
      passage_ids: [tampered.passage_id],
      source_integrity: 'invalid',
      semantic_support: {
        status: 'supported',
        rationale: 'fixture',
        reviewed_at: FIXED_NOW,
        reviewer: 'fixture',
        reviewer_version: 'fixture/1',
      },
      question_coverage: {
        status: 'answers',
        rationale: 'fixture',
        reviewed_at: FIXED_NOW,
        reviewer: 'fixture',
        reviewer_version: 'fixture/1',
      },
      created_at: FIXED_NOW,
    })
    const limitations = deriveVerifiedEvidenceLimitations({
      findings: [supportedTamperedFinding],
      passages: [tampered],
      sourceRevisions: [revision],
    })
    assert.ok(
      limitations.some((l) => l.startsWith('finding_source_integrity_not_verified:f-finalizer-boundary:invalid')),
      'finalizer/host report path refuses complete on supported finding with invalid integrity',
    )
  })
})
