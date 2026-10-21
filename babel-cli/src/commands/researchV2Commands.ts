import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { printJsonErrorAndExit, printJsonOrHuman } from './output.js'
import { assertResearchV2LiveApiEnabled, isResearchV2LiveApiEnabled } from '../research/v2/liveApiGate.js'
import { createLiveResearchModelPort } from '../research/v2/model/researchV2LiveModelPort.js'
import {
  resolveLiveResearchModelConfigForCli,
  resolveResearchV2OpenRouterRouteFromPolicy,
} from '../research/v2/model/researchV2ModelRoute.js'
import {
  cancelResearchV2OwnerSession,
  inspectResearchV2Store,
  reportResearchV2Store,
  resumeResearchV2Continuation,
  runResearchV2CancelResumeJourney,
  runResearchV2OfflineRun,
  runResearchV2ProductionRun,
} from '../research/v2/cli/researchV2CliOperations.js'
import { openAdmittedOwnerStore } from '../research/v2/control/researchStoreAdmission.js'
import { FixtureResearchModelBridge } from '../research/v2/model/fixtureModelBridge.js'
import { runAdmittedPlanningIteration } from '../research/v2/engine/researchIterationLoop.js'
import {
  examplePlanRevisionFixture,
  exampleTechnicalMissionFixture,
} from '../research/v2/fixtures/exampleMission.js'
import type { ResearchModelPort } from '../research/v2/ports/researchModelPort.js'
import { mkdir } from 'node:fs/promises'

/** @internal Exported for CLI repair tests — performs owner cleanup before surfacing errors. */
export async function runResearchV2DryRunPlan(
  options: { json: boolean },
  seams?: { createModel?: () => ResearchModelPort; storeDirectory?: string },
): Promise<void> {
  const storeDirectory =
    seams?.storeDirectory ?? (await mkdtemp(join(tmpdir(), 'babel-research-v2-cli-')))
  let owner: Awaited<ReturnType<typeof openAdmittedOwnerStore>> | undefined
  try {
    owner = await openAdmittedOwnerStore(storeDirectory)
    const model = seams?.createModel?.() ?? new FixtureResearchModelBridge()
    if (model instanceof FixtureResearchModelBridge) {
      model.scriptOutput('cli-plan-op', {
        kind: 'plan_questions',
        questions: [{ text: 'CLI dry-run question', importance: 'medium' }],
      })
    }
    const missionHandle = await owner.store.appendMission(exampleTechnicalMissionFixture)
    const result = await runAdmittedPlanningIteration({
      session: { mission: exampleTechnicalMissionFixture, handle: missionHandle },
      store: owner.store,
      model,
      modelOperationId: 'cli-plan-op',
      modelAttemptId: 'cli-plan-att',
      planRevisionId: examplePlanRevisionFixture.plan_revision_id,
      revisionReason: 'cli_fixture_planning',
      dispatchedAt: new Date().toISOString(),
      signal: new AbortController().signal,
    })
    const payload = {
      mode: 'fixture_dry_run',
      live_api: false,
      store_directory: storeDirectory,
      session_id: owner.sessionId,
      planned_question_count: result.plannedQuestionCount,
      limitations: {
        search: 'use_v2_run_for_offline_retrieval',
        report: 'use_v2_report_after_run',
      },
      note: 'Planning scaffold only — not a completed research engine or live research run.',
    }
    printJsonOrHuman(payload, JSON.stringify(payload, null, 2), options.json)
  } finally {
    await owner?.close()
  }
}

