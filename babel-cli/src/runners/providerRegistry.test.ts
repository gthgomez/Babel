import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ProviderCredentialError,
  getProviderCredentialStatus,
  resolveProviderCredential,
} from './credentialHub.js'
import { getProviderSpec, listProviderSpecs } from './providerRegistry.js'

describe('provider credential hub', () => {
  it('covers every supported provider without exposing values in status', () => {
    const specs = listProviderSpecs()
    assert.deepEqual(
      specs.map((spec) => spec.id),
      [
        'deepinfra',
        'deepseek',
        'opencode',
        'openrouter',
        'openai',
        'anthropic',
        'gemini',
        'groq',
        'ollama',
      ],
    )
    assert.equal(getProviderSpec('opencode').credentialEnvVar, 'OPENCODE_API_KEY')
    assert.equal(getProviderSpec('opencode').protocol, 'openai_compatible')
    assert.equal(getProviderSpec('openrouter').credentialEnvVar, 'OPENROUTER_API_KEY')
    assert.deepEqual(
      getProviderCredentialStatus('openrouter', { OPENROUTER_API_KEY: 'synthetic-value' }),
      {
        provider: 'openrouter',
        envVar: 'OPENROUTER_API_KEY',
        configured: true,
        required: true,
      },
    )
  })

  it('uses explicit and custom environment credentials with deterministic precedence', () => {
    assert.equal(
      resolveProviderCredential('openrouter', {
        explicitCredential: 'explicit-synthetic',
        env: { CUSTOM_ROUTER_KEY: 'env-synthetic' },
        envVarOverride: 'CUSTOM_ROUTER_KEY',
      }),
      'explicit-synthetic',
    )
    assert.equal(
      resolveProviderCredential('openrouter', {
        env: { CUSTOM_ROUTER_KEY: 'env-synthetic' },
        envVarOverride: 'CUSTOM_ROUTER_KEY',
      }),
      'env-synthetic',
    )
  })

  it('fails safely for missing or invalid credential names', () => {
    assert.throws(
      () => resolveProviderCredential('deepseek', { env: {} }),
      (error: unknown) =>
        error instanceof ProviderCredentialError &&
        error.provider === 'deepseek' &&
        !error.message.includes('synthetic-secret'),
    )
    assert.throws(
      () => resolveProviderCredential('openrouter', { envVarOverride: 'bad-name', env: {} }),
      /Invalid provider credential environment variable name/,
    )
    assert.equal(resolveProviderCredential('ollama', { env: {} }), null)
  })

  it('declares operation capabilities independently of credentials', () => {
    assert.equal(getProviderSpec('deepseek').operations.includes('native_tool_stream'), true)
    assert.equal(getProviderSpec('openai').operations.includes('native_tool_stream'), false)
  })
})
