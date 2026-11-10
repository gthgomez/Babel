import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveModelByKey } from '../modelPolicy.js'
import manifest from '../../fixtures/openrouter-lane-647e/manifest.json' with { type: 'json' }

const laneRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'openrouter-lane-647e')

test('openrouter lane manifest pins chat live route to OpenRouter DeepSeek flash', () => {
  assert.equal(manifest.canonical_live_route_key, 'deepseek-v4.1-flash-openrouter')
  const resolved = resolveModelByKey({ key: manifest.canonical_live_route_key })
  assert.equal(resolved.provider, 'openrouter')
  assert.equal(resolved.providerModelId, manifest.canonical_provider_model_id)
})

test('openrouter lane redacted evidence records zero provider errors on dispatched cells', () => {
  const evidence = JSON.parse(
    readFileSync(join(laneRoot, 'evidence', 'chat-scenarios-redacted.json'), 'utf8'),
  ) as { provider_errors_observed: number }
  assert.equal(evidence.provider_errors_observed, 0)
})
