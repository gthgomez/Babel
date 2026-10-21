import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { PassageRecord } from '../../contracts/passages.js'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { PlanRevisionSchema } from '../../contracts/plan.js'
import {
  GeneralMissionBriefSchema,
  normalizeGeneralMissionBrief,
} from '../../contracts/normalization.js'
import type { SourceAdapter } from '../../ports/sourceAdapter.js'
import type { SourceAccessPort, SourceFetchRequest, SourceSearchRequest } from '../../ports/sourceAccessPort.js'
import type { SourceRecord } from '../../contracts/sources.js'
import { buildAdmittedContent } from '../../adapters/documents/testAdmittedFixtures.js'
import { resolveQuarantinedFixturePath } from '../../adapters/documents/quarantinePath.js'
import { passageTextHash } from '../../adapters/documents/passageInlineText.js'
import { GENERAL_DOCUMENT_ADAPTER_ID } from '../../adapters/documents/generalDocumentAdapter.js'
import { GENERAL_WEB_ADAPTER_ID } from '../../adapters/web/generalWebAdapter.js'

const here = dirname(fileURLToPath(import.meta.url))

const devCorpusRoot = join(here, 'fixtures/dev-corpus')
const pdfFixture = join(here, '../../adapters/documents/fixtures/two-page-sample.pdf')

const FIXED_NOW = '2026-10-20T12:10:00.000Z'

async function passagesFromStoreEvents(
  store: { listEvents: (missionId: string) => Promise<readonly { kind: string; payload: unknown }[]> },
  missionId: string,
): Promise<PassageRecord[]> {
  const events = await store.listEvents(missionId)
  return events
    .filter((e) => e.kind === 'passage_recorded')
    .map((e) =>
      PassageRecordSchema.parse((e.payload as { passage: PassageRecord }).passage),
    )
}

function loadGeneralDev01Mission() {
  const brief = GeneralMissionBriefSchema.parse(
    JSON.parse(readFileSync(join(devCorpusRoot, 'G-DEV-01/mission.json'), 'utf8')),
  )
  return normalizeGeneralMissionBrief(brief, {
    mission_id: 'mission-g-dev-01-engine-reciprocal',
    created_at: '2026-10-20T12:00:00.000Z',
    profile_version: '0.1.0-m0',
  })
}

function loadGeneralPlan(missionId: string) {
  return PlanRevisionSchema.parse({
    plan_revision_id: 'plan-g-dev-engine-reciprocal-001',
    mission_id: missionId,
    created_at: '2026-10-20T12:01:00.000Z',
    revision_reason: 'integration_fixture',
    questions: [
      {
        question_id: 'q-plan',
        text: 'Which plan fits storage needs?',
        importance: 'critical',
        evidence_requirement: 'Admitted HTML/PDF excerpts with locators',
        status: 'open',
      },
    ],
  })
}

/** B-owned injected transport: search-backed discover + admitted inline fetch bytes. */
class GeneralProfileIntegrationAccessPort implements SourceAccessPort {
  constructor(
    private readonly html: { source: SourceRecord; body: Buffer },
    private readonly pdf: { source: SourceRecord; body: Buffer },
  ) {}

  async search(request: SourceSearchRequest) {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' as const }
    }
    const wantsPdf = request.query.includes('INTEGRATION_PDF')
    const entry = wantsPdf ? this.pdf : this.html
    if (!request.sourceClasses.includes(entry.source.kind)) {
      return { operationId: request.operationId, status: 'ok' as const, hits: [] }
    }
    return {
      operationId: request.operationId,
      status: 'ok' as const,
      hits: [
        {
          source: entry.source,
          snippet: wantsPdf ? 'two-page pdf fixture' : 'Nimbus Plan A monthly',
          completeness: 'snippet' as const,
        },
      ],
    }
  }

  async fetchContent(request: SourceFetchRequest) {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' as const }
    }
    const entry =
      request.source.source_id === this.pdf.source.source_id ? this.pdf : this.html
    const mediaType = entry === this.pdf ? 'application/pdf' : 'text/html'
    const url = entry.source.observed_urls[0] ?? 'https://example.invalid/source'
    return {
      operationId: request.operationId,
      status: 'ok' as const,
      admitted: buildAdmittedContent(
        request.operationId,
        request.source.source_id,
        `rev-${request.source.source_id}`,
        entry.body,
        mediaType,
        { requestedUrl: url, finalUrl: url, redirectChain: [url] },
      ),
    }
  }
}

