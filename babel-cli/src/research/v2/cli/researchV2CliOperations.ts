import { mkdir } from 'node:fs/promises'
import type { ResearchReportV2 } from '../contracts/plan.js'
import { createGovernedSourceAccessForMission } from '../access/createGovernedSourceAccess.js'
import { openAdmittedInspectStore, openAdmittedOwnerStore } from '../control/researchStoreAdmission.js'
import { ResearchEngineSession } from '../engine/researchEngineSession.js'
import { runAdmittedResearchEndToEndPass } from '../engine/researchEndToEndPass.js'
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
import type { ResearchModelPort } from '../ports/researchModelPort.js'
import { createTechnicalResearchRegistries } from '../registry/frozenRegistries.js'
import { resolveDiscoveryAdapterForMission } from '../registry/missionAdapterResolution.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'
import type { ResumableTerminalState } from '../contracts/storeLifecycle.js'

const CLI_PLAN_REVISION_ID = 'plan-cli-run-001'

function fixtureModelForOfflineRun(): ResearchModelPort {
  const fixture = new FixtureResearchModelBridge()
  fixture.scriptOutput('cli-run-plan', {
    kind: 'plan_questions',
    questions: [{ text: 'What does the pinned contracts file export?', importance: 'high' }],
  })
  return {
    async invokeStructured(request) {
      if (request.kind === 'extract_findings') {
        const passageIds = (request.input.passage_ids as string[]) ?? []
        fixture.scriptOutput(request.operationId, {
          kind: 'extract_findings',
          findings: [
            {
              assertion_text: 'The file exports a RESEARCH_CONTRACT constant.',
              assertion_kind: 'source_observation',
              passage_ids: passageIds,
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
              status: 'insufficient',
              rationale: 'Offline CLI run — insufficient for a live acceptance decision.',
            },
          ],
        })
      }
      if (request.kind === 'synthesize_report') {
        fixture.scriptOutput(request.operationId, {
          kind: 'synthesize_report',
          answer_summary: 'Offline injected run produced a partial cited report.',
          stopping_reason: 'insufficient_semantic_support',
        })
      }
      return fixture.invokeStructured(request)
    },
  }
}

function governedTechnicalAccess() {
  const { port } = createGovernedSourceAccessForMission({
    mission: exampleTechnicalMissionFixture,
    searchMode: 'declared_index_corpus',
    corpusIndex: searchIndexForTechnicalMission(exampleTechnicalMissionFixture),
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
    }),
  })
  return port
}

export async function runResearchV2OfflineRun(options: {
  store: string
  json: boolean
  print: (payload: unknown, human: string) => void
}): Promise<void> {
  await mkdir(options.store, { recursive: true })
  let owner: Awaited<ReturnType<typeof openAdmittedOwnerStore>> | undefined
  try {
    owner = await openAdmittedOwnerStore(options.store)
    const handle = await owner.store.appendMission(exampleTechnicalMissionFixture)
    const session = { mission: exampleTechnicalMissionFixture, handle }
    const registries = createTechnicalResearchRegistries()
    const adapter = resolveDiscoveryAdapterForMission(exampleTechnicalMissionFixture, registries)
    if (!adapter) {
      throw new Error('no discovery adapter for technical mission')
    }
    const result = await runAdmittedResearchEndToEndPass({
      session,
      store: owner.store,
      model: fixtureModelForOfflineRun(),
      access: governedTechnicalAccess(),
      adapter,
      registries,
      discoverQuery: 'RESEARCH_CONTRACT',
      planOperationId: 'cli-run-plan',
      planAttemptId: 'cli-run-plan-att',
      planRevisionId: CLI_PLAN_REVISION_ID,
      retrievalSearchOperationId: 'cli-run-search',
      retrievalSearchAttemptId: 'cli-run-search-att',
      retrievalFetchOperationId: 'cli-run-fetch',
      retrievalFetchAttemptId: 'cli-run-fetch-att',
      extractOperationId: 'cli-run-extract',
      extractAttemptId: 'cli-run-extract-att',
      reviewOperationId: 'cli-run-review',
      reviewAttemptId: 'cli-run-review-att',
      synthesizeOperationId: 'cli-run-synth',
      synthesizeAttemptId: 'cli-run-synth-att',
      dispatchedAt: new Date().toISOString(),
      signal: new AbortController().signal,
    })
    const payload = {
      mode: 'offline_injected_run',
      live_api: false,
      store_directory: options.store,
      session_id: owner.sessionId,
      mission_id: exampleTechnicalMissionFixture.mission_id,
      plan_revision_id: result.planRevisionId,
      passage_ids: result.passageIds,
      finding_ids: result.findingIds,
      terminal_report_emitted: result.terminalReportEmitted,
      maps_to_acceptance_scenario: 'T-L1',
      note: 'Offline injected transport — not a canonical live acceptance execution.',
    }
    options.print(payload, JSON.stringify(payload, null, 2))
  } finally {
    await owner?.close()
  }
}

export function terminalReportFromEvents(
  events: readonly ResearchStoreEvent[],
): ResearchReportV2 | null {
  const terminals = events.filter((e) => e.kind === 'terminal_receipt')
  if (terminals.length === 0) return null
  const last = terminals[terminals.length - 1]!
  return (last.payload as { report: ResearchReportV2 }).report
}

