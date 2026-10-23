import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LlmRunner } from '../../../runners/base.js'
import type { ProviderEngine } from '../../../runners/providerEngine.js'
import {
  createLiveResearchModelPort,
  createProviderResearchModelBridge,
  resolveLiveResearchModelConfigFromEnv,
} from './researchV2LiveModelPort.js'

describe('researchV2LiveModelPort', () => {
  it('resolveLiveResearchModelConfigFromEnv returns null when provider/model unset', () => {
    assert.equal(resolveLiveResearchModelConfigFromEnv({}), null)
    assert.equal(resolveLiveResearchModelConfigFromEnv({ BABEL_RESEARCH_V2_PROVIDER: 'openrouter' }), null)
  })

  it('createLiveResearchModelPort uses injected runner factory behind live gate', async () => {
    const prior = process.env.BABEL_RESEARCH_V2_ALLOW_LIVE_API
    process.env.BABEL_RESEARCH_V2_ALLOW_LIVE_API = '1'
    try {
      const runner: Pick<LlmRunner, 'execute' | 'getLastInvocationMetadata'> = {
        async execute(_prompt, schema) {
          return schema.parse({
            kind: 'plan_questions',
            questions: [{ text: 'Live-gated stub', importance: 'low' }],
          })
        },
        getLastInvocationMetadata: () => null,
      }
      const port = createLiveResearchModelPort({
        backendKey: 'test',
        engine: { provider: 'openrouter', modelId: 'test/model' },
        createRunner: () => runner as ProviderEngine,
      })
      const result = await port.invokeStructured({
        operationId: 'live-op',
        attemptId: 'live-att',
        kind: 'plan_questions',
        input: {},
        signal: new AbortController().signal,
      })
      assert.equal(result.status, 'ok')
    } finally {
      if (prior === undefined) delete process.env.BABEL_RESEARCH_V2_ALLOW_LIVE_API
      else process.env.BABEL_RESEARCH_V2_ALLOW_LIVE_API = prior
    }
  })

  it('createProviderResearchModelBridge does not require live API gate', async () => {
    const runner: Pick<LlmRunner, 'execute'> = {
      async execute(_prompt, schema) {
        return schema.parse({
          kind: 'plan_questions',
          questions: [{ text: 'Offline factory', importance: 'low' }],
        })
      },
    }
    const port = createProviderResearchModelBridge({
      backendKey: 'offline-factory',
      engine: { provider: 'openrouter', modelId: 'offline/model' },
      createRunner: () => runner as ProviderEngine,
    })
    const result = await port.invokeStructured({
      operationId: 'offline-factory-op',
      attemptId: 'offline-factory-att',
      kind: 'plan_questions',
      input: {},
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
  })
})
