/**
 * Composed production-factory + admitted-transport two-source regression (offline).
 * Uses GeneralWebAdapter discover/read with injected fetch/search transport only —
 * not adapter.read stubs and not a substitute for live G-L2 (see diagnostic-1 receipt).
 *
 * Helper-only selection tests remain in missionWebRetrievalSelection.test.ts.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { PassageRecord } from '../../contracts/passages.js'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { PlanRevisionSchema } from '../../contracts/plan.js'
import { ResearchMissionV2Schema } from '../../contracts/mission.js'
import type { SourceAccessPort, SourceFetchRequest, SourceSearchRequest } from '../../ports/sourceAccessPort.js'
import type { SourceRecord } from '../../contracts/sources.js'
import { buildAdmittedContent } from '../../adapters/documents/testAdmittedFixtures.js'
import { passageTextHash } from '../../adapters/documents/passageInlineText.js'
import { InMemoryResearchStore } from '../../fixtures/fakePorts.js'
import { runAdmittedRetrievalIteration } from '../../engine/researchRetrievalLoop.js'
import { normalizedWebTargetKey } from '../../access/missionWebRetrievalSelection.js'
import { resolveDiscoveryAdapterForMission } from '../../registry/missionAdapterResolution.js'
import { createCombinedResearchRegistries } from '../../registry/reviewedBAdapterIntegration.js'

const here = dirname(fileURLToPath(import.meta.url))
const campaignDir = join(here, '../../fixtures/campaign')
const gL3FixtureDir = join(campaignDir, 'G-L3-fixtures')
const FIXED_NOW = '2026-10-21T14:00:00.000Z'

const DOWNLOADS_URL = 'https://www.python.org/downloads/'
const DEVGUIDE_URL = 'https://docs.python.org/devguide/status.html'

function loadG3Mission(overrides?: { selected_web_refs?: string[] }) {
  const mission = ResearchMissionV2Schema.parse(
    JSON.parse(readFileSync(join(campaignDir, 'G-L3-mission.json'), 'utf8')),
  )
  if (overrides?.selected_web_refs) {
    return {
      ...mission,
      source_policy: {
        ...mission.source_policy,
        selected_web_refs: overrides.selected_web_refs,
      },
    }
  }
  return mission
}

function g3Plan(missionId: string) {
  return PlanRevisionSchema.parse({
    plan_revision_id: 'plan-g-l3-factory-two-source-001',
    mission_id: missionId,
    created_at: FIXED_NOW,
    revision_reason: 'factory_actual_port_fixture',
    questions: [
      {
        question_id: 'q-downloads',
        text: 'Downloads page stable version and date?',
        importance: 'critical',
        evidence_requirement: 'Admitted downloads excerpt',
        status: 'open',
      },
      {
        question_id: 'q-devguide',
        text: 'Devguide status table stable version and date?',
        importance: 'critical',
        evidence_requirement: 'Admitted devguide excerpt',
        status: 'open',
      },
    ],
  })
}

function webSource(sourceId: string, primaryUrl: string, aliasUrl?: string): SourceRecord {
  const observed = aliasUrl ? [aliasUrl, primaryUrl] : [primaryUrl]
  return {
    source_id: sourceId,
    kind: 'web',
    canonical_key: primaryUrl,
    observed_urls: observed,
    title: primaryUrl,
  }
}

/** Injected transport: search + fetchContent bytes keyed by final requested URL. */
class UrlKeyedGeneralAccessPort implements SourceAccessPort {
  constructor(
    private readonly pages: Readonly<Record<string, { body: Buffer; mediaType?: string }>>,
    private readonly searchHits: SourceRecord[],
  ) {}

