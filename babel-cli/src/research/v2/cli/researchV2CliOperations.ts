import { mkdir } from 'node:fs/promises'
import type { ResearchReportV2 } from '../contracts/plan.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import { openAdmittedInspectStore } from '../control/researchStoreAdmission.js'
import { ResearchEngineSession } from '../engine/researchEngineSession.js'
import {
  exampleMissionWriteContext,
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../fixtures/exampleMission.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import type { ResearchModelPort } from '../ports/researchModelPort.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'
import type { ResumableTerminalState } from '../contracts/storeLifecycle.js'
import { loadResearchMissionFromFile } from './loadResearchMissionFile.js'
import {
  missionFromStoreEvents,
  runResearchV2EnginePassOnOwner,
  runResearchV2MissionWithOwnerSession,
} from './researchV2MissionRun.js'

export async function runResearchV2ProductionRun(options: {
  store: string
  missionFile: string
  discoverQuery?: string
  print: (payload: unknown, human: string) => void
  model?: ResearchModelPort
}): Promise<void> {
  const mission = await loadResearchMissionFromFile(options.missionFile)
  const discoverQuery =
    options.discoverQuery?.trim() ||
    mission.primary_question.split(/\s+/).slice(0, 8).join(' ')
  const result = await runResearchV2MissionWithOwnerSession({
    storeDirectory: options.store,
    mission,
    discoverQuery,
    ...(options.model ? { model: options.model } : {}),
  })
  const payload = {
    ...result,
    store_directory: options.store,
    discover_query: discoverQuery,
    note: 'Production mission run with governed adapters and durable store persistence.',
  }
  options.print(payload, JSON.stringify(payload, null, 2))
}

export async function runResearchV2OfflineRun(options: {
  store: string
  json: boolean
  print: (payload: unknown, human: string) => void
}): Promise<void> {
  const result = await runResearchV2MissionWithOwnerSession({
    storeDirectory: options.store,
    mission: exampleTechnicalMissionFixture,
    discoverQuery: 'RESEARCH_CONTRACT',
    injectedOffline: true,
    planRevisionId: 'plan-cli-run-001',
  })
  const payload = {
    mode: 'offline_injected_run',
    live_api: false,
    store_directory: options.store,
    session_id: result.session_id,
    mission_id: exampleTechnicalMissionFixture.mission_id,
    plan_revision_id: result.plan_revision_id,
    passage_ids: result.passage_ids,
    finding_ids: result.finding_ids,
    terminal_report_emitted: result.terminal_report_emitted,
    maps_to_acceptance_scenario: 'T-L1',
    note: 'Offline injected transport — not a canonical live acceptance execution.',
  }
  options.print(payload, JSON.stringify(payload, null, 2))
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
  missionFile?: string
  discoverQuery?: string
  continueRun?: boolean
  injectedOffline?: boolean
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

    const cancelController = new AbortController()
    const cancelWatcher = owner.watchExternalCancelRequests(cancelController)
    const signal = AbortSignal.any([cancelController.signal])

    let runResult: Awaited<ReturnType<typeof runResearchV2EnginePassOnOwner>> | undefined
    const shouldContinue = options.continueRun !== false
    if (shouldContinue) {
      let mission: ResearchMissionV2 | null = null
      if (options.missionFile) {
        mission = await loadResearchMissionFromFile(options.missionFile)
      } else {
        const inspect = await openAdmittedInspectStore(options.store)
        const events = await inspect.listEvents(options.missionId)
        mission = missionFromStoreEvents(events)
      }
      if (!mission) {
        throw new Error('resume continuation requires mission.json via --mission-file or mission_created in store')
      }
      const discoverQuery =
        options.discoverQuery?.trim() ||
        mission.primary_question.split(/\s+/).slice(0, 8).join(' ')
      runResult = await runResearchV2EnginePassOnOwner({
        owner,
        mission,
        handle,
        discoverQuery,
        ...(options.model ? { model: options.model } : {}),
        injectedOffline: options.injectedOffline === true,
        planRevisionId: `${options.planRevisionId}-continued`,
        signal,
      })
    }
    cancelWatcher.stop()

    const payload = {
      store_directory: options.store,
      mission_id: options.missionId,
      writer_generation: handle.writer_generation,
      continuation_run: runResult ?? null,
      maps_to_acceptance_scenario: 'X-L1',
      note: shouldContinue
        ? 'Resume admitted and engine pass continued on persisted store.'
        : 'Resume admission only — pass --no-continue-run to skip engine continuation.',
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