/** @internal Live-gated planning iteration into a host-owned durable store directory. */
export async function runResearchV2LivePlan(
  options: { store: string; json: boolean },
  seams?: {
    createModel?: () => ResearchModelPort
    resolveConfig?: typeof resolveLiveResearchModelConfigForCli
  },
): Promise<void> {
  assertResearchV2LiveApiEnabled()
  const resolveConfig = seams?.resolveConfig ?? resolveLiveResearchModelConfigForCli
  const { config: liveConfig, route_report } = resolveConfig()
  const model = seams?.createModel?.() ?? createLiveResearchModelPort(liveConfig)
  await mkdir(options.store, { recursive: true })
  let owner: Awaited<ReturnType<typeof openAdmittedOwnerStore>> | undefined
  try {
    owner = await openAdmittedOwnerStore(options.store)
    const missionHandle = await owner.store.appendMission(exampleTechnicalMissionFixture)
    const result = await runAdmittedPlanningIteration({
      session: { mission: exampleTechnicalMissionFixture, handle: missionHandle },
      store: owner.store,
      model,
      modelOperationId: 'cli-live-plan-op',
      modelAttemptId: 'cli-live-plan-att',
      planRevisionId: examplePlanRevisionFixture.plan_revision_id,
      revisionReason: 'cli_live_planning',
      dispatchedAt: new Date().toISOString(),
      signal: new AbortController().signal,
    })
    const payload = {
      mode: 'live_plan',
      live_api: true,
      provider: liveConfig.engine.provider,
      model_id: liveConfig.engine.modelId,
      ...(route_report ? { openrouter_route: route_report } : { config_source: 'babel_research_v2_env' }),
      store_directory: options.store,
      session_id: owner.sessionId,
      planned_question_count: result.plannedQuestionCount,
      plan_revision_id: result.planRevisionId,
      limitations: {
        retrieval: 'use_v2_run',
        report: 'use_v2_report',
      },
      note: 'Live planning iteration only — not a completed research engine run.',
    }
    printJsonOrHuman(payload, JSON.stringify(payload, null, 2), options.json)
  } finally {
    await owner?.close()
  }
}

