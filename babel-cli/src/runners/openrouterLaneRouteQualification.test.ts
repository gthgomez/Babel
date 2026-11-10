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

test('pre-501 frozen evidence records zero provider errors on dispatched cells', () => {
  const evidence = JSON.parse(
    readFileSync(join(laneRoot, 'evidence', 'pre-501-trial', 'chat-scenarios-redacted.json'), 'utf8'),
  ) as { provider_errors_observed: number }
  assert.equal(evidence.provider_errors_observed, 0)
})

test('post-501 trial evidence when present reports provider error count', () => {
  const path = join(laneRoot, 'evidence', 'post-501-trial', 'chat-scenarios-post-501.json')
  try {
    const evidence = JSON.parse(readFileSync(path, 'utf8')) as {
      provider_errors_observed?: number
      provider_errors?: unknown[]
    }
  if (typeof evidence.provider_errors_observed === 'number') {
      assert.equal(evidence.provider_errors_observed, 0)
      return
    }
    assert.ok(Array.isArray(evidence.provider_errors))
    assert.equal(evidence.provider_errors.length, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
})
