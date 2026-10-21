import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import { createGovernedSourceAccessPort } from '../access/governedSourceAccessPort.js'
import { createMissionProductionSearchProvider } from '../access/createMissionProductionSearchProvider.js'
import type { FetchPinnedRepositoryTree } from '../access/pinnedRepositoryFileSearchProvider.js'
import { createGovernedSourceAccessForMission } from '../access/createGovernedSourceAccess.js'
import type { BabelWebSearchTransport } from '../access/babelConfiguredWebSearch.js'
import { assertResearchV2LiveApiEnabled } from '../liveApiGate.js'
import { ResearchEngineSession } from '../engine/researchEngineSession.js'
import { runAdmittedResearchEndToEndPass } from '../engine/researchEndToEndPass.js'
import { createLiveResearchModelPort } from '../model/researchV2LiveModelPort.js'
import { resolveLiveResearchModelConfigForCli } from '../model/researchV2ModelRoute.js'
import type { ResearchModelPort } from '../ports/researchModelPort.js'
import type { ResearchStoreMissionHandle } from '../ports/researchStore.js'
import { createTechnicalResearchRegistries } from '../registry/frozenRegistries.js'
import { createCombinedResearchRegistries } from '../registry/reviewedBAdapterIntegration.js'
import {
  resolveDiscoveryAdapterForMission,
  type MissionRegistryBundle,
} from '../registry/missionAdapterResolution.js'
import { GENERAL_PROFILE_ID } from '../profiles/general/generalProfileDefinition.js'
import { searchIndexForTechnicalMission } from '../fixtures/technicalSearchIndex.js'
import {
  technicalRepositoryCorpusBody,
  technicalRepositoryCorpusFinalUrl,
} from '../fixtures/technicalRepositoryCorpus.js'
import { finalizeCancelledOwnerRunAndClose } from '../engine/ownerSessionCancellationFinalize.js'
import { finalizeFailedOwnerResearchPass } from '../engine/finalizeFailedOwnerResearchPass.js'
import { fixtureModelForOfflineRun } from './researchV2FixtureRunModel.js'

export interface ResearchV2MissionRunResult {
  session_id: string
  mission_id: string
  plan_revision_id: string
  passage_ids: string[]
  finding_ids: string[]
  terminal_report_emitted: boolean
  live_api: boolean
  mode: 'production_mission_run' | 'injected_offline_run'
}

export interface ResearchV2MissionRunOptions {
  storeDirectory: string
  mission: ResearchMissionV2
  discoverQuery: string
  planRevisionId?: string
  /** When continuing after resume, the store's current active plan revision id. */
  activePlanRevisionId?: string
  /** When true, uses fixture corpus + fixture model (deterministic tests only). */
  injectedOffline?: boolean
  model?: ResearchModelPort
  signal?: AbortSignal
  webSearchTransport?: BabelWebSearchTransport
  fetchRepositoryTree?: FetchPinnedRepositoryTree
}

async function resolveRegistries(mission: ResearchMissionV2): Promise<MissionRegistryBundle> {
  if (mission.profile_id === GENERAL_PROFILE_ID) {
    return createCombinedResearchRegistries()
  }
  return createTechnicalResearchRegistries()
}

function resolveProductionModel(model?: ResearchModelPort): ResearchModelPort {
  if (model) return model
  assertResearchV2LiveApiEnabled()
  const { config } = resolveLiveResearchModelConfigForCli()
  return createLiveResearchModelPort(config)
}

function productionAccessPort(
  mission: ResearchMissionV2,
  options: Pick<ResearchV2MissionRunOptions, 'webSearchTransport' | 'fetchRepositoryTree'>,
) {
  const searchProvider = createMissionProductionSearchProvider({
    mission,
    ...(options.webSearchTransport ? { webSearchTransport: options.webSearchTransport } : {}),
    ...(options.fetchRepositoryTree ? { fetchRepositoryTree: options.fetchRepositoryTree } : {}),
  })
  return createGovernedSourceAccessPort({
    mission,
    searchProvider,
  })
}