describe('general adapter engine reciprocal (#406 integration base, offline)', () => {
    it('createCombinedResearchRegistries registers B catalog adapters', async () => {
      const { createCombinedResearchRegistries } = await import(
        '../../registry/reviewedBAdapterIntegration.js'
      )
      const { generalAdapterCatalog } = await import('./generalAdapterCatalog.js')
      const registries = await createCombinedResearchRegistries()
      assert.ok(registries.sourceAdapters.getAdapter(generalAdapterCatalog.document.adapterId))
      assert.ok(registries.sourceAdapters.getAdapter(generalAdapterCatalog.web.adapterId))
      assert.deepEqual(registries.bAdaptersRegistered, [
        `documents/${generalAdapterCatalog.document.adapterId}`,
        `web/${generalAdapterCatalog.web.adapterId}`,
      ])
    })

    it('production discovery uses search-backed web adapter (not document)', async () => {
      const { createCombinedResearchRegistries } = await import(
        '../../registry/reviewedBAdapterIntegration.js'
      )
      const { resolveDiscoveryAdapterForMission } = await import(
        '../../registry/missionAdapterResolution.js'
      )
      const mission = loadGeneralDev01Mission()
      const registries = await createCombinedResearchRegistries()
      const discovery = resolveDiscoveryAdapterForMission(mission, registries)
      assert.ok(discovery)
      assert.equal(discovery.adapterId, GENERAL_WEB_ADAPTER_ID)
      assert.notEqual(discovery.adapterId, GENERAL_DOCUMENT_ADAPTER_ID)
    })

    it('runAdmittedRetrievalIteration: search → web discover → HTML read → persisted passages', async () => {
      const { InMemoryResearchStore } = await import('../../fixtures/fakePorts.js')
      const { runAdmittedRetrievalIteration } = await import('../../engine/researchRetrievalLoop.js')
      const { createCombinedResearchRegistries } = await import(
        '../../registry/reviewedBAdapterIntegration.js'
      )
      const { resolveDiscoveryAdapterForMission } = await import(
        '../../registry/missionAdapterResolution.js'
      )
      const mission = loadGeneralDev01Mission()
      const plan = loadGeneralPlan(mission.mission_id)
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
      const session = {
        mission,
        handle,
        activePlanRevisionId: plan.plan_revision_id,
      }
      const registries = await createCombinedResearchRegistries()
      const discoveryAdapter = resolveDiscoveryAdapterForMission(mission, registries)
      assert.ok(discoveryAdapter)
      const htmlBytes = readFileSync(
        resolveQuarantinedFixturePath(devCorpusRoot, 'G-DEV-01/sources/plan-a.html'),
      )
      const htmlSource: SourceRecord = {
        source_id: 'src-gdev01-plan-a',
        kind: 'web',
        canonical_key: 'https://example.invalid/plan-a',
        observed_urls: ['https://example.invalid/plan-a'],
        title: 'Nimbus Plan A',
      }
      const pdfBytes = readFileSync(pdfFixture)
      const pdfSource: SourceRecord = {
        source_id: 'src-two-page-pdf',
        kind: 'document',
        canonical_key: 'fixture:two-page-pdf',
        observed_urls: ['https://example.invalid/two-page-sample.pdf'],
        title: 'Policy PDF',
      }
      const access = new GeneralProfileIntegrationAccessPort(
        { source: htmlSource, body: htmlBytes },
        { source: pdfSource, body: pdfBytes },
      )
      let searchCalls = 0
      const trackingAccess: SourceAccessPort = {
        async search(request) {
          searchCalls++
          return access.search(request)
        },
        fetchContent: (request) => access.fetchContent(request),
      }
      const result = await runAdmittedRetrievalIteration({
        session,
        store,
        access: trackingAccess,
        adapter: discoveryAdapter,
        registries,
        activePlan: plan,
        discoverQuery: 'Nimbus Plan A monthly',
        searchOperationId: 'gen-search-html',
        searchAttemptId: 'gen-search-html-att',
        fetchOperationId: 'gen-fetch-html',
        fetchAttemptId: 'gen-fetch-html-att',
        dispatchedAt: '2026-10-20T12:09:00.000Z',
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      })
      assert.ok(searchCalls >= 1)
      assert.equal(result.source.source_id, htmlSource.source_id)
      assert.ok(result.passageIds.length >= 1)
      const events = await store.listEvents(mission.mission_id)
      assert.ok(events.some((e) => e.kind === 'passage_recorded'))
      const passages = await passagesFromStoreEvents(store, mission.mission_id)
      assert.ok(passages.length >= 1)
      for (const passage of passages) {
        PassageRecordSchema.parse(passage)
        if (passage.text_ref.mode === 'inline') {
          assert.equal(passage.text_ref.text_hash, passageTextHash(passage.text_ref.text))
        }
        assert.match(passage.passage_id, /^gen-fetch-html:/)
      }
    })

    it('runAdmittedRetrievalIteration: document candidate resolves to PDF read + persisted page passages', async () => {
      const { InMemoryResearchStore } = await import('../../fixtures/fakePorts.js')
      const { runAdmittedRetrievalIteration } = await import('../../engine/researchRetrievalLoop.js')
      const { createCombinedResearchRegistries } = await import(
        '../../registry/reviewedBAdapterIntegration.js'
      )
      const mission = loadGeneralDev01Mission()
      const plan = loadGeneralPlan(mission.mission_id)
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
      const webAdapter = registries.sourceAdapters.getAdapter(GENERAL_WEB_ADAPTER_ID)
      assert.ok(webAdapter)
      const htmlBytes = readFileSync(
        resolveQuarantinedFixturePath(devCorpusRoot, 'G-DEV-01/sources/plan-a.html'),
      )
      const htmlSource: SourceRecord = {
        source_id: 'src-gdev01-plan-a',
        kind: 'web',
        canonical_key: 'https://example.invalid/plan-a',
        observed_urls: ['https://example.invalid/plan-a'],
      }
      const pdfBytes = readFileSync(pdfFixture)
      const pdfSource: SourceRecord = {
        source_id: 'src-two-page-pdf',
        kind: 'document',
        canonical_key: 'fixture:two-page-pdf',
        observed_urls: ['https://example.invalid/two-page-sample.pdf'],
      }
      const access = new GeneralProfileIntegrationAccessPort(
        { source: htmlSource, body: htmlBytes },
        { source: pdfSource, body: pdfBytes },
      )
      const discoveryAdapter: SourceAdapter = {
        adapterId: webAdapter.adapterId,
        supportedKinds: webAdapter.supportedKinds,
        discover: async (request, port) => {
          if (request.query.includes('INTEGRATION_PDF')) {
            return {
              operationId: request.operationId,
              status: 'ok',
              candidates: [pdfSource],
            }
          }
          return webAdapter.discover(request, port)
        },
        read: (request, port) => webAdapter.read(request, port),
      }
      const result = await runAdmittedRetrievalIteration({
        session,
        store,
        access,
        adapter: discoveryAdapter,
        registries,
        activePlan: plan,
        discoverQuery: 'INTEGRATION_PDF two-page',
        searchOperationId: 'gen-search-pdf',
        searchAttemptId: 'gen-search-pdf-att',
        fetchOperationId: 'gen-fetch-pdf',
        fetchAttemptId: 'gen-fetch-pdf-att',
        dispatchedAt: '2026-10-20T12:09:00.000Z',
        signal: new AbortController().signal,
        now: () => FIXED_NOW,
      })
      assert.equal(result.source.source_id, pdfSource.source_id)
      const passages = await passagesFromStoreEvents(store, mission.mission_id)
      assert.equal(passages.length, 2)
      for (const passage of passages) {
        PassageRecordSchema.parse(passage)
        assert.equal(passage.locator.kind, 'page')
        if (passage.text_ref.mode === 'inline') {
          assert.equal(passage.text_ref.text_hash, passageTextHash(passage.text_ref.text))
        }
      }
      const readAdapter = registries.sourceAdapters.getAdapter(GENERAL_DOCUMENT_ADAPTER_ID)
      assert.ok(readAdapter)
    })

    it('document adapter discover remains unsupported through retrieval loop', async () => {
      const { InMemoryResearchStore } = await import('../../fixtures/fakePorts.js')
      const { runAdmittedRetrievalIteration } = await import('../../engine/researchRetrievalLoop.js')
      const { createCombinedResearchRegistries } = await import(
        '../../registry/reviewedBAdapterIntegration.js'
      )
      const mission = loadGeneralDev01Mission()
      const plan = loadGeneralPlan(mission.mission_id)
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
      const documentAdapter = registries.sourceAdapters.getAdapter(GENERAL_DOCUMENT_ADAPTER_ID)
      assert.ok(documentAdapter)
      const access = new GeneralProfileIntegrationAccessPort(
        {
          source: {
            source_id: 'unused-html',
            kind: 'web',
            canonical_key: 'x',
            observed_urls: ['https://example.invalid/x'],
          },
          body: Buffer.from('<html></html>', 'utf8'),
        },
        {
          source: {
            source_id: 'unused-pdf',
            kind: 'document',
            canonical_key: 'y',
            observed_urls: ['https://example.invalid/y.pdf'],
          },
          body: readFileSync(pdfFixture),
        },
      )
      await assert.rejects(
        () =>
          runAdmittedRetrievalIteration({
            session,
            store,
            access,
            adapter: documentAdapter,
            registries,
            activePlan: plan,
            discoverQuery: 'anything',
            searchOperationId: 'gen-search-unsupported',
            searchAttemptId: 'gen-search-unsupported-att',
            fetchOperationId: 'gen-fetch-unsupported',
            fetchAttemptId: 'gen-fetch-unsupported-att',
            dispatchedAt: '2026-10-20T12:09:00.000Z',
            signal: new AbortController().signal,
            now: () => FIXED_NOW,
          }),
        /network discovery|not_supported|discover/i,
      )
    })

    it('runAdmittedRetrievalIteration: cancelled discover settles without persisting passages', async () => {
      const { InMemoryResearchStore } = await import('../../fixtures/fakePorts.js')
      const { runAdmittedRetrievalIteration } = await import('../../engine/researchRetrievalLoop.js')
      const { createCombinedResearchRegistries } = await import(
        '../../registry/reviewedBAdapterIntegration.js'
      )
      const { resolveDiscoveryAdapterForMission } = await import(
        '../../registry/missionAdapterResolution.js'
      )
      const mission = loadGeneralDev01Mission()
      const plan = loadGeneralPlan(mission.mission_id)
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
      const discoveryAdapter = resolveDiscoveryAdapterForMission(mission, registries)
      assert.ok(discoveryAdapter)
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        () =>
          runAdmittedRetrievalIteration({
            session,
            store,
            access: new GeneralProfileIntegrationAccessPort(
              {
                source: {
                  source_id: 's',
                  kind: 'web',
                  canonical_key: 'k',
                  observed_urls: ['https://example.invalid/k'],
                },
                body: Buffer.from('<html><h1>H</h1><p>x</p></html>', 'utf8'),
              },
              {
                source: {
                  source_id: 'p',
                  kind: 'document',
                  canonical_key: 'p',
                  observed_urls: ['https://example.invalid/p.pdf'],
                },
                body: readFileSync(pdfFixture),
              },
            ),
            adapter: discoveryAdapter,
            registries,
            activePlan: plan,
            discoverQuery: 'Nimbus',
            searchOperationId: 'gen-search-cancel',
            searchAttemptId: 'gen-search-cancel-att',
            fetchOperationId: 'gen-fetch-cancel',
            fetchAttemptId: 'gen-fetch-cancel-att',
            dispatchedAt: '2026-10-20T12:09:00.000Z',
            signal: controller.signal,
            now: () => FIXED_NOW,
          }),
        /aborted|cancelled/i,
      )
      const passages = await passagesFromStoreEvents(store, mission.mission_id)
      assert.equal(passages.length, 0)
    })
})
