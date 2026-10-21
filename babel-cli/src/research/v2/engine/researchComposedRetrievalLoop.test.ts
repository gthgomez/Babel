import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { DEFAULT_MAX_ADMITTED_BYTES } from '../access/fetchSourceAccessPort.js'
import { createGovernedSourceAccessPort } from '../access/governedSourceAccessPort.js'
import { createMissionProductionSearchProvider } from '../access/createMissionProductionSearchProvider.js'
import { ResearchMissionV2Schema } from '../contracts/mission.js'
import { examplePlanRevisionFixture } from '../fixtures/exampleMission.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import { createCombinedResearchRegistries } from '../registry/reviewedBAdapterIntegration.js'
import { resolveDiscoveryAdapterForMission } from '../registry/missionAdapterResolution.js'
import { TechnicalRepositoryFileAdapter } from '../profiles/technical/repositoryFileAdapter.js'
import { runAdmittedComposedRetrievalIteration } from './researchComposedRetrievalLoop.js'
import { planTechnicalRetrievalSlots } from './technicalRetrievalComposition.js'
import pins from '../fixtures/campaign/T-L1-T-L2-PINNED-VERSIONS.json' with { type: 'json' }

const FIXED_NOW = '2026-10-21T08:15:00.000Z'
const campaignDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/campaign')

function loadMission(name: string) {
  return ResearchMissionV2Schema.parse(
    JSON.parse(readFileSync(join(campaignDir, name), 'utf8')),
  )
}

describe('research composed retrieval (code + paper + evidenced unsupported)', () => {
  it('T-L2 mission plans repository, document, and unsupported structured slots', () => {
    const mission = loadMission('T-L2-mission.json')
    const slots = planTechnicalRetrievalSlots(mission, 'persistence')
    const kinds = slots.map((s) => s.kind)
    assert.ok(kinds.includes('repository_pin'))
    assert.ok(kinds.includes('document_ref'))
    assert.ok(kinds.includes('unsupported_source_class'))
    assert.equal(slots.filter((s) => s.kind === 'unsupported_source_class').length, 1)
  })

  it('arXiv paper content-length exceeds default admitted byte cap (host truncation expected at fetch)', () => {
    const length = pins.t_l2_paper.observed_content_length_bytes
    assert.ok(length > DEFAULT_MAX_ADMITTED_BYTES)
    assert.ok(length < 10_000_000)
  })

  it('persists repo + PDF passages with distinct operation IDs while structured slot stays unsupported', async () => {
    const mission = loadMission('T-L2-mission.json')
    const registries = await createCombinedResearchRegistries()
    const discovery = resolveDiscoveryAdapterForMission(mission, registries)
    assert.ok(discovery instanceof TechnicalRepositoryFileAdapter)

    const pdfFixture = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../adapters/documents/fixtures/two-page-sample.pdf'),
    )
    const largePdfBody = Buffer.concat([
      pdfFixture,
      Buffer.alloc(250_000, 0x20),
    ])
    assert.ok(largePdfBody.length > DEFAULT_MAX_ADMITTED_BYTES)

    const repoPath = 'babel-cli/src/research/v2/persistence/README.md'
    const repoBody = Buffer.from('# durable store\n', 'utf8')
    const repoBlobUrl = `https://github.com/${mission.pinned_target_repository!.full_name}/blob/${mission.pinned_target_repository!.commit_sha}/${repoPath}`
    const repoRawUrl = repoBlobUrl.replace(
      'https://github.com/',
      'https://raw.githubusercontent.com/',
    ).replace('/blob/', '/')

    const searchProvider = createMissionProductionSearchProvider({
      mission,
      fetchRepositoryTree: async () => ({
        ok: true,
        status: 200,
        entries: [{ path: repoPath, type: 'blob' }],
      }),
    })

    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider,
      maxAdmittedBytes: DEFAULT_MAX_ADMITTED_BYTES,
      admittedGet: async ({ url }) => {
        if (url === repoRawUrl || url.includes(repoPath)) {
          return {
            ok: true,
            status: 200,
            contentType: 'text/plain',
            buffer: repoBody,
            bytesReceived: repoBody.length,
            truncated: false,
            requestedUrl: repoBlobUrl,
            finalUrl: repoRawUrl,
            redirectChain: [repoBlobUrl, repoRawUrl],
            transportCoding: null,
          }
        }
        if (url === pins.t_l2_paper.canonical_url) {
          return {
            ok: true,
            status: 200,
            contentType: 'application/pdf',
            buffer: largePdfBody.subarray(0, DEFAULT_MAX_ADMITTED_BYTES),
            bytesReceived: DEFAULT_MAX_ADMITTED_BYTES,
            truncated: true,
            requestedUrl: url,
            finalUrl: url,
            redirectChain: [url],
            transportCoding: null,
          }
        }
        return {
          ok: false,
          status: 404,
          contentType: 'application/octet-stream',
          buffer: Buffer.alloc(0),
          bytesReceived: 0,
          truncated: false,
          requestedUrl: url,
          finalUrl: url,
          redirectChain: [url],
          transportCoding: null,
        }
      },
    })

    const store = new InMemoryResearchStore()
    const handle = await store.appendMission(mission)
    await store.appendPlanRevision(
      {
        mission_id: handle.mission_id,
        plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
        writer_generation: handle.writer_generation,
      },
      { ...examplePlanRevisionFixture, mission_id: mission.mission_id },
    )

    const result = await runAdmittedComposedRetrievalIteration({
      session: {
        mission,
        handle,
        activePlanRevisionId: examplePlanRevisionFixture.plan_revision_id,
      },
      store,
      access,
      adapter: discovery,
      registries,
      activePlan: { ...examplePlanRevisionFixture, mission_id: mission.mission_id },
      discoverQuery: 'persistence README',
      searchOperationId: 'composed-search-root',
      searchAttemptId: 'composed-search-att',
      fetchOperationId: 'composed-fetch-root',
      fetchAttemptId: 'composed-fetch-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })

    assert.ok(result.passageIds.length >= 1)
    assert.ok(result.limitations.some((l) => l.startsWith('retrieval_slot_unsupported:')))
    const searchIds = result.slotOutcomes.map((o) => o.searchOperationId)
    assert.equal(new Set(searchIds).size, searchIds.length)
    assert.ok(searchIds.every((id) => id.startsWith('composed-search-root--')))

    const structuredOutcome = result.slotOutcomes.find((o) => o.slotId.includes('unsupported'))
    assert.equal(structuredOutcome?.settlement, 'skipped_unsupported')
    const repoOutcome = result.slotOutcomes.find((o) => o.kind === 'repository_pin')
    assert.equal(repoOutcome?.settlement, 'succeeded')
    const docOutcome = result.slotOutcomes.find((o) => o.kind === 'document_ref')
    assert.equal(docOutcome?.settlement, 'failed')

    const events = await store.listEvents(mission.mission_id)
    const structuredCompletion = events.find(
      (e) =>
        e.kind === 'external_operation_completed' &&
        (e.payload.completion as { operation_id?: string }).operation_id ===
          structuredOutcome?.searchOperationId,
    )
    assert.equal(
      (structuredCompletion?.payload.completion as { failure_category?: string }).failure_category,
      'not_supported',
    )
  })
})