  async search(request: SourceSearchRequest) {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' as const }
    }
    const hits = this.searchHits
      .filter((s) => request.sourceClasses.includes(s.kind))
      .map((source) => ({
        source,
        snippet: source.title ?? source.canonical_key,
        completeness: 'snippet' as const,
      }))
    return { operationId: request.operationId, status: 'ok' as const, hits }
  }

  async fetchContent(request: SourceFetchRequest) {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' as const }
    }
    const url = request.source.observed_urls[0] ?? request.source.canonical_key
    const key = normalizedWebTargetKey(url)
    const page = this.pages[key]
    if (!page) {
      return {
        operationId: request.operationId,
        status: 'failed' as const,
        failureCategory: 'not_found' as const,
        message: `fixture missing page for ${key}`,
      }
    }
    return {
      operationId: request.operationId,
      status: 'ok' as const,
      admitted: buildAdmittedContent(
        request.operationId,
        request.source.source_id,
        `rev-${request.source.source_id}`,
        page.body,
        page.mediaType ?? 'text/html',
        { requestedUrl: url, finalUrl: url, redirectChain: [url] },
      ),
    }
  }
}

function operationIdFromEvent(event: { payload: unknown }): string | undefined {
  const p = event.payload as {
    intent?: { operation_id?: string }
    completion?: { operation_id?: string }
  }
  return p.intent?.operation_id ?? p.completion?.operation_id
}

function completionSettlement(event: { payload: unknown } | undefined): string | undefined {
  if (!event) return undefined
  return (event.payload as { completion?: { settlement?: string } }).completion?.settlement
}

async function passagesFromStore(store: InMemoryResearchStore, missionId: string): Promise<PassageRecord[]> {
  const events = await store.listEvents(missionId)
  return events
    .filter((e) => e.kind === 'passage_recorded')
    .map((e) => PassageRecordSchema.parse((e.payload as { passage: PassageRecord }).passage))
}

