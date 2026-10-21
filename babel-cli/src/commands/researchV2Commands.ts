import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { printJsonErrorAndExit, printJsonOrHuman } from './output.js'
import { assertResearchV2LiveApiEnabled, isResearchV2LiveApiEnabled } from '../research/v2/liveApiGate.js'
import { openAdmittedOwnerStore } from '../research/v2/control/researchStoreAdmission.js'
import { FixtureResearchModelBridge } from '../research/v2/model/fixtureModelBridge.js'
import { FetchSourceAccessPort } from '../research/v2/access/fetchSourceAccessPort.js'
import { runAdmittedPlanningIteration } from '../research/v2/engine/researchIterationLoop.js'
import { examplePlanRevisionFixture, exampleTechnicalMissionFixture } from '../research/v2/fixtures/exampleMission.js'

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
        const storeDirectory = await mkdtemp(join(tmpdir(), 'babel-research-v2-cli-'))
        const owner = await openAdmittedOwnerStore(storeDirectory)
        const model = new FixtureResearchModelBridge()
        model.scriptOutput('cli-plan-op', {
          kind: 'plan_questions',
          questions: [{ text: 'CLI dry-run question', importance: 'medium' }],
        })
        const access = new FetchSourceAccessPort({
          fetch: async () => {
            throw new Error('dry-run does not perform network fetch')
          },
        })
        const result = await runAdmittedPlanningIteration({
          mission: exampleTechnicalMissionFixture,
          store: owner.store,
          model,
          access,
          planRevision: examplePlanRevisionFixture,
          modelOperationId: 'cli-plan-op',
          modelAttemptId: 'cli-plan-att',
          signal: new AbortController().signal,
        })
        await owner.close()
        const payload = {
          mode: 'fixture_dry_run',
          live_api: false,
          store_directory: storeDirectory,
          session_id: owner.sessionId,
          planned_question_count: result.plannedQuestionCount,
          note: 'Not a live research run; fixture model + admitted store only.',
        }
        printJsonOrHuman(payload, JSON.stringify(payload, null, 2), options.json)
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
        assertResearchV2LiveApiEnabled()
        printJsonErrorAndExit(
          'Provider-backed live plan is not wired in CLI yet; use dry-run-plan for fixture iteration.',
          options.json,
        )
      } catch (error) {
        printJsonErrorAndExit(error instanceof Error ? error.message : String(error), options.json)
      }
    })
}