export function registerResearchV2Commands(program: Command): void {
  const v2 = program
    .command('v2')
    .description('Research v2 admitted store/engine (not a completed research product)')

  v2
    .command('dry-run-plan')
    .description('Fixture-only planning iteration into a temp durable store (no live API)')
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { json: boolean }) => {
      try {
        await runResearchV2DryRunPlan(options)
      } catch (error) {
        printJsonErrorAndExit(error instanceof Error ? error.message : String(error), options.json)
      }
    })

  v2
    .command('live-status')
    .description('Report whether live research v2 API gate is enabled')
    .option('--json', 'emit machine-readable output', false)
    .action((options: { json: boolean }) => {
      const payload = {
        live_api_enabled: isResearchV2LiveApiEnabled(),
        gate_env: 'BABEL_RESEARCH_V2_ALLOW_LIVE_API',
      }
      printJsonOrHuman(payload, `live_api_enabled=${payload.live_api_enabled}`, options.json)
    })

  const print = (payload: unknown, human: string, json: boolean) =>
    printJsonOrHuman(payload, human, json)

  v2
    .command('model-route')
    .description('Report explicit OpenRouter route from model-policy (no network, no secrets)')
    .option('--route-key <key>', 'model-policy backend key', '')
    .option('--json', 'emit machine-readable output', false)
    .action((options: { routeKey: string; json: boolean }) => {
      try {
        const route = resolveResearchV2OpenRouterRouteFromPolicy(
          options.routeKey.trim() || undefined,
        )
        print(route, JSON.stringify(route, null, 2), options.json)
      } catch (error) {
        printJsonErrorAndExit(error instanceof Error ? error.message : String(error), options.json)
      }
    })

  v2
    .command('run')
    .description('Mission-driven research run into --store (production adapters; live model when gated)')
    .requiredOption('--store <dir>', 'admitted durable store directory')
    .option('--mission-file <path>', 'research mission JSON (required unless --injected-offline)')
    .option('--discover-query <text>', 'discovery query override (defaults to mission primary question)')
    .option('--injected-offline', 'deterministic offline injected run (fixture mission corpus)', false)
    .option('--json', 'emit machine-readable output', false)
    .action(
      async (options: {
        store: string
        missionFile: string
        discoverQuery: string
        injectedOffline: boolean
        json: boolean
      }) => {
        try {
          if (options.injectedOffline) {
            await runResearchV2OfflineRun({
              store: options.store,
              json: options.json,
              print: (p, h) => print(p, h, options.json),
            })
            return
          }
          if (!options.missionFile?.trim()) {
            throw new Error('--mission-file is required for production research v2 run')
          }
          await runResearchV2ProductionRun({
            store: options.store,
            missionFile: options.missionFile.trim(),
            discoverQuery: options.discoverQuery,
            print: (p, h) => print(p, h, options.json),
          })
        } catch (error) {
          printJsonErrorAndExit(error instanceof Error ? error.message : String(error), options.json)
        }
      },
    )

  v2
    .command('inspect')
    .description('Inspect durable store events for a mission (no owner lock)')
    .requiredOption('--store <dir>', 'admitted durable store directory')
    .requiredOption('--mission-id <id>', 'mission id')
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { store: string; missionId: string; json: boolean }) => {
      try {
        await inspectResearchV2Store({
          store: options.store,
          missionId: options.missionId,
          print: (p, h) => print(p, h, options.json),
        })
      } catch (error) {
        printJsonErrorAndExit(error instanceof Error ? error.message : String(error), options.json)
      }
    })

  v2
    .command('report')
    .description('Print latest terminal_receipt report for a mission')
    .requiredOption('--store <dir>', 'admitted durable store directory')
    .requiredOption('--mission-id <id>', 'mission id')
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { store: string; missionId: string; json: boolean }) => {
      try {
        await reportResearchV2Store({
          store: options.store,
          missionId: options.missionId,
          print: (p, h) => print(p, h, options.json),
        })
      } catch (error) {
        printJsonErrorAndExit(error instanceof Error ? error.message : String(error), options.json)
      }
    })

  v2
    .command('cancel')
    .description('Submit external cancel request for an admitted owner session')
    .requiredOption('--store <dir>', 'admitted durable store directory')
    .requiredOption('--session-id <id>', 'owner session id from session control')
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { store: string; sessionId: string; json: boolean }) => {
      try {
        await cancelResearchV2OwnerSession({
          store: options.store,
          sessionId: options.sessionId,
          print: (p, h) => print(p, h, options.json),
        })
      } catch (error) {
        printJsonErrorAndExit(error instanceof Error ? error.message : String(error), options.json)
      }
    })

  v2
    .command('resume')
    .description('Admit host-authorized research continuation after resumable terminal state')
    .requiredOption('--store <dir>', 'admitted durable store directory')
    .requiredOption('--mission-id <id>', 'mission id')
    .requiredOption('--writer-generation <n>', 'expected writer generation', (v) => Number(v))
    .requiredOption('--plan-revision-id <id>', 'acknowledged plan revision id')
    .requiredOption('--terminal-state <state>', 'cancelled | interrupted | needs_reconciliation')
    .requiredOption('--host-authorization-ref <ref>', 'host authorization reference')
    .option('--mission-file <path>', 'mission JSON when not already in store events')
    .option('--discover-query <text>', 'discovery query for continued engine pass')
    .option('--injected-offline', 'continue with deterministic offline adapters/model', false)
    .option('--no-continue-run', 'admit continuation only; skip engine pass', false)
    .option('--json', 'emit machine-readable output', false)
    .action(
      async (options: {
        store: string
        missionId: string
        writerGeneration: number
        planRevisionId: string
        terminalState: string
        hostAuthorizationRef: string
        missionFile: string
        discoverQuery: string
        injectedOffline: boolean
        continueRun: boolean
        json: boolean
      }) => {
        try {
          await resumeResearchV2Continuation({
            store: options.store,
            missionId: options.missionId,
            writerGeneration: options.writerGeneration,
            planRevisionId: options.planRevisionId,
            terminalState: options.terminalState as 'cancelled' | 'interrupted' | 'needs_reconciliation',
            hostAuthorizationRef: options.hostAuthorizationRef,
            ...(options.missionFile?.trim()
              ? { missionFile: options.missionFile.trim() }
              : {}),
            ...(options.discoverQuery ? { discoverQuery: options.discoverQuery } : {}),
            continueRun: options.continueRun,
            injectedOffline: options.injectedOffline,
            print: (p, h) => print(p, h, options.json),
          })
        } catch (error) {
          printJsonErrorAndExit(error instanceof Error ? error.message : String(error), options.json)
        }
      },
    )

  v2
    .command('cancel-resume-once')
    .description('Offline X-L1 journey: cancel terminal then resume continuation exactly once')
    .requiredOption('--store <dir>', 'admitted durable store directory')
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { store: string; json: boolean }) => {
      try {
        await runResearchV2CancelResumeJourney({
          store: options.store,
          print: (p, h) => print(p, h, options.json),
        })
      } catch (error) {
        printJsonErrorAndExit(error instanceof Error ? error.message : String(error), options.json)
      }
    })

  v2
    .command('live-plan')
    .description('Live planning iteration (requires BABEL_RESEARCH_V2_ALLOW_LIVE_API=1 and provider wiring)')
    .requiredOption('--store <dir>', 'admitted durable store directory')
    .option('--json', 'emit machine-readable output', false)
    .action(async (options: { store: string; json: boolean }) => {
      try {
        await runResearchV2LivePlan(options)
      } catch (error) {
        printJsonErrorAndExit(error instanceof Error ? error.message : String(error), options.json)
      }
    })
}
