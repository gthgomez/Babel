import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { printJsonErrorAndExit, printJsonOrHuman } from './output.js'
import { assertResearchV2LiveApiEnabled, isResearchV2LiveApiEnabled } from '../research/v2/liveApiGate.js'
import {
  createLiveResearchModelPort,
  resolveLiveResearchModelConfigFromEnv,
} from '../research/v2/model/researchV2LiveModelPort.js'
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
        search: 'not_implemented',
        live_plan: 'not_wired',
        report: 'not_implemented',
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
    resolveConfig?: typeof resolveLiveResearchModelConfigFromEnv
  },
): Promise<void> {
  assertResearchV2LiveApiEnabled()
  const resolveConfig = seams?.resolveConfig ?? resolveLiveResearchModelConfigFromEnv
  const liveConfig = resolveConfig()
  if (!liveConfig) {
    throw new Error(
      'Live plan requires BABEL_RESEARCH_V2_PROVIDER and BABEL_RESEARCH_V2_MODEL_ID (optional BABEL_RESEARCH_V2_API_KEY_ENV).',
    )
  }
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
      store_directory: options.store,
      session_id: owner.sessionId,
      planned_question_count: result.plannedQuestionCount,
      plan_revision_id: result.planRevisionId,
      limitations: {
        retrieval: 'not_implemented',
        report: 'not_implemented',
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
