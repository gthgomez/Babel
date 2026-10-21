/**
 * B reciprocal lifecycle proof against merged A #406 engine (9d97448a): durable store,
 * injected model/transport (general adapters), real owner cancel watcher + finalize path.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  GeneralMissionBriefSchema,
  normalizeGeneralMissionBrief,
} from '../../contracts/normalization.js'
import type { ResearchMissionV2 } from '../../contracts/mission.js'
import type { SourceAccessPort, SourceFetchRequest, SourceSearchRequest } from '../../ports/sourceAccessPort.js'
import type { SourceRecord } from '../../contracts/sources.js'
import type { ResearchModelPort } from '../../ports/researchModelPort.js'
import type { ResearchStoreMissionHandle } from '../../ports/researchStore.js'
import { buildAdmittedContent } from '../../adapters/documents/testAdmittedFixtures.js'
import { resolveQuarantinedFixturePath } from '../../adapters/documents/quarantinePath.js'
import { openAdmittedInspectStore } from '../../control/researchStoreAdmission.js'
import { submitAdmittedOwnerCancelRequest } from '../../control/storeCancelRequest.js'
import { finalizeOwnerResearchRunCancellation } from '../../engine/finalizeOwnerResearchRunCancellation.js'
import { finalizeCancelledOwnerRunAndClose } from '../../engine/ownerSessionCancellationFinalize.js'
import { offlineRunOperationSuffix } from '../../cli/researchV2MissionRun.js'
import { runAdmittedResearchEndToEndPass } from '../../engine/researchEndToEndPass.js'
import { ResearchEngineSession } from '../../engine/researchEngineSession.js'
import { FixtureResearchModelBridge } from '../../model/fixtureModelBridge.js'
import { resolveDiscoveryAdapterForMission } from '../../registry/missionAdapterResolution.js'
import { createCombinedResearchRegistries } from '../../registry/reviewedBAdapterIntegration.js'

const here = dirname(fileURLToPath(import.meta.url))
const devCorpusRoot = join(here, 'fixtures/dev-corpus')
const pdfFixture = join(here, '../../adapters/documents/fixtures/two-page-sample.pdf')
const FIXED_NOW = '2026-10-21T06:10:00.000Z'

class BlockingUntilAbortModel implements ResearchModelPort {
  constructor(private readonly inner = new FixtureResearchModelBridge()) {}

  async invokeStructured(request: Parameters<ResearchModelPort['invokeStructured']>[0]) {
    await new Promise<void>((resolve) => {
      if (request.signal.aborted) {
        resolve()
        return
      }
      const onAbort = (): void => {
        request.signal.removeEventListener('abort', onAbort)
        resolve()
      }
      request.signal.addEventListener('abort', onAbort)
    })
    if (request.signal.aborted) {
      return {
        status: 'cancelled' as const,
        operationId: request.operationId,
        usageSettlement: { attempt_id: request.attemptId, cost: { status: 'unknown' as const } },
      }
    }
    return this.inner.invokeStructured(request)
  }
}

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
      hits: [{ source: entry.source, snippet: 'Nimbus plan', completeness: 'snippet' as const }],
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

function loadGeneralLifecycleMission(): ResearchMissionV2 {
  const brief = GeneralMissionBriefSchema.parse(
    JSON.parse(readFileSync(join(devCorpusRoot, 'G-DEV-01/mission.json'), 'utf8')),
  )
  return normalizeGeneralMissionBrief(brief, {
    mission_id: 'mission-g-dev-01-lifecycle-reciprocal',
    created_at: '2026-10-21T06:00:00.000Z',
    profile_version: '0.1.0-m0',
  })
}

function generalIntegrationAccess(): GeneralProfileIntegrationAccessPort {
  const htmlBytes = readFileSync(
    resolveQuarantinedFixturePath(devCorpusRoot, 'G-DEV-01/sources/plan-a.html'),
  )
  const pdfBytes = readFileSync(pdfFixture)
  return new GeneralProfileIntegrationAccessPort(
    {
      source: {
        source_id: 'src-gdev01-plan-a',
        kind: 'web',
        canonical_key: 'https://example.invalid/plan-a',
        observed_urls: ['https://example.invalid/plan-a'],
        title: 'Nimbus Plan A',
      },
      body: htmlBytes,
    },
    {
      source: {
        source_id: 'src-two-page-pdf',
        kind: 'document',
        canonical_key: 'fixture:two-page-pdf',
        observed_urls: ['https://example.invalid/two-page-sample.pdf'],
      },
      body: pdfBytes,
    },
  )
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

function generalFixtureModelForE2e(): ResearchModelPort {
  const fixture = new FixtureResearchModelBridge()
  return {
    async invokeStructured(request) {
      if (request.kind === 'plan_questions') {
        fixture.scriptOutput(request.operationId, {
          kind: 'plan_questions',
          questions: [{ text: 'Which Nimbus plan fits monthly storage?', importance: 'high' }],
        })
      }
      if (request.kind === 'extract_findings') {
        const passageIds = (request.input.passage_ids as string[]) ?? []
        fixture.scriptOutput(request.operationId, {
          kind: 'extract_findings',
          findings: [
            {
              assertion_text: 'Plan A advertises monthly retention terms.',
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
              rationale: 'Offline reciprocal — partial semantic support only.',
            },
          ],
        })
      }
      if (request.kind === 'synthesize_report') {
        fixture.scriptOutput(request.operationId, {
          kind: 'synthesize_report',
          answer_summary: 'Plan A monthly retention is evidenced from admitted HTML excerpts.',
          stopping_reason: 'insufficient_semantic_support',
        })
      }
      return fixture.invokeStructured(request)
    },
  }
}

async function runGeneralOfflinePassOnOwner(options: {
  owner: ResearchEngineSession
  mission: ResearchMissionV2
  handle: ResearchStoreMissionHandle
  discoverQuery: string
  planRevisionId: string
  activePlanRevisionId?: string
  signal: AbortSignal
  model: ResearchModelPort
}) {
  const registries = await createCombinedResearchRegistries()
  const adapter = resolveDiscoveryAdapterForMission(options.mission, registries)
  assert.ok(adapter)
  const access = generalIntegrationAccess()
  const op = offlineOperationIds(options.handle.writer_generation, options.planRevisionId)
  return runAdmittedResearchEndToEndPass({
    session: {
      mission: options.mission,
      handle: options.handle,
      ...(options.activePlanRevisionId ? { activePlanRevisionId: options.activePlanRevisionId } : {}),
    },
    store: options.owner.store,
    model: options.model,
    access,
    adapter,
    registries,
    discoverQuery: options.discoverQuery,
    planOperationId: op.planOperationId,
    planAttemptId: op.planAttemptId,
    planRevisionId: options.planRevisionId,
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
    dispatchedAt: FIXED_NOW,
    signal: options.signal,
    now: () => FIXED_NOW,
  })
}

async function runGeneralMissionWithOwnerSession(options: {
  storeDirectory: string
  mission: ResearchMissionV2
  discoverQuery: string
  planRevisionId: string
  model: ResearchModelPort
  signal?: AbortSignal
}) {
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
      model: options.model,
    })
    cancelWatcher = owner.watchExternalCancelRequests(cancelController)
    const handle = await owner.appendMission(options.mission)
    missionAppended = true
    const pass = await runGeneralOfflinePassOnOwner({
      owner,
      mission: options.mission,
      handle,
      discoverQuery: options.discoverQuery,
      planRevisionId: options.planRevisionId,
      signal,
      model: options.model,
    })
    return { session_id: owner.sessionId, owner, pass, cancelController }
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

function externalOperationIntents(events: readonly { kind: string; payload: unknown }[]) {
  return events
    .filter((e) => e.kind === 'external_operation_intent')
    .map((e) => (e.payload as { intent: { operation_id: string; attempt_id: string } }).intent)
}

function assertAllIntentsDistinct(
  intents: Array<{ operation_id: string; attempt_id: string }>,
  label: string,
): void {
  const operationIds = intents.map((i) => i.operation_id)
  const attemptIds = intents.map((i) => i.attempt_id)
  const uniqueOps = new Set(operationIds)
  const uniqueAttempts = new Set(attemptIds)
  assert.equal(
    uniqueOps.size,
    operationIds.length,
    `${label}: duplicate operation_id among durable intents (A defect: plan-suffix truncation); ops=${operationIds.join(',')}`,
  )
  assert.equal(
    uniqueAttempts.size,
    attemptIds.length,
    `${label}: duplicate attempt_id among durable intents (A defect: bind run/writer generation, not plan suffix); attempts=${attemptIds.join(',')}`,
  )
}

function terminalPlanRevisionId(events: readonly { kind: string; payload: unknown }[]): string {
  const terminal = events.find((e) => e.kind === 'terminal_receipt')
  assert.ok(terminal)
  return (terminal.payload as { report: { plan_revision_id: string } }).report.plan_revision_id
}

async function pollOwnerSessionId(storeDirectory: string): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 20))
    const inspect = await openAdmittedInspectStore(storeDirectory)
    const sessionId = inspect.sessionControl?.session_id ?? ''
    if (sessionId) return sessionId
  }
  return ''
}

/** Native9d second-resume: red @ 9d97448a (see review-artifacts/native9d-9d97448a-red-receipt.txt); green @ A 52a93b9c+ writer-generation repair. */
describe('general adapter lifecycle reciprocal (A integration, durable store, injected)', () => {
  it('owner watcher cancel → close/inspect → resume → new engine report (not manual terminal)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-general-lifecycle-'))
    const mission = loadGeneralLifecycleMission()
    const planId = 'plan-general-lifecycle-001'
    const model = new BlockingUntilAbortModel()
    try {
      const runPromise = runGeneralMissionWithOwnerSession({
        storeDirectory: dir,
        mission,
        discoverQuery: 'Nimbus Plan A monthly',
        planRevisionId: planId,
        model,
      })
      const sessionId = await pollOwnerSessionId(dir)
      assert.ok(sessionId.length > 0)
      await submitAdmittedOwnerCancelRequest(dir, sessionId)
      await assert.rejects(() => runPromise)

      const inspectAfterCancel = await ResearchEngineSession.openInspect(dir)
      const eventsAfterCancel = await inspectAfterCancel.listEvents(mission.mission_id)
      const terminalsAfterCancel = eventsAfterCancel.filter((e) => e.kind === 'terminal_receipt')
      assert.equal(terminalsAfterCancel.length, 1)
      assert.equal(
        (terminalsAfterCancel[0]!.payload as { report: { terminal_state: string } }).report
          .terminal_state,
        'cancelled',
      )
      assert.ok(
        eventsAfterCancel.some((e) => e.kind === 'external_operation_completed'),
        'model transport must settle via engine, not fabricated terminal only',
      )

      const cancelledPlan = (
        terminalsAfterCancel[0]!.payload as { report: { plan_revision_id: string } }
      ).report.plan_revision_id

      const owner = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: generalFixtureModelForE2e(),
      })
      const fence = owner.store.readMissionWriteFence(mission.mission_id)
      const resumed = await owner.resumeResearchContinuation({
        mission_id: mission.mission_id,
        expected_writer_generation: fence.writer_generation,
        host_authorization_ref: 'b-reciprocal/lifecycle-resume',
        acknowledged_plan_revision_id: cancelledPlan,
        acknowledged_terminal_state: 'cancelled',
      })
      const activePlanAfterResume = owner.store.readMissionWriteFence(mission.mission_id)
        .active_plan_revision_id
      assert.ok(activePlanAfterResume)
      const continuedPlanId = `${activePlanAfterResume}-continued`
      const pass = await runGeneralOfflinePassOnOwner({
        owner,
        mission,
        handle: resumed,
        discoverQuery: 'Nimbus Plan A monthly',
        activePlanRevisionId: activePlanAfterResume,
        planRevisionId: continuedPlanId,
        signal: new AbortController().signal,
        model: generalFixtureModelForE2e(),
      })
      assert.equal(pass.terminalReportEmitted, true)
      assert.ok(pass.passageIds.length >= 1)
      await owner.close()

      const inspectFinal = await ResearchEngineSession.openInspect(dir)
      const eventsFinal = await inspectFinal.listEvents(mission.mission_id)
      assert.equal(eventsFinal.filter((e) => e.kind === 'research_continuation_resumed').length, 1)
      const terminals = eventsFinal.filter((e) => e.kind === 'terminal_receipt')
      assert.equal(terminals.length, 2)
      const states = terminals.map(
        (e) => (e.payload as { report: { terminal_state: string } }).report.terminal_state,
      )
      assert.ok(states.includes('cancelled'))
      assert.ok(states.some((s) => s === 'complete' || s === 'partial'))
      const planAttempts = eventsFinal
        .filter((e) => e.kind === 'external_operation_intent')
        .map((e) => (e.payload as { intent: { attempt_id: string } }).intent.attempt_id)
      const uniquePlanAttempts = [
        ...new Set(planAttempts.filter((id) => id.includes('cli-run-plan-att'))),
      ]
      assert.ok(uniquePlanAttempts.length >= 2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('second resume after cancelled continuation: distinct durable ids + new engine report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-general-lifecycle-second-resume-'))
    const mission = loadGeneralLifecycleMission()
    const planId = 'plan-general-lifecycle-second-resume'
    const blocking = new BlockingUntilAbortModel()
    try {
      const firstRun = runGeneralMissionWithOwnerSession({
        storeDirectory: dir,
        mission,
        discoverQuery: 'Nimbus Plan A monthly',
        planRevisionId: planId,
        model: blocking,
      })
      const sessionId = await pollOwnerSessionId(dir)
      assert.ok(sessionId)
      await submitAdmittedOwnerCancelRequest(dir, sessionId)
      await assert.rejects(() => firstRun)

      let inspect = await ResearchEngineSession.openInspect(dir)
      let events = await inspect.listEvents(mission.mission_id)
      const cancelledPlan = terminalPlanRevisionId(events)

      let owner = await ResearchEngineSession.openOwner({ storeDirectory: dir, model: blocking })
      let fence = owner.store.readMissionWriteFence(mission.mission_id)
      let resumed = await owner.resumeResearchContinuation({
        mission_id: mission.mission_id,
        expected_writer_generation: fence.writer_generation,
        host_authorization_ref: 'b-reciprocal/lifecycle-resume-1',
        acknowledged_plan_revision_id: cancelledPlan,
        acknowledged_terminal_state: 'cancelled',
      })
      const activeAfterResume1 = owner.store.readMissionWriteFence(mission.mission_id)
        .active_plan_revision_id
      assert.ok(activeAfterResume1)
      const continuedPlanId = `${activeAfterResume1}-continued`
      const cancelController = new AbortController()
      const watcher = owner.watchExternalCancelRequests(cancelController)
      const continuationRun = runGeneralOfflinePassOnOwner({
        owner,
        mission,
        handle: resumed,
        discoverQuery: 'Nimbus Plan A monthly',
        activePlanRevisionId: activeAfterResume1,
        planRevisionId: continuedPlanId,
        signal: cancelController.signal,
        model: blocking,
      })
      await new Promise((r) => setTimeout(r, 40))
      cancelController.abort()
      watcher.stop()
      await assert.rejects(() => continuationRun)
      await finalizeOwnerResearchRunCancellation({ store: owner.store, mission, now: () => FIXED_NOW })
      await owner.close()

      inspect = await ResearchEngineSession.openInspect(dir)
      events = await inspect.listEvents(mission.mission_id)
      assert.equal(events.filter((e) => e.kind === 'terminal_receipt').length, 2)
      const cancelledPlanAfterCont = terminalPlanRevisionId(
        events.filter((e) => e.kind === 'terminal_receipt').slice(-1),
      )

      owner = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: generalFixtureModelForE2e(),
      })
      fence = owner.store.readMissionWriteFence(mission.mission_id)
      resumed = await owner.resumeResearchContinuation({
        mission_id: mission.mission_id,
        expected_writer_generation: fence.writer_generation,
        host_authorization_ref: 'b-reciprocal/lifecycle-resume-2',
        acknowledged_plan_revision_id: cancelledPlanAfterCont,
        acknowledged_terminal_state: 'cancelled',
      })
      const activeAfterResume2 = owner.store.readMissionWriteFence(mission.mission_id)
        .active_plan_revision_id
      assert.ok(activeAfterResume2)
      const continuedPlanIdAgain = `${activeAfterResume2}-continued`
      assert.equal(
        continuedPlanIdAgain,
        continuedPlanId,
        'expected same plan-derived suffix on repeated continuation (reproduces Native9d defect surface)',
      )
      const thirdPass = await runGeneralOfflinePassOnOwner({
        owner,
        mission,
        handle: resumed,
        discoverQuery: 'Nimbus Plan A monthly',
        activePlanRevisionId: activeAfterResume2,
        planRevisionId: continuedPlanIdAgain,
        signal: new AbortController().signal,
        model: generalFixtureModelForE2e(),
      })
      assert.equal(thirdPass.terminalReportEmitted, true)
      assert.ok(thirdPass.passageIds.length >= 1)
      await owner.close()

      const inspectFinal = await ResearchEngineSession.openInspect(dir)
      const eventsFinal = await inspectFinal.listEvents(mission.mission_id)
      assert.equal(eventsFinal.filter((e) => e.kind === 'research_continuation_resumed').length, 2)
      const terminals = eventsFinal.filter((e) => e.kind === 'terminal_receipt')
      assert.equal(terminals.length, 3)
      const states = terminals.map(
        (e) => (e.payload as { report: { terminal_state: string } }).report.terminal_state,
      )
      assert.equal(states.filter((s) => s === 'cancelled').length, 2)
      assert.ok(states.some((s) => s === 'complete' || s === 'partial'))
      const intents = externalOperationIntents(eventsFinal)
      assert.ok(intents.length >= 3, 'expected durable intents from three engine runs')
      assertAllIntentsDistinct(intents, 'three-run watcher lifecycle')
      const resumedEvents = eventsFinal.filter((e) => e.kind === 'research_continuation_resumed')
      const generations = resumedEvents.map(
        (e) =>
          (e.payload as { writer_generation: number; prior_writer_generation: number }).writer_generation,
      )
      assert.equal(new Set(generations).size, generations.length)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resume continuation: cancel during pending inference uses distinct attempt ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-general-lifecycle-cont-'))
    const mission = loadGeneralLifecycleMission()
    const planId = 'plan-general-lifecycle-cancel-resume'
    const blocking = new BlockingUntilAbortModel()
    try {
      const firstRun = runGeneralMissionWithOwnerSession({
        storeDirectory: dir,
        mission,
        discoverQuery: 'Nimbus Plan A monthly',
        planRevisionId: planId,
        model: blocking,
      })
      const sessionId = await pollOwnerSessionId(dir)
      assert.ok(sessionId)
      await submitAdmittedOwnerCancelRequest(dir, sessionId)
      await assert.rejects(() => firstRun)

      const inspectAfterFirst = await ResearchEngineSession.openInspect(dir)
      const eventsAfterFirst = await inspectAfterFirst.listEvents(mission.mission_id)
      const cancelledPlan = (
        eventsAfterFirst.find((e) => e.kind === 'terminal_receipt')!.payload as {
          report: { plan_revision_id: string }
        }
      ).report.plan_revision_id
      const firstAttempts = eventsAfterFirst
        .filter((e) => e.kind === 'external_operation_intent')
        .map((e) => (e.payload as { intent: { attempt_id: string } }).intent.attempt_id)

      const owner = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: blocking,
      })
      const fence = owner.store.readMissionWriteFence(mission.mission_id)
      const resumed = await owner.resumeResearchContinuation({
        mission_id: mission.mission_id,
        expected_writer_generation: fence.writer_generation,
        host_authorization_ref: 'b-reciprocal/lifecycle-cont-cancel',
        acknowledged_plan_revision_id: cancelledPlan,
        acknowledged_terminal_state: 'cancelled',
      })
      const continuedPlanId = `${cancelledPlan}-continued`
      const cancelController = new AbortController()
      const watcher = owner.watchExternalCancelRequests(cancelController)
      const secondRun = runGeneralOfflinePassOnOwner({
        owner,
        mission,
        handle: resumed,
        discoverQuery: 'Nimbus Plan A monthly',
        activePlanRevisionId: cancelledPlan,
        planRevisionId: continuedPlanId,
        signal: cancelController.signal,
        model: blocking,
      })
      await new Promise((r) => setTimeout(r, 40))
      cancelController.abort()
      watcher.stop()
      await assert.rejects(() => secondRun)
      await finalizeOwnerResearchRunCancellation({ store: owner.store, mission, now: () => FIXED_NOW })
      await owner.close()

      const inspectFinal = await ResearchEngineSession.openInspect(dir)
      const eventsFinal = await inspectFinal.listEvents(mission.mission_id)
      assert.equal(eventsFinal.filter((e) => e.kind === 'terminal_receipt').length, 2)
      const secondAttempts = eventsFinal
        .filter((e) => e.kind === 'external_operation_intent')
        .map((e) => (e.payload as { intent: { attempt_id: string } }).intent.attempt_id)
      const planAttempts = [
        ...new Set(
          [...firstAttempts, ...secondAttempts].filter((id) => id.includes('cli-run-plan-att')),
        ),
      ]
      assert.ok(planAttempts.length >= 2, `expected distinct plan attempt ids, got ${planAttempts.join(',')}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
