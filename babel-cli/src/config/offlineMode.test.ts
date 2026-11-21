import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertOfflineEndpointAllowed,
  assertOfflineProviderAllowed,
  isLoopbackEndpoint,
  isOfflineMode,
  isProviderLocal,
  offlineModeSource,
  OfflineModeError,
} from './offlineMode.js'

test('explicit offline sources are recognized without widening unrelated fixture flags', () => {
  assert.equal(offlineModeSource({ BABEL_OFFLINE: '1' }, []), 'babel-offline')
  assert.equal(offlineModeSource({ BABEL_OFFLINE: 'true' }, []), 'babel-offline')
  assert.equal(offlineModeSource({}, ['node', 'babel', 'work', '--offline']), 'babel-offline')
  assert.equal(offlineModeSource({ BABEL_DESKTOP_PROVIDER: 'ollama' }, []), 'desktop-local-provider')
  assert.equal(offlineModeSource({ BABEL_OFFLINE: '0' }, []), null)
  assert.equal(offlineModeSource({ BABEL_LITE_OFFLINE: '1' }, []), null)
  assert.equal(offlineModeSource({ BABEL_PIPELINE_V9_OFFLINE: '1' }, []), null)
})

test('an explicitly offline environment is honored even when the process is online', () => {
  const previous = process.env['BABEL_OFFLINE']
  delete process.env['BABEL_OFFLINE']
  try {
    assert.equal(isOfflineMode({ BABEL_OFFLINE: '1' }), true)
    assert.equal(isOfflineMode({}), false)
  } finally {
    if (previous === undefined) delete process.env['BABEL_OFFLINE']
    else process.env['BABEL_OFFLINE'] = previous
  }
})

test('loopback detection accepts only local HTTP endpoints', () => {
  assert.equal(isLoopbackEndpoint('http://127.0.0.1:11434/v1'), true)
  assert.equal(isLoopbackEndpoint('http://localhost:11434/v1'), true)
  assert.equal(isLoopbackEndpoint('http://[::1]:11434/v1'), true)
  assert.equal(isLoopbackEndpoint('https://api.deepseek.com/v1'), false)
  assert.equal(isLoopbackEndpoint('http://10.0.0.8:11434/v1'), false)
  assert.equal(isLoopbackEndpoint('not a url'), false)
})

test('provider locality matches actual transport shape', () => {
  assert.equal(isProviderLocal('ollama'), true)
  assert.equal(isProviderLocal('openai-compatible', 'http://localhost:8080/v1'), true)
  assert.equal(isProviderLocal('openai-compatible', 'https://gateway.example.test/v1'), false)
  assert.equal(isProviderLocal('deepseek'), false)
})

test('offline rejects remote providers but allows local ones without network I/O', () => {
  const env = { BABEL_OFFLINE: '1' } as NodeJS.ProcessEnv
  assert.throws(() => assertOfflineProviderAllowed('deepseek', undefined, env), OfflineModeError)
  assert.doesNotThrow(() => assertOfflineProviderAllowed('ollama', undefined, env))
  assert.doesNotThrow(() => assertOfflineProviderAllowed('openai-compatible', 'http://127.0.0.1:11434/v1', env))
  assert.throws(() => assertOfflineProviderAllowed('openai-compatible', 'https://remote.example.test/v1', env), /OFFLINE_MODE_UNAVAILABLE/)
  assert.doesNotThrow(() => assertOfflineProviderAllowed('deepseek', undefined, {} as NodeJS.ProcessEnv))
})

test('offline rejects a non-loopback dispatch URL, including redirects', () => {
  const env = { BABEL_OFFLINE: '1' } as NodeJS.ProcessEnv
  assert.throws(() => assertOfflineEndpointAllowed('https://api.openai.com/v1/chat/completions', env), /remote provider endpoint/)
  assert.doesNotThrow(() => assertOfflineEndpointAllowed('http://localhost:11434/v1/chat/completions', env))
})
