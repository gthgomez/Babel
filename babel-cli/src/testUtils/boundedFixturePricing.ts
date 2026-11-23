import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { loadModelPolicyConfig } from '../modelPolicy.js'

/** Admit one mock request under a finite cap so fixtures can test post-dispatch accounting. */
export function installBoundedFixturePricing(t: TestContext, fixtureRoot: string, backendKey: string): void {
  const { config } = loadModelPolicyConfig()
  const model = config.models?.[backendKey]
  assert.ok(model, 'expected an existing mock transport route')
  const path = join(fixtureRoot, 'finite-test-model-policy.json')
  writeFileSync(path, JSON.stringify({
    ...config,
    models: { ...config.models, [backendKey]: {
      ...model,
      estimated_cost_per_1m_input: 0.01,
      estimated_cost_per_1m_output: 0.02,
    } },
  }))
  const previous = process.env['BABEL_MODEL_POLICY_PATH']
  process.env['BABEL_MODEL_POLICY_PATH'] = path
  t.after(() => {
    if (previous === undefined) delete process.env['BABEL_MODEL_POLICY_PATH']
    else process.env['BABEL_MODEL_POLICY_PATH'] = previous
  })
}
