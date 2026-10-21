/**
 * Production-shaped search receipt handoff: catalog factory → port → GeneralWebAdapter → store.
 * Fake transport only (no live Exa); compatible with B #404 SourceSearchProviderReceipt.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { ExternalOperationCompletion } from '../../contracts/operations.js'
import { PlanRevisionSchema } from '../../contracts/plan.js'
import {
  GeneralMissionBriefSchema,
  normalizeGeneralMissionBrief,
} from '../../contracts/normalization.js'
import type { AdmittedSourceSearchProvider } from '../../ports/admittedSourceSearchProvider.js'
import type { SourceAccessPort, SourceFetchRequest, SourceSearchRequest } from '../../ports/sourceAccessPort.js'
import type { SourceRecord } from '../../contracts/sources.js'
import { buildAdmittedContent } from '../../adapters/documents/testAdmittedFixtures.js'
import { resolveQuarantinedFixturePath } from '../../adapters/documents/quarantinePath.js'
import { GENERAL_WEB_ADAPTER_ID } from '../../adapters/web/generalWebAdapter.js'
import { createGovernedSourceAccessPort } from '../../access/governedSourceAccessPort.js'
import { DurableResearchStore } from '../../persistence/durableResearchStore.js'
import { deriveSearchProviderReportLimitations } from '../../engine/sourceDiscoverSearchReceipt.js'

const here = dirname(fileURLToPath(import.meta.url))
const devCorpusRoot = join(here, 'fixtures/dev-corpus')
const FIXED_NOW = '2026-10-21T12:30:00.000Z'

function loadMission() {
  const brief = GeneralMissionBriefSchema.parse(
    JSON.parse(readFileSync(join(devCorpusRoot, 'G-DEV-01/mission.json'), 'utf8')),
  )
  const mission = normalizeGeneralMissionBrief(brief, {
    mission_id: 'mission-search-receipt-integration',
    created_at: '2026-10-20T12:00:00.000Z',
    profile_version: '0.1.0-m0',
  })
  return {
    ...mission,
    source_policy: {
      ...mission.source_policy,
      allowed_web_domains: ['example.invalid'],
    },
  }
}

function loadPlan(missionId: string) {
  return PlanRevisionSchema.parse({
    plan_revision_id: 'plan-search-receipt-001',
    mission_id: missionId,
    created_at: '2026-10-20T12:01:00.000Z',
    revision_reason: 'integration_fixture',
    questions: [
      {
        question_id: 'q-plan',
        text: 'Which plan fits storage needs?',
        importance: 'critical',
        evidence_requirement: 'Admitted HTML excerpts',
        status: 'open',
      },
    ],
  })
}

function htmlSource(): SourceRecord {
  return {
    source_id: 'src-gdev01-plan-a',
    kind: 'web',
    canonical_key: 'https://example.invalid/plan-a',
    observed_urls: ['https://example.invalid/plan-a'],
    title: 'Nimbus Plan A',
  }
}

function searchCompletion(
  events: readonly { kind: string; payload: unknown }[],
  operationId: string,
): ExternalOperationCompletion | undefined {
  for (const event of events) {
    if (event.kind !== 'external_operation_completed') continue
    const completion = (event.payload as { completion: ExternalOperationCompletion }).completion
    if (completion.operation_id === operationId) {
      return completion
    }
  }
  return undefined
}

function createExaBilledEmptyDdgSuccessProvider(hitSource: SourceRecord): AdmittedSourceSearchProvider {
  return {
    async search(request: SourceSearchRequest) {
      if (request.signal.aborted) {
        return { operationId: request.operationId, status: 'cancelled' }
      }
      if (!request.sourceClasses.includes('web')) {
        return { operationId: request.operationId, status: 'ok', hits: [] }
      }
      return {
        operationId: request.operationId,
        status: 'ok',
        hits: [
          {
            source: hitSource,
            snippet: 'cached highlight only — not admitted until fetch',
            completeness: 'snippet',
          },
        ],
        receipt: {
          configured_provider_id: 'exa_lite',
          effective_provider_id: 'duckduckgo_html_fallback',
          degradation: {
            from_provider_id: 'exa_lite',
            to_provider_id: 'duckduckgo_html_fallback',
            reason: 'exa_zero_hits',
          },
          exa_lite: {
            requestId: 'exa-req-integration-001',
            costDollars: 0.001,
            resolvedSearchType: 'auto',
          },
        },
      }
    },
  }
}

function createExaAndDdgFailedProvider(): AdmittedSourceSearchProvider {
  return {
    async search(request: SourceSearchRequest) {
      if (!request.sourceClasses.includes('web')) {
        return { operationId: request.operationId, status: 'ok', hits: [] }
      }
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'network_error',
        message: 'configured search provider transport failed',
      }
    },
  }
}

describe('source search receipt retrieval integration (offline)', () => {
  it('carries sanitized receipt through factory adapter, durable completion, and report limitations', async () => {
    const { createCombinedResearchRegistries } = await import('../../registry/reviewedBAdapterIntegration.js')
    const { resolveDiscoveryAdapterForMission } = await import('../../registry/missionAdapterResolution.js')
    const { runAdmittedRetrievalIteration } = await import('../../engine/researchRetrievalLoop.js')

    const mission = loadMission()
    const plan = loadPlan(mission.mission_id)
    const source = htmlSource()
    const htmlBytes = readFileSync(
      resolveQuarantinedFixturePath(devCorpusRoot, 'G-DEV-01/sources/plan-a.html'),
    )
    const searchProvider = createExaBilledEmptyDdgSuccessProvider(source)
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider,
      admittedGet: async () => ({
        ok: true,
        status: 200,
        contentType: 'text/html',
        buffer: htmlBytes,
        bytesReceived: htmlBytes.length,
        truncated: false,
        requestedUrl: source.observed_urls[0]!,
        finalUrl: source.observed_urls[0]!,
        redirectChain: [source.observed_urls[0]!],
        transportCoding: null,
      }),
    })

    const dir = await mkdtemp(join(tmpdir(), 'search-receipt-integration-'))
    try {
      const store = await DurableResearchStore.open(dir)
      const handle = await store.appendMission(mission)
      await store.appendPlanRevision(
        {
          mission_id: handle.mission_id,
          plan_revision_id: plan.plan_revision_id,
          writer_generation: handle.writer_generation,
        },
        plan,
      )
      const session = { mission, handle, activePlanRevisionId: plan.plan_revision_id }
      const registries = await createCombinedResearchRegistries()
      const adapter = resolveDiscoveryAdapterForMission(mission, registries)
      assert.ok(adapter)
      assert.equal(adapter.adapterId, GENERAL_WEB_ADAPTER_ID)

      const searchOperationId = 'receipt-search-op'
      await runAdmittedRetrievalIteration({
        session,
        store,
        access,
        adapter,
        registries,
        activePlan: plan,
        discoverQuery: 'Nimbus Plan A monthly',
        searchOperationId,
        searchAttemptId: 'receipt-search-att',
        fetchOperationId: 'receipt-fetch-op',
        fetchAttemptId: 'receipt-fetch-att',
        dispatchedAt: '2026-10-21T12:29:00.000Z',
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      })
      await store.close()

      const reopened = await DurableResearchStore.open(dir)
      const events = await reopened.listEvents(mission.mission_id)
      const completion = searchCompletion(events, searchOperationId)
      assert.ok(completion)
      assert.equal(completion?.settlement, 'succeeded')
      assert.ok(completion?.search_provider_receipt)
      assert.equal(completion?.search_provider_receipt?.exa_lite?.requestId, 'exa-req-integration-001')
      assert.equal(completion?.usage_settlement?.cost.status, 'estimated')
      assert.equal(completion?.usage_settlement?.cost.amount_usd, 0.001)
      assert.equal(completion?.usage_settlement?.cost.method, 'exa_lite_provider_costDollars')

      const limitations = deriveSearchProviderReportLimitations(events)
      assert.ok(limitations.some((l) => l.includes('search_provider_degraded:exa_lite->duckduckgo_html_fallback')))
      assert.ok(limitations.some((l) => l.includes('exa_lite_highlights_discovery_only:not_admitted_passages')))

      const passages = events.filter((e) => e.kind === 'passage_recorded')
      assert.ok(passages.length >= 1, 'governed fetch establishes admitted passages')
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails discover conservatively when fallback provider errors (no receipt persisted)', async () => {
    const { createCombinedResearchRegistries } = await import('../../registry/reviewedBAdapterIntegration.js')
    const { resolveDiscoveryAdapterForMission } = await import('../../registry/missionAdapterResolution.js')
    const { runAdmittedRetrievalIteration } = await import('../../engine/researchRetrievalLoop.js')

    const mission = loadMission()
    const plan = loadPlan(mission.mission_id)
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider: createExaAndDdgFailedProvider(),
      admittedGet: async () => ({
        ok: true,
        status: 200,
        contentType: 'text/html',
        buffer: Buffer.from('<html><body>x</body></html>'),
        bytesReceived: 10,
        truncated: false,
        requestedUrl: 'https://example.invalid/x',
        finalUrl: 'https://example.invalid/x',
        redirectChain: ['https://example.invalid/x'],
        transportCoding: null,
      }),
    })
    const store = await import('../../fixtures/fakePorts.js').then((m) => new m.InMemoryResearchStore())
    const handle = await store.appendMission(mission)
    await store.appendPlanRevision(
      {
        mission_id: handle.mission_id,
        plan_revision_id: plan.plan_revision_id,
        writer_generation: handle.writer_generation,
      },
      plan,
    )
    const registries = await createCombinedResearchRegistries()
    const adapter = resolveDiscoveryAdapterForMission(mission, registries)
    assert.ok(adapter)

    await assert.rejects(
      () =>
        runAdmittedRetrievalIteration({
          session: { mission, handle, activePlanRevisionId: plan.plan_revision_id },
          store,
          access,
          adapter,
          registries,
          activePlan: plan,
          discoverQuery: 'missing',
          searchOperationId: 'receipt-fail-search',
          searchAttemptId: 'receipt-fail-search-att',
          fetchOperationId: 'receipt-fail-fetch',
          fetchAttemptId: 'receipt-fail-fetch-att',
          dispatchedAt: FIXED_NOW,
          signal: new AbortController().signal,
          now: () => FIXED_NOW,
        }),
      /transport failed|no admitted source candidates/,
    )

    const events = await store.listEvents(mission.mission_id)
    const completion = searchCompletion(events, 'receipt-fail-search')
    assert.ok(completion)
    assert.equal(completion?.settlement, 'failed')
    assert.equal(completion?.search_provider_receipt, undefined)
  })

  it('legacy discover without receipt remains incomplete accounting (no invented cost)', async () => {
    const { GeneralWebAdapter } = await import('../../adapters/web/generalWebAdapter.js')
    const adapter = new GeneralWebAdapter()
    const port: SourceAccessPort = {
      async search(request: SourceSearchRequest) {
        return {
          operationId: request.operationId,
          status: 'ok',
          hits: [
            {
              source: htmlSource(),
              snippet: 'legacy',
              completeness: 'snippet',
            },
          ],
        }
      },
      async fetchContent(request: SourceFetchRequest) {
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'policy_denied',
          message: 'discover-only',
        }
      },
    }
    const discover = await adapter.discover(
      { operationId: 'legacy-discover', query: 'x', signal: AbortSignal.timeout(5_000) },
      port,
    )
    assert.equal(discover.status, 'ok')
    if (discover.status !== 'ok') return
    assert.equal(discover.search_provider_receipt, undefined)
  })
})
