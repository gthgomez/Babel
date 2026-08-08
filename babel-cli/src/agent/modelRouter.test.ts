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