describe('general multi-web production factory + admitted transport (G-L3 refs, offline)', () => {
  const downloadsBody = readFileSync(join(gL3FixtureDir, 'downloads-landing-snippet.html'))
  const devguideBody = readFileSync(join(gL3FixtureDir, 'devguide-status-snippet.html'))

  const pages = {
    [normalizedWebTargetKey(DOWNLOADS_URL)]: { body: downloadsBody },
    [normalizedWebTargetKey(DEVGUIDE_URL)]: { body: devguideBody },
  }

  it('fetches both selected_web_refs via production web adapter with distinct fetch operation IDs', async () => {
    const mission = loadG3Mission()
    const plan = g3Plan(mission.mission_id)
    const store = new InMemoryResearchStore()
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
    const fetchUrls: string[] = []
    const baseAccess = new UrlKeyedGeneralAccessPort(pages, [])
    const access: SourceAccessPort = {
      search: (r) => baseAccess.search(r),
      fetchContent: async (r) => {
        const url = r.source.observed_urls[0] ?? ''
        fetchUrls.push(normalizedWebTargetKey(url))
        return baseAccess.fetchContent(r)
      },
    }
    const result = await runAdmittedRetrievalIteration({
      session,
      store,
      access,
      adapter,
      registries,
      activePlan: plan,
      discoverQuery: 'python stable version downloads devguide status',
      searchOperationId: 'factory-search',
      searchAttemptId: 'factory-search-att',
      fetchOperationId: 'factory-fetch',
      fetchAttemptId: 'factory-fetch-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    assert.equal(result.sources.length, 2)
    assert.ok(fetchUrls.includes(normalizedWebTargetKey(DOWNLOADS_URL)))
    assert.ok(fetchUrls.includes(normalizedWebTargetKey(DEVGUIDE_URL)))
    const events = await store.listEvents(mission.mission_id)
    const fetchIntents = events.filter(
      (e) =>
        e.kind === 'external_operation_intent' &&
        String(operationIdFromEvent(e)).startsWith('factory-fetch'),
    )
    assert.equal(fetchIntents.length, 2)
    const passages = await passagesFromStore(store, mission.mission_id)
    assert.ok(passages.length >= 2)
    for (const passage of passages) {
      if (passage.text_ref.mode === 'inline') {
        assert.equal(passage.text_ref.text_hash, passageTextHash(passage.text_ref.text))
      }
    }
  })

  it('rebinds discover alias primary URL to mission ref before fetch (transport sees canonical URL)', async () => {
    const mission = loadG3Mission()
    const plan = g3Plan(mission.mission_id)
    const aliasUrl = 'https://www.python.org/downloads/alias-primary'
    const discoverSource = webSource('discover-alias', DOWNLOADS_URL, aliasUrl)
    const store = new InMemoryResearchStore()
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
    const productionAdapter = resolveDiscoveryAdapterForMission(mission, registries)
    assert.ok(productionAdapter)
    const fetchUrls: string[] = []
    const access: SourceAccessPort = {
      async search(request) {
        return {
          operationId: request.operationId,
          status: 'ok',
          hits: [{ source: discoverSource, snippet: 'alias hit', completeness: 'snippet' }],
        }
      },
      fetchContent: async (request) => {
        const url = request.source.observed_urls[0] ?? ''
        fetchUrls.push(normalizedWebTargetKey(url))
        return new UrlKeyedGeneralAccessPort(pages, [discoverSource]).fetchContent(request)
      },
    }
    await runAdmittedRetrievalIteration({
      session,
      store,
      access,
      adapter: productionAdapter,
      registries,
      activePlan: plan,
      discoverQuery: 'python downloads',
      searchOperationId: 'alias-search',
      searchAttemptId: 'alias-search-att',
      fetchOperationId: 'alias-fetch',
      fetchAttemptId: 'alias-fetch-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    assert.ok(
      fetchUrls.some((u) => u === normalizedWebTargetKey(DOWNLOADS_URL)),
      'fetch must use mission ref URL, not alias-only primary',
    )
    assert.ok(!fetchUrls.includes(normalizedWebTargetKey(aliasUrl)))
  })

  it('dedupes duplicate selected_web_refs to a single fetch operation', async () => {
    const mission = loadG3Mission({ selected_web_refs: [DOWNLOADS_URL, DOWNLOADS_URL] })
    const plan = g3Plan(mission.mission_id)
    const store = new InMemoryResearchStore()
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
    const access = new UrlKeyedGeneralAccessPort(pages, [])
    const result = await runAdmittedRetrievalIteration({
      session,
      store,
      access,
      adapter,
      registries,
      activePlan: plan,
      discoverQuery: 'duplicate ref',
      searchOperationId: 'dup-search',
      searchAttemptId: 'dup-search-att',
      fetchOperationId: 'dup-fetch',
      fetchAttemptId: 'dup-fetch-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    assert.equal(result.sources.length, 1)
    assert.ok(result.limitations.some((l) => l.startsWith('retrieval_web_ref_duplicate:')))
    const events = await store.listEvents(mission.mission_id)
    const fetchIntents = events.filter(
      (e) =>
        e.kind === 'external_operation_intent' &&
        String(operationIdFromEvent(e)).startsWith('dup-fetch'),
    )
    assert.equal(fetchIntents.length, 1)
  })

  it('persistence failure after first passage settles fetch once and records no further passages', async () => {
    const mission = loadG3Mission({ selected_web_refs: [DOWNLOADS_URL, DEVGUIDE_URL] })
    const plan = g3Plan(mission.mission_id)
    const store = new InMemoryResearchStore()
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
    const access = new UrlKeyedGeneralAccessPort(pages, [])
    const originalAppendPassage = store.appendPassage.bind(store)
    let appendCalls = 0
    store.appendPassage = async (...args) => {
      appendCalls += 1
      if (appendCalls === 1) {
        throw new Error('store fencing failure')
      }
      return originalAppendPassage(...args)
    }
    await assert.rejects(() =>
      runAdmittedRetrievalIteration({
        session,
        store,
        access,
        adapter,
        registries,
        activePlan: plan,
        discoverQuery: 'fence',
        searchOperationId: 'fence-search',
        searchAttemptId: 'fence-search-att',
        fetchOperationId: 'fence-fetch',
        fetchAttemptId: 'fence-fetch-att',
        dispatchedAt: FIXED_NOW,
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      }),
    )
    const events = await store.listEvents(mission.mission_id)
    const firstFetchOp = 'fence-fetch--web-ref-0'
    const completion = events.find(
      (e) =>
        e.kind === 'external_operation_completed' &&
        operationIdFromEvent(e) === firstFetchOp,
    )
    assert.equal(completionSettlement(completion), 'failed')
    const laterFetchIntents = events.filter(
      (e) =>
        e.kind === 'external_operation_intent' &&
        String(operationIdFromEvent(e)).includes('web-ref-1'),
    )
    assert.equal(laterFetchIntents.length, 0)
    assert.equal(events.filter((e) => e.kind === 'passage_recorded').length, 0)
  })
})