export async function inspectResearchV2Store(options: {
  store: string
  missionId: string
  print: (payload: unknown, human: string) => void
}): Promise<void> {
  const inspect = await openAdmittedInspectStore(options.store)
  const events = await inspect.listEvents(options.missionId)
  const report = terminalReportFromEvents(events)
  const payload = {
    store_directory: options.store,
    mission_id: options.missionId,
    session_control: inspect.sessionControl,
    event_kinds: [...new Set(events.map((e) => e.kind))].sort(),
    terminal_receipt_count: events.filter((e) => e.kind === 'terminal_receipt').length,
    continuation_resumed_count: events.filter((e) => e.kind === 'research_continuation_resumed').length,
    report,
  }
  options.print(payload, JSON.stringify(payload, null, 2))
}

export async function reportResearchV2Store(options: {
  store: string
  missionId: string
  print: (payload: unknown, human: string) => void
}): Promise<void> {
  const inspect = await openAdmittedInspectStore(options.store)
  const events = await inspect.listEvents(options.missionId)
  const report = terminalReportFromEvents(events)
  if (!report) {
    throw new Error('no terminal_receipt report found for mission')
  }
  const payload = { store_directory: options.store, mission_id: options.missionId, report }
  options.print(payload, JSON.stringify(payload, null, 2))
}

export async function cancelResearchV2OwnerSession(options: {
  store: string
  sessionId: string
  print: (payload: unknown, human: string) => void
}): Promise<void> {
  const request = await ResearchEngineSession.submitExternalCancelRequest(
    options.store,
    options.sessionId,
  )
  const payload = {
    store_directory: options.store,
    cancel_request: request,
    note: 'Cancel request written; owner session must watch research-store.cancel-request.json',
  }
  options.print(payload, JSON.stringify(payload, null, 2))
}

export async function resumeResearchV2Continuation(options: {
  store: string
  missionId: string
  writerGeneration: number
  planRevisionId: string
  terminalState: ResumableTerminalState
  hostAuthorizationRef: string
  print: (payload: unknown, human: string) => void
  model?: ResearchModelPort
}): Promise<void> {
  const model = options.model ?? new FixtureResearchModelBridge()
  let owner: ResearchEngineSession | undefined
  try {
    owner = await ResearchEngineSession.openOwner({ storeDirectory: options.store, model })
    const handle = await owner.resumeResearchContinuation({
      mission_id: options.missionId,
      expected_writer_generation: options.writerGeneration,
      host_authorization_ref: options.hostAuthorizationRef,
      acknowledged_plan_revision_id: options.planRevisionId,
      acknowledged_terminal_state: options.terminalState,
    })
    const payload = {
      store_directory: options.store,
      mission_id: options.missionId,
      writer_generation: handle.writer_generation,
      maps_to_acceptance_scenario: 'X-L1',
      note: 'Resume admission only — host must continue engine work after resume.',
    }
    options.print(payload, JSON.stringify(payload, null, 2))
  } finally {
    await owner?.close()
  }
}

export async function runResearchV2CancelResumeJourney(options: {
  store: string
  print: (payload: unknown, human: string) => void
}): Promise<void> {
  await mkdir(options.store, { recursive: true })
  const model = new FixtureResearchModelBridge()
  let owner = await ResearchEngineSession.openOwner({ storeDirectory: options.store, model })
  try {
    const handle = await owner.appendMission(exampleTechnicalMissionFixture)
    const acquired = await owner.acquireWriterOwnership({
      mission_id: handle.mission_id,
      expected_writer_generation: handle.writer_generation,
    })
    const ctx = {
      ...exampleMissionWriteContext,
      mission_id: acquired.mission_id,
      writer_generation: acquired.writer_generation,
      plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
    }
    await owner.store.appendPlanRevision(ctx, examplePlanRevisionFixture)
    await owner.appendTerminalReport(ctx, {
      mission_id: ctx.mission_id,
      plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
      terminal_state: 'cancelled',
      answer_summary: 'cancelled for CLI X-L1 journey',
      unanswered_questions: [],
      coverage_notes: 'cli cancel/resume',
      limitations: [],
      source_cutoff: 'unknown',
      acceptance_state: 'not_accepted',
      stopping_reason: 'user_cancel',
      finding_ids: [],
      citation_passage_ids: [],
      generated_at: new Date().toISOString(),
    })
    const generationBefore = ctx.writer_generation
    await owner.close()

    owner = await ResearchEngineSession.openOwner({ storeDirectory: options.store, model })
    const resumed = await owner.resumeResearchContinuation({
      mission_id: ctx.mission_id,
      expected_writer_generation: generationBefore,
      host_authorization_ref: 'cli-host/x-l1-resume',
      acknowledged_plan_revision_id: examplePlanRevisionFixture.plan_revision_id,
      acknowledged_terminal_state: 'cancelled',
    })
    const inspect = await ResearchEngineSession.openInspect(options.store)
    const events = await inspect.listEvents(ctx.mission_id)
    const payload = {
      mode: 'offline_cancel_resume_once',
      store_directory: options.store,
      mission_id: ctx.mission_id,
      resumed_writer_generation: resumed.writer_generation,
      terminal_receipt_count: events.filter((e) => e.kind === 'terminal_receipt').length,
      continuation_resumed_count: events.filter((e) => e.kind === 'research_continuation_resumed').length,
      maps_to_acceptance_scenario: 'X-L1',
    }
    options.print(payload, JSON.stringify(payload, null, 2))
    await owner.close()
  } finally {
    await owner?.close().catch(() => undefined)
  }
}