function injectedOfflineAccess(mission: ResearchMissionV2) {
  const { port } = createGovernedSourceAccessForMission({
    mission,
    searchMode: 'declared_index_corpus',
    corpusIndex: searchIndexForTechnicalMission(mission),
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

/**
 * Offline CLI/test operation identity: writer generation + plan/run id (hashed).
 * Plan-id-only suffixes were truncated and reused across generations, breaking snapshot integrity.
 */
export function offlineRunOperationSuffix(writerGeneration: number, runSuffix: string): string {
  const normalized = runSuffix.replace(/[^a-zA-Z0-9-]/g, '-')
  const digest = createHash('sha256')
    .update(`${writerGeneration}\0${normalized}`)
    .digest('hex')
    .slice(0, 12)
  return `wg${writerGeneration}-${digest}`
}

function offlineOperationIds(writerGeneration: number, runSuffix: string) {
  const s = offlineRunOperationSuffix(writerGeneration, runSuffix)
  return {
    planOperationId: `cli-run-plan-${s}`,
    planAttemptId: `cli-run-plan-att-${s}`,
    retrievalSearchOperationId: `cli-run-search-${s}`,
    retrievalSearchAttemptId: `cli-run-search-att-${s}`,
    retrievalFetchOperationId: `cli-run-fetch-${s}`,
    retrievalFetchAttemptId: `cli-run-fetch-att-${s}`,
    extractOperationId: `cli-run-extract-${s}`,
    extractAttemptId: `cli-run-extract-att-${s}`,
    reviewOperationId: `cli-run-review-${s}`,
    reviewAttemptId: `cli-run-review-att-${s}`,
    synthesizeOperationId: `cli-run-synth-${s}`,
    synthesizeAttemptId: `cli-run-synth-att-${s}`,
  }
}

function productionOperationIds(writerGeneration: number, runToken: string) {
  const s = `wg${writerGeneration}-${runToken}`
  return {
    planOperationId: `cli-run-plan-${s}`,
    planAttemptId: `cli-run-plan-att-${s}`,
    retrievalSearchOperationId: `cli-run-search-${s}`,
    retrievalSearchAttemptId: `cli-run-search-att-${s}`,
    retrievalFetchOperationId: `cli-run-fetch-${s}`,
    retrievalFetchAttemptId: `cli-run-fetch-att-${s}`,
    extractOperationId: `cli-run-extract-${s}`,
    extractAttemptId: `cli-run-extract-att-${s}`,
    reviewOperationId: `cli-run-review-${s}`,
    reviewAttemptId: `cli-run-review-att-${s}`,
    synthesizeOperationId: `cli-run-synth-${s}`,
    synthesizeAttemptId: `cli-run-synth-att-${s}`,
  }
}

export async function runResearchV2EnginePassOnOwner(options: {
  owner: ResearchEngineSession
  mission: ResearchMissionV2
  handle: ResearchStoreMissionHandle
  discoverQuery: string
  planRevisionId?: string
  activePlanRevisionId?: string
  injectedOffline?: boolean
  model?: ResearchModelPort
  signal?: AbortSignal
  webSearchTransport?: BabelWebSearchTransport
  fetchRepositoryTree?: FetchPinnedRepositoryTree
}): Promise<Omit<ResearchV2MissionRunResult, 'session_id'>> {
  const injectedOffline = options.injectedOffline === true
  const resolvedModel = injectedOffline
    ? (options.model ?? fixtureModelForOfflineRun())
    : resolveProductionModel(options.model)

  const registries = await resolveRegistries(options.mission)
  const adapter = resolveDiscoveryAdapterForMission(options.mission, registries)
  if (!adapter) {
    throw new Error(`no discovery adapter for mission profile ${options.mission.profile_id}`)
  }
  const access = injectedOffline
    ? injectedOfflineAccess(options.mission)
    : productionAccessPort(options.mission, options)

  const writerGeneration = options.handle.writer_generation
  const runId = injectedOffline
    ? (options.planRevisionId ?? options.activePlanRevisionId ?? 'offline')
    : randomUUID().slice(0, 8)
  const op = injectedOffline
    ? offlineOperationIds(writerGeneration, String(runId))
    : productionOperationIds(writerGeneration, runId)

  const planRevisionId =
    options.planRevisionId ?? (injectedOffline ? 'plan-cli-run-001' : `plan-${randomUUID()}`)
  const signal = options.signal ?? new AbortController().signal

  let terminalReportEmitted = false
  try {
    const result = await runAdmittedResearchEndToEndPass({
      session: {
        mission: options.mission,
        handle: options.handle,
        ...(options.activePlanRevisionId ? { activePlanRevisionId: options.activePlanRevisionId } : {}),
      },
      store: options.owner.store,
      model: resolvedModel,
      access,
      adapter,
      registries,
      discoverQuery: options.discoverQuery,
      planOperationId: op.planOperationId,
      planAttemptId: op.planAttemptId,
      planRevisionId,
      retrievalSearchOperationId: op.retrievalSearchOperationId,
      retrievalSearchAttemptId: op.retrievalSearchAttemptId,
      retrievalFetchOperationId: op.retrievalFetchOperationId,
      retrievalFetchAttemptId: op.retrievalFetchAttemptId,
      extractOperationId: op.extractOperationId,
      extractAttemptId: op.extractAttemptId,
      reviewOperationId: op.reviewOperationId,
      reviewAttemptId: op.reviewAttemptId,
      synthesizeOperationId: op.synthesizeOperationId,
      synthesizeAttemptId: op.synthesizeAttemptId,
      dispatchedAt: new Date().toISOString(),
      signal,
    })
    terminalReportEmitted = result.terminalReportEmitted
    return {
      mission_id: options.mission.mission_id,
      plan_revision_id: result.planRevisionId,
      passage_ids: result.passageIds,
      finding_ids: result.findingIds,
      terminal_report_emitted: terminalReportEmitted,
      live_api: !injectedOffline,
      mode: injectedOffline ? 'injected_offline_run' : 'production_mission_run',
    }
  } catch (err: unknown) {
    if (!signal.aborted) {
      const message = err instanceof Error ? err.message : String(err)
      const appended = await finalizeFailedOwnerResearchPass({
        store: options.owner.store,
        mission: options.mission,
        planRevisionId,
        failurePhase: 'admitted_research_pass',
        message,
      })
      if (appended) {
        terminalReportEmitted = true
      }
    }
    throw err
  }
}

export async function runResearchV2MissionWithOwnerSession(
  options: ResearchV2MissionRunOptions,
): Promise<ResearchV2MissionRunResult> {
  await mkdir(options.storeDirectory, { recursive: true })
  const injectedOffline = options.injectedOffline === true
  const resolvedModel = injectedOffline
    ? (options.model ?? fixtureModelForOfflineRun())
    : resolveProductionModel(options.model)

  const cancelController = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, cancelController.signal])
    : cancelController.signal

  let owner: ResearchEngineSession | undefined
  let cancelWatcher: { stop(): void } | undefined
  let missionAppended = false
  try {
    owner = await ResearchEngineSession.openOwner({
      storeDirectory: options.storeDirectory,
      model: resolvedModel,
    })
    cancelWatcher = owner.watchExternalCancelRequests(cancelController)

    const handle = await owner.appendMission(options.mission)
    missionAppended = true
    const pass = await runResearchV2EnginePassOnOwner({
      owner,
      mission: options.mission,
      handle,
      discoverQuery: options.discoverQuery,
      injectedOffline,
      signal,
      ...(options.planRevisionId ? { planRevisionId: options.planRevisionId } : {}),
      ...(options.activePlanRevisionId ? { activePlanRevisionId: options.activePlanRevisionId } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.webSearchTransport ? { webSearchTransport: options.webSearchTransport } : {}),
      ...(options.fetchRepositoryTree ? { fetchRepositoryTree: options.fetchRepositoryTree } : {}),
    })
    return {
      session_id: owner.sessionId,
      ...pass,
    }
  } finally {
    cancelWatcher?.stop()
    await finalizeCancelledOwnerRunAndClose({
      owner,
      mission: options.mission,
      missionAppended,
      signal,
    })
  }
}

export function missionFromStoreEvents(
  events: readonly { kind: string; payload: unknown }[],
): ResearchMissionV2 | null {
  const created = events.find((e) => e.kind === 'mission_created')
  if (!created) return null
  return (created.payload as { mission: ResearchMissionV2 }).mission
}
