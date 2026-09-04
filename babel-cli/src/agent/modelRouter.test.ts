import assert from 'node:assert/strict'
import test from 'node:test'
import { ModelRouter } from './modelRouter.js'

test('ModelRouter constructs declared DeepInfra routes through ProviderEngine', () => {
  const previous = process.env['DEEPINFRA_API_KEY']
  process.env['DEEPINFRA_API_KEY'] = 'synthetic-deepinfra-key'
  try {
    // qwen3 is the canonical deepinfra backend in config/model-policy.json
    const route = new ModelRouter().resolve('qwen3')
    assert.equal(route.provider, 'deepinfra')
    assert.equal(route.runner.provider, 'deepinfra')
    assert.equal(route.runner.modelId, route.modelId)
  } finally {
    if (previous === undefined) delete process.env['DEEPINFRA_API_KEY']
    else process.env['DEEPINFRA_API_KEY'] = previous
  }
})

test('ModelRouter maps legacy DeepSeek selectors to OpenRouter in live mode', () => {
  const previousRouter = process.env['OPENROUTER_API_KEY']
  const previousDeepSeek = process.env['DEEPSEEK_API_KEY']
  process.env['OPENROUTER_API_KEY'] = 'fixture-router-key'
  process.env['DEEPSEEK_API_KEY'] = 'synthetic-direct-key'
  try {
    const route = new ModelRouter({ liveOnly: true }).resolve('deepseek-v4-flash')
    assert.equal(route.provider, 'openrouter')
    assert.equal(route.modelId, 'deepseek/deepseek-v4-flash-0731')
    assert.equal(route.runner.provider, 'openrouter')
    assert.equal(route.runner.modelId, 'deepseek/deepseek-v4-flash-0731')
  } finally {
    if (previousRouter === undefined) delete process.env['OPENROUTER_API_KEY']
    else process.env['OPENROUTER_API_KEY'] = previousRouter
    if (previousDeepSeek === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = previousDeepSeek
  }
})
