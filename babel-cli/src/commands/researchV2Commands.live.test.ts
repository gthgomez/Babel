import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FixtureResearchModelBridge } from '../research/v2/model/fixtureModelBridge.js'
import { resolveLiveResearchModelConfigForCli } from '../research/v2/model/researchV2ModelRoute.js'
import { runResearchV2LivePlan } from './researchV2Commands.js'

describe('research v2 live-plan CLI wiring', () => {
  it('runs admitted planning into host store when gate and config are set', async () => {
    const priorGate = process.env.BABEL_RESEARCH_V2_ALLOW_LIVE_API
    process.env.BABEL_RESEARCH_V2_ALLOW_LIVE_API = '1'
    const storeDirectory = await mkdtemp(join(tmpdir(), 'babel-research-v2-live-plan-'))
    const model = new FixtureResearchModelBridge()
    model.scriptOutput('cli-live-plan-op', {
      kind: 'plan_questions',
      questions: [{ text: 'Live CLI plan question', importance: 'high' }],
    })
    try {
      await runResearchV2LivePlan(
        { store: storeDirectory, json: true },
        {
          createModel: () => model,
          resolveConfig: () => {
            const env = { ...process.env }
            delete env.BABEL_RESEARCH_V2_PROVIDER
            delete env.BABEL_RESEARCH_V2_MODEL_ID
            return resolveLiveResearchModelConfigForCli(env)
          },
        },
      )
    } finally {
      if (priorGate === undefined) delete process.env.BABEL_RESEARCH_V2_ALLOW_LIVE_API
      else process.env.BABEL_RESEARCH_V2_ALLOW_LIVE_API = priorGate
      await rm(storeDirectory, { recursive: true, force: true })
    }
  })
})
