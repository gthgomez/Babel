/**
 * Bounded receipt review: no_candidates, cancellation accounting, failed terminal report.
 * DurableResearchStore close/reopen only (no live Exa).
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
import type { SourceSearchRequest } from '../../ports/sourceAccessPort.js'
import { createGovernedSourceAccessPort } from '../../access/governedSourceAccessPort.js'
import { DurableResearchStore } from '../../persistence/durableResearchStore.js'
import { GENERAL_WEB_ADAPTER_ID } from '../../adapters/web/generalWebAdapter.js'
import { finalizeFailedOwnerResearchPass } from '../../engine/finalizeFailedOwnerResearchPass.js'
import { finalizeOwnerResearchRunCancellation } from '../../engine/finalizeOwnerResearchRunCancellation.js'

const here = dirname(fileURLToPath(import.meta.url))
const devCorpusRoot = join(here, 'fixtures/dev-corpus')
const FIXED_NOW = '2026-10-21T12:45:00.000Z'

function loadMission() {
  const brief = GeneralMissionBriefSchema.parse(
    JSON.parse(readFileSync(join(devCorpusRoot, 'G-DEV-01/mission.json'), 'utf8')),
  )
  const mission = normalizeGeneralMissionBrief(brief, {
    mission_id: 'mission-receipt-bounded-review',
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
    plan_revision_id: 'plan-receipt-bounded-review',
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

function exaLiteMeta(requestId: string, estimated: number) {
  return {
    request_id: requestId,
    resolved_search_type: 'auto' as string | null,
    warnings: [],
    notices: [],
    estimated_cost_dollars: estimated,
    estimated_cost_detail: null as Record<string, number> | null,
  }
}

function billedEmptyReceipt(requestId: string, cost: number) {
  return {
    configured_provider_id: 'exa_lite',
    effective_provider_id: 'duckduckgo_html_fallback',
    exa_participation: 'exa_primary_empty_billed' as const,
    degradation: {
      from_provider_id: 'exa_lite',
      to_provider_id: 'duckduckgo_html_fallback',
      reason: 'exa_zero_hits',
    },
    exa_lite: exaLiteMeta(requestId, cost),
  }
}

function searchCompletion(
  events: readonly { kind: string; payload: unknown }[],
  operationId: string,
): ExternalOperationCompletion | undefined {
  for (const event of events) {
    if (event.kind !== 'external_operation_completed') continue
    const completion = (event.payload as { completion: ExternalOperationCompletion }).completion
    if (completion.operation_id === operationId) return completion
  }
  return undefined
}

function terminalReportFromEvents(events: readonly { kind: string; payload: unknown }[]) {
  const row = events.find((e) => e.kind === 'terminal_receipt')
  return row ? (row.payload as { report: { limitations: string[]; terminal_state: string } }).report : undefined
}

describe('source search receipt bounded review (durable)', () => {
  it('retains receipt and provider-estimated cost on no_candidates failed source_search', async () => {
    const { createCombinedResearchRegistries } = await import('../../registry/reviewedBAdapterIntegration.js')
    const { resolveDiscoveryAdapterForMission } = await import('../../registry/missionAdapterResolution.js')
    const { runAdmittedRetrievalIteration } = await import('../../engine/researchRetrievalLoop.js')

    const mission = loadMission()
    const plan = loadPlan(mission.mission_id)
    const searchProvider: AdmittedSourceSearchProvider = {
      async search(request: SourceSearchRequest) {
        if (!request.sourceClasses.includes('web')) {
          return { operationId: request.operationId, status: 'ok', hits: [] }
        }
        return {
          operationId: request.operationId,
          status: 'ok',
          hits: [],
          receipt: billedEmptyReceipt('exa-req-no-candidates', 0.002),
        }
      },
    }
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider,
      admittedGet: async () => ({
        ok: false,
        status: 404,
        contentType: 'text/plain',
        buffer: Buffer.alloc(0),
        bytesReceived: 0,
        truncated: false,
        requestedUrl: 'https://example.invalid/none',
        finalUrl: 'https://example.invalid/none',
        redirectChain: [],
        transportCoding: null,
      }),
    })

    const dir = await mkdtemp(join(tmpdir(), 'receipt-no-candidates-'))
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
      const registries = await createCombinedResearchRegistries()
      const adapter = resolveDiscoveryAdapterForMission(mission, registries)
      assert.ok(adapter)
      assert.equal(adapter.adapterId, GENERAL_WEB_ADAPTER_ID)

      const searchOperationId = 'bounded-no-candidates-search'
      await assert.rejects(
        () =>
          runAdmittedRetrievalIteration({
            session: { mission, handle, activePlanRevisionId: plan.plan_revision_id },
            store,
            access,
            adapter,
            registries,
            activePlan: plan,
            discoverQuery: 'no hits',
            searchOperationId,
            searchAttemptId: 'bounded-no-candidates-search-att',
            fetchOperationId: 'bounded-no-candidates-fetch',
            fetchAttemptId: 'bounded-no-candidates-fetch-att',
            dispatchedAt: FIXED_NOW,
            signal: new AbortController().signal,
            now: () => FIXED_NOW,
          }),
        /no admitted source candidates/,
      )
      await store.close()

      const reopened = await DurableResearchStore.open(dir)
      const events = await reopened.listEvents(mission.mission_id)
      const completion = searchCompletion(events, searchOperationId)
      assert.equal(completion?.settlement, 'failed')
      assert.equal(completion?.failure_category, 'no_candidates')
      assert.equal(completion?.search_provider_receipt?.exa_participation, 'exa_primary_empty_billed')
      assert.equal(completion?.usage_settlement?.cost.status, 'estimated')
      if (completion?.usage_settlement?.cost.status === 'estimated') {
        assert.equal(completion.usage_settlement.cost.amount_usd, 0.002)
        assert.equal(completion.usage_settlement.cost.method, 'exa_lite_estimated_cost_dollars')
      }
      assert.equal(events.filter((e) => e.kind === 'passage_recorded').length, 0)
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('preserves receipt on cancelled source_search after provider returned billing metadata', async () => {
    const { createCombinedResearchRegistries } = await import('../../registry/reviewedBAdapterIntegration.js')
    const { resolveDiscoveryAdapterForMission } = await import('../../registry/missionAdapterResolution.js')
    const { runAdmittedRetrievalIteration } = await import('../../engine/researchRetrievalLoop.js')

    const mission = loadMission()
    const plan = loadPlan(mission.mission_id)
    const abort = new AbortController()
    const searchProvider: AdmittedSourceSearchProvider = {
      async search(request: SourceSearchRequest) {
        if (!request.sourceClasses.includes('web')) {
          return { operationId: request.operationId, status: 'ok', hits: [] }
        }
        abort.abort()
        return {
          operationId: request.operationId,
          status: 'ok',
          hits: [],
          receipt: billedEmptyReceipt('exa-req-cancel-accounting', 0.001),
        }
      },
    }
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider,
      admittedGet: async () => ({
        ok: true,
        status: 200,
        contentType: 'text/html',
        buffer: Buffer.from('<html></html>'),
        bytesReceived: 20,
        truncated: false,
        requestedUrl: 'https://example.invalid/x',
        finalUrl: 'https://example.invalid/x',
        redirectChain: ['https://example.invalid/x'],
        transportCoding: null,
      }),
    })

    const dir = await mkdtemp(join(tmpdir(), 'receipt-cancel-accounting-'))
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
      const registries = await createCombinedResearchRegistries()
      const adapter = resolveDiscoveryAdapterForMission(mission, registries)
      assert.ok(adapter)

      const searchOperationId = 'bounded-cancel-search'
      await assert.rejects(
        () =>
          runAdmittedRetrievalIteration({
            session: { mission, handle, activePlanRevisionId: plan.plan_revision_id },
            store,
            access,
            adapter,
            registries,
            activePlan: plan,
            discoverQuery: 'abort after search',
            searchOperationId,
            searchAttemptId: 'bounded-cancel-search-att',
            fetchOperationId: 'bounded-cancel-fetch',
            fetchAttemptId: 'bounded-cancel-fetch-att',
            dispatchedAt: FIXED_NOW,
            signal: abort.signal,
            now: () => FIXED_NOW,
          }),
        /cancelled/,
      )

      const completionEvents = await store.listEvents(mission.mission_id)
      const completionBeforeTerminal = searchCompletion(completionEvents, searchOperationId)
      assert.equal(completionBeforeTerminal?.settlement, 'cancelled')
      assert.equal(
        completionBeforeTerminal?.search_provider_receipt?.exa_lite?.request_id,
        'exa-req-cancel-accounting',
      )
      assert.equal(completionBeforeTerminal?.usage_settlement?.cost.status, 'estimated')

      const appended = await finalizeOwnerResearchRunCancellation({
        store,
        mission,
        now: () => FIXED_NOW,
      })
      assert.equal(appended.status, 'terminal_appended')
      const duplicate = await finalizeOwnerResearchRunCancellation({
        store,
        mission,
        now: () => FIXED_NOW,
      })
      assert.equal(duplicate.status, 'not_appended')
      assert.equal(duplicate.reason, 'terminal_already_present')
      await store.close()

      const reopened = await DurableResearchStore.open(dir)
      const events = await reopened.listEvents(mission.mission_id)
      const completion = searchCompletion(events, searchOperationId)
      assert.equal(completion?.settlement, 'cancelled')
      assert.equal(
        completion?.search_provider_receipt?.exa_lite?.request_id,
        'exa-req-cancel-accounting',
      )
      assert.equal(completion?.usage_settlement?.cost.status, 'estimated')
      assert.equal(events.filter((e) => e.kind === 'passage_recorded').length, 0)
      const report = terminalReportFromEvents(events)
      assert.equal(report?.terminal_state, 'cancelled')
      assert.ok(
        report?.limitations.some((l) => l.includes('exa_participation:exa_primary_empty_billed')),
      )
      assert.ok(report?.limitations.some((l) => l.includes('exa-req-cancel-accounting')))
      assert.ok(
        report?.limitations.some((l) => l.includes('exa_lite_provider_estimated_cost_usd:0.001')),
      )
      assert.ok(
        report?.limitations.some((l) =>
          l.includes('search_provider_degraded:exa_lite->duckduckgo_html_fallback'),
        ),
      )
      assert.equal(events.filter((e) => e.kind === 'terminal_receipt').length, 1)
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('finalizeFailedOwnerResearchPass includes durable search receipt limitations on failed terminal report', async () => {
    const { createCombinedResearchRegistries } = await import('../../registry/reviewedBAdapterIntegration.js')
    const { resolveDiscoveryAdapterForMission } = await import('../../registry/missionAdapterResolution.js')
    const { runAdmittedRetrievalIteration } = await import('../../engine/researchRetrievalLoop.js')

    const mission = loadMission()
    const plan = loadPlan(mission.mission_id)
    const searchProvider: AdmittedSourceSearchProvider = {
      async search(request: SourceSearchRequest) {
        if (!request.sourceClasses.includes('web')) {
          return { operationId: request.operationId, status: 'ok', hits: [] }
        }
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'network_error',
          message: 'configured search provider transport failed',
          receipt: billedEmptyReceipt('exa-req-failed-terminal', 0.0015),
        }
      },
    }
    const access = createGovernedSourceAccessPort({ mission, searchProvider })

    const dir = await mkdtemp(join(tmpdir(), 'receipt-failed-terminal-'))
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
      const registries = await createCombinedResearchRegistries()
      const adapter = resolveDiscoveryAdapterForMission(mission, registries)
      assert.ok(adapter)

      try {
        await runAdmittedRetrievalIteration({
          session: { mission, handle, activePlanRevisionId: plan.plan_revision_id },
          store,
          access,
          adapter,
          registries,
          activePlan: plan,
          discoverQuery: 'fail',
          searchOperationId: 'bounded-failed-terminal-search',
          searchAttemptId: 'bounded-failed-terminal-search-att',
          fetchOperationId: 'bounded-failed-terminal-fetch',
          fetchAttemptId: 'bounded-failed-terminal-fetch-att',
          dispatchedAt: FIXED_NOW,
          signal: new AbortController().signal,
          now: () => FIXED_NOW,
        })
      } catch {
        // expected retrieval failure after durable source_search completion
      }

      const appended = await finalizeFailedOwnerResearchPass({
        store,
        mission,
        planRevisionId: plan.plan_revision_id,
        failurePhase: 'retrieval',
        message: 'configured search provider transport failed',
        now: () => FIXED_NOW,
      })
      assert.equal(appended, true)
      await store.close()

      const reopened = await DurableResearchStore.open(dir)
      const events = await reopened.listEvents(mission.mission_id)
      const report = terminalReportFromEvents(events)
      assert.equal(report?.terminal_state, 'failed')
      assert.ok(
        report?.limitations.some((l) => l.includes('exa_participation:exa_primary_empty_billed')),
      )
      assert.ok(
        report?.limitations.some((l) => l.includes('exa-req-failed-terminal')),
      )
      assert.ok(
        report?.limitations.some((l) => l.includes('exa_lite_provider_estimated_cost_usd:0.0015')),
      )
      assert.ok(
        !report?.limitations.some((l) => l.includes('invoiced')),
        'estimated provider metadata must not be labeled invoiced',
      )
      await reopened.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
