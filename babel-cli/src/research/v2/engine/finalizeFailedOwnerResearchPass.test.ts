import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'
import { ResearchEngineSession } from './researchEngineSession.js'
import { runResearchV2EnginePassOnOwner } from '../cli/researchV2MissionRun.js'
import { ProviderResearchModelBridge } from '../model/providerResearchModelBridge.js'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LlmRunner } from '../../../runners/base.js'
import type { ZodType } from 'zod'
import { buildResearchV2StructuredModelPrompt } from '../model/researchV2ProviderModelPrompt.js'
import { reportResearchV2Store } from '../cli/researchV2CliOperations.js'

const malformedFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/campaign/G-L1-live-malformed-plan-questions-response.json',
)

function malformedPlanningBridge(): ProviderResearchModelBridge {
  const fixture = JSON.parse(readFileSync(malformedFixturePath, 'utf8')) as {
    raw_model_payload: Record<string, unknown>
  }
  const runner: Pick<LlmRunner, 'execute'> = {
    async execute<T>(_prompt: string, _schema: ZodType<T>): Promise<T> {
      return fixture.raw_model_payload as T
    },
  }
  return new ProviderResearchModelBridge({
    runner,
    backendKey: 'research-v2-cli',
    provider: 'openrouter',
    providerModelId: 'deepseek/deepseek-v4-flash-0731',
    buildPrompt: buildResearchV2StructuredModelPrompt,
  })
}

describe('finalizeFailedOwnerResearchPass', () => {
  it('records failed terminal receipt when planning invoke fails so report is inspectable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'babel-research-v2-failed-pass-'))
    try {
      const owner = await ResearchEngineSession.openOwner({
        storeDirectory: dir,
        model: new FixtureResearchModelBridge(),
      })
      const handle = await owner.appendMission(exampleTechnicalMissionFixture)
      await assert.rejects(() =>
        runResearchV2EnginePassOnOwner({
          owner,
          mission: exampleTechnicalMissionFixture,
          handle,
          discoverQuery: 'RESEARCH_CONTRACT',
          injectedOffline: false,
          planRevisionId: 'plan-failed-pass-001',
          model: malformedPlanningBridge(),
          signal: new AbortController().signal,
        }),
      )
      await owner.close()

      let reportPayload: { report?: { terminal_state?: string } } | undefined
      await reportResearchV2Store({
        store: dir,
        missionId: exampleTechnicalMissionFixture.mission_id,
        print: (p) => {
          reportPayload = p as { report?: { terminal_state?: string } }
        },
      })
      assert.equal(reportPayload?.report?.terminal_state, 'failed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
