/**
 * Actual-port reciprocal tests (production loop, injected transport).
 * First-candidate (`discover.candidates[0]`) characterization migrates to A general
 * multi-source APIs when published — no second controller on B branch.
 * @see review-artifacts/MIGRATION-PREP-A-COVERAGE-MULTISOURCE-APIS.md
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
import type { SourceAdapter } from '../../ports/sourceAdapter.js'
import type { SourceAccessPort, SourceFetchRequest, SourceSearchRequest } from '../../ports/sourceAccessPort.js'
import type { SourceRecord } from '../../contracts/sources.js'
import { buildAdmittedContent } from '../../adapters/documents/testAdmittedFixtures.js'
import { GENERAL_WEB_ADAPTER_ID } from '../../adapters/web/generalWebAdapter.js'
import { InMemoryResearchStore } from '../../fixtures/fakePorts.js'
import { runAdmittedRetrievalIteration } from '../../engine/researchRetrievalLoop.js'
import { createCombinedResearchRegistries } from '../../registry/reviewedBAdapterIntegration.js'

const here = dirname(fileURLToPath(import.meta.url))
const gL3FixtureDir = join(here, '../../fixtures/campaign/G-L3-fixtures')
const campaignDir = join(here, '../../fixtures/campaign')

const FIXED_NOW = '2026-10-21T12:10:00.000Z'

async function passagesFromStore(
  store: InMemoryResearchStore,
  missionId: string,
): Promise<PassageRecord[]> {
  const events = await store.listEvents(missionId)
  return events
    .filter((e) => e.kind === 'passage_recorded')
    .map((e) =>
      PassageRecordSchema.parse((e.payload as { passage: PassageRecord }).passage),
    )
}

function loadGL3Mission() {
  return ResearchMissionV2Schema.parse(
    JSON.parse(readFileSync(join(campaignDir, 'G-L3-mission.json'), 'utf8')),
  )
}

function loadGL3Plan(missionId: string) {
  return PlanRevisionSchema.parse({
    plan_revision_id: 'plan-g-l3-actual-port-001',
    mission_id: missionId,
    created_at: '2026-10-21T12:01:00.000Z',
    revision_reason: 'actual_port_fixture',
    questions: [
      {
        question_id: 'q-downloads',
        text: 'Downloads page stable version and date?',
        importance: 'critical',
        evidence_requirement: 'Admitted www.python.org/downloads excerpt',
        status: 'open',
      },
      {
        question_id: 'q-devguide',
        text: 'Devguide status table stable version and date?',
        importance: 'critical',
        evidence_requirement: 'Admitted docs.python.org devguide status excerpt',
        status: 'open',
      },
    ],
  })
}

class TwoPagePythonOrgAccessPort implements SourceAccessPort {
  constructor(
    private readonly pages: Readonly<
      Record<
        string,
        {
          source: SourceRecord
          body: Buffer
        }
      >
    >,
  ) {}

  async search(request: SourceSearchRequest) {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' as const }
    }
    const hits = Object.values(this.pages)
      .filter((entry) => request.sourceClasses.includes(entry.source.kind))
      .map((entry) => ({
        source: entry.source,
        snippet: entry.source.title ?? entry.source.canonical_key,
        completeness: 'snippet' as const,
      }))
    return { operationId: request.operationId, status: 'ok' as const, hits }
  }

  async fetchContent(request: SourceFetchRequest) {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' as const }
    }
    const entry = Object.values(this.pages).find(
      (p) => p.source.source_id === request.source.source_id,
    )
    if (!entry) {
      return {
        operationId: request.operationId,
        status: 'failed' as const,
        failureCategory: 'not_found' as const,
        message: 'fixture source not admitted',
      }
    }
    const url = entry.source.observed_urls[0] ?? 'https://www.python.org/'
    return {
      operationId: request.operationId,
      status: 'ok' as const,
      admitted: buildAdmittedContent(
        request.operationId,
        request.source.source_id,
        `rev-${request.source.source_id}`,
        entry.body,
        'text/html',
        { requestedUrl: url, finalUrl: url, redirectChain: [url] },
      ),
    }
  }
}

function pythonOrgPageSource(
  sourceId: string,
  url: string,
  title: string,
): SourceRecord {
  return {
    source_id: sourceId,
    kind: 'web',
    canonical_key: url,
    observed_urls: [url],
    title,
  }
}

describe('general actual-port: two distinct admitted canonical sources (offline, production loop)', () => {
  const downloadsBody = readFileSync(join(gL3FixtureDir, 'downloads-landing-snippet.html'))
  const devguideBody = readFileSync(join(gL3FixtureDir, 'devguide-status-snippet.html'))
  const downloadsSource = pythonOrgPageSource(
    'src-g-l3-downloads',
    'https://www.python.org/downloads/',
    'Download Python',
  )
  const devguideSource = pythonOrgPageSource(
    'src-g-l3-devguide',
    'https://docs.python.org/devguide/status.html',
    'Status of Python versions',
  )

  it('two separate retrieval iterations each persist evidence from a distinct canonical page', async () => {
    const mission = loadGL3Mission()
    const plan = loadGL3Plan(mission.mission_id)
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
    let workingHandle = handle
    const session = { mission, handle: workingHandle, activePlanRevisionId: plan.plan_revision_id }
    const registries = await createCombinedResearchRegistries()
    const webAdapter = registries.sourceAdapters.getAdapter(GENERAL_WEB_ADAPTER_ID)
    assert.ok(webAdapter)
    const access = new TwoPagePythonOrgAccessPort({
      downloads: { source: downloadsSource, body: downloadsBody },
      devguide: { source: devguideSource, body: devguideBody },
    })

    const pickFirst = (preferred: SourceRecord): SourceAdapter => ({
      adapterId: webAdapter.adapterId,
      supportedKinds: webAdapter.supportedKinds,
      discover: async (request, port) => ({
        operationId: request.operationId,
        status: 'ok',
        candidates: [preferred],
      }),
      read: (request, port) => webAdapter.read(request, port),
    })

    const first = await runAdmittedRetrievalIteration({
      session: { ...session, handle: workingHandle },
      store,
      access,
      adapter: pickFirst(downloadsSource),
      registries,
      activePlan: plan,
      discoverQuery: 'python downloads stable release',
      searchOperationId: 'g-l3-search-downloads',
      searchAttemptId: 'g-l3-search-downloads-att',
      fetchOperationId: 'g-l3-fetch-downloads',
      fetchAttemptId: 'g-l3-fetch-downloads-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    workingHandle = first.handle
    const second = await runAdmittedRetrievalIteration({
      session: { ...session, handle: workingHandle },
      store,
      access,
      adapter: pickFirst(devguideSource),
      registries,
      activePlan: plan,
      discoverQuery: 'python devguide status table',
      searchOperationId: 'g-l3-search-devguide',
      searchAttemptId: 'g-l3-search-devguide-att',
      fetchOperationId: 'g-l3-fetch-devguide',
      fetchAttemptId: 'g-l3-fetch-devguide-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })

    assert.notEqual(first.source.source_id, second.source.source_id)
    assert.ok(first.passageIds.length >= 1)
    assert.ok(second.passageIds.length >= 1)
    const passages = await passagesFromStore(store, mission.mission_id)
    assert.ok(passages.length >= 2)
    assert.equal(first.source.source_id, downloadsSource.source_id)
    assert.equal(second.source.source_id, devguideSource.source_id)
  })

  it('production discover still admits only candidates[0] in a single iteration (no multi-source controller)', async () => {
    const mission = loadGL3Mission()
    const plan = loadGL3Plan(mission.mission_id)
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
    const access = new TwoPagePythonOrgAccessPort({
      downloads: { source: downloadsSource, body: downloadsBody },
      devguide: { source: devguideSource, body: devguideBody },
    })
    const dualCandidateAdapter: SourceAdapter = {
      adapterId: webAdapter.adapterId,
      supportedKinds: webAdapter.supportedKinds,
      discover: async (request) => ({
        operationId: request.operationId,
        status: 'ok',
        candidates: [downloadsSource, devguideSource],
      }),
      read: (request, port) => webAdapter.read(request, port),
    }
    const result = await runAdmittedRetrievalIteration({
      session,
      store,
      access,
      adapter: dualCandidateAdapter,
      registries,
      activePlan: plan,
      discoverQuery: 'python stable version',
      searchOperationId: 'g-l3-search-dual',
      searchAttemptId: 'g-l3-search-dual-att',
      fetchOperationId: 'g-l3-fetch-dual',
      fetchAttemptId: 'g-l3-fetch-dual-att',
      dispatchedAt: FIXED_NOW,
      signal: new AbortController().signal,
      now: () => FIXED_NOW,
    })
    assert.equal(result.source.source_id, downloadsSource.source_id)
    const passages = await passagesFromStore(store, mission.mission_id)
    assert.ok(passages.length >= 1)
    assert.equal(result.source.source_id, downloadsSource.source_id)
    const revisionPrefix = `rev-${devguideSource.source_id}`
    assert.ok(!passages.some((p) => p.source_revision_id.startsWith(revisionPrefix)))
  })

  it('deterministic insufficiency fixture documents single-page offline slice (not live conflict)', () => {
    const insufficiency = JSON.parse(
      readFileSync(join(campaignDir, 'G-L3-deterministic-insufficiency.fixture.json'), 'utf8'),
    )
    assert.equal(insufficiency.label, 'DETERMINISTIC_INSUFFICIENCY_FIXTURE')
    assert.equal(insufficiency.admitted_fixture_pages.length, 1)
    assert.ok(insufficiency.missing_for_cross_page_comparison.length >= 1)
    assert.equal(insufficiency.expected_offline_terminal_state, 'partial')
  })
})
