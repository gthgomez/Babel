/**
 * Two-provider route isolation tests (campaign Task 5).
 *
 * Proves the chat runtime binds every Command Code campaign selection to its
 * own credential (CMD_API_KEY) and origin, that Claude-family selections take
 * the Anthropic Messages transport, that fallback refuses provider
 * substitution, and that policy-pinned routes validate against the exact
 * campaign identities. Mock transports only; no network, no real credentials.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  resolveChatDeliberationRunner,
  resolveChatFallbackRunner,
  resolveChatFallbackOrFail,
} from './chatEngineProviderRuntime.js'
import { resolveChatRouteFromPolicy } from './chatModelPolicy.js'
import { isLiveModelBackend, type ResolvedModelPolicy } from '../modelPolicy.js'
import { routeFromPolicySelection } from '../intelligence/providerCatalog.js'
import {
  CommandCodeApiRunner,
  COMMANDCODE_API_BASE,
  COMMANDCODE_CREDENTIAL_ENV_VAR,
} from '../runners/commandCodeApi.js'
import { AnthropicMessagesRunner } from '../runners/anthropicMessages.js'
import type { ChatEvent } from './chatEngineContracts.js'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

const SAVED_ENV: Record<string, string | undefined> = {}
async function withEnv(
  values: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const names = [...Object.keys(values), COMMANDCODE_CREDENTIAL_ENV_VAR, 'OPENROUTER_API_KEY']
  const saved: Record<string, string | undefined> = {}
  for (const name of names) saved[name] = process.env[name]
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    await fn()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function policyOf(
  provider: string,
  providerModelId: string,
  backendKey: string,
): ResolvedModelPolicy {
  return {
    provider,
    providerModelId,
    resolvedBackendKey: backendKey,
  } as unknown as ResolvedModelPolicy
}

test('commandcode deliberation route uses only CMD_API_KEY against the Command Code origin', async () => {
  await withEnv({
    [COMMANDCODE_CREDENTIAL_ENV_VAR]: 'synthetic-commandcode-key',
    OPENROUTER_API_KEY: 'synthetic-router-key',
  }, async () => {
    const runner = resolveChatDeliberationRunner(
      null,
      policyOf('commandcode', 'z-ai/glm-5.3-flash', 'glm-5.3-flash-commandcode'),
    )
    assert.ok(runner instanceof CommandCodeApiRunner)
    const requests: Array<{ url: string; authorization: string }> = []
    globalThis.fetch = (async (input, init) => {
      const headers = (init?.headers as Record<string, string>) ?? {}
      requests.push({
        url: String(input),
        authorization: String(headers['Authorization'] ?? headers['authorization'] ?? ''),
      })
      return new Response(JSON.stringify({
        model: 'z-ai/glm-5.3-flash',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200 })
    }) as typeof fetch
    await runner.executeRaw('hello')
    assert.equal(requests.length, 1)
    assert.ok(requests[0]!.url.startsWith(COMMANDCODE_API_BASE))
    assert.equal(requests[0]!.authorization, 'Bearer synthetic-commandcode-key')
  })
})

test('commandcode Haiku selects the Anthropic Messages transport, never Chat Completions', async () => {
  await withEnv({
    [COMMANDCODE_CREDENTIAL_ENV_VAR]: 'synthetic-commandcode-key',
  }, async () => {
    const runner = resolveChatDeliberationRunner(
      null,
      policyOf('commandcode', 'claude-haiku-5-5', 'claude-haiku-5.5-commandcode'),
    )
    assert.ok(runner instanceof AnthropicMessagesRunner)
    // apiUrl is protected; assert through the public wire behavior instead.
    const messagesRequests: string[] = []
    globalThis.fetch = (async (input) => {
      messagesRequests.push(String(input))
      return new Response(JSON.stringify({
        model: 'claude-haiku-5-5',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200 })
    }) as typeof fetch
    await (runner as AnthropicMessagesRunner).executeRaw('hello')
    assert.equal(messagesRequests.length, 1)
    assert.ok(messagesRequests[0]!.endsWith('/messages'))
  })
})

test('openrouter campaign route resolves to OpenRouter, not the Command Code gateway', async () => {
  await withEnv({
    OPENROUTER_API_KEY: 'synthetic-router-key',
    [COMMANDCODE_CREDENTIAL_ENV_VAR]: undefined,
  }, () => {
    const runner = resolveChatDeliberationRunner(
      null,
      policyOf('openrouter', 'xiaomi/mimo-v2.6-flash', 'mimo-v2.6-flash-openrouter'),
    )
    assert.ok(!(runner instanceof CommandCodeApiRunner))
    assert.ok(!(runner instanceof AnthropicMessagesRunner))
  })
})

test('commandcode fallback refuses provider substitution', async () => {
  await withEnv({
    [COMMANDCODE_CREDENTIAL_ENV_VAR]: 'synthetic-commandcode-key',
    OPENROUTER_API_KEY: 'synthetic-router-key',
  }, () => {
    const policy = policyOf('commandcode', 'z-ai/glm-5.3-flash', 'glm-5.3-flash-commandcode')
    assert.equal(resolveChatFallbackRunner(null, {}, policy), null)
    const keep = new CommandCodeApiRunner('z-ai/glm-5.3-flash')
    assert.equal(resolveChatFallbackRunner(keep, {}, policy), keep)
  })
})

test('commandcode terminal failure yields an explicit substitution refusal', async () => {
  const events: ChatEvent[] = []
  for await (const event of resolveChatFallbackOrFail({
    err: new Error('gateway 500'),
    turn: 0,
    ownerGeneration: undefined,
    options: {},
    modelPolicy: policyOf('commandcode', 'z-ai/glm-5.3-flash', 'glm-5.3-flash-commandcode'),
    isSubmissionCurrent: () => true,
    cancelled: () => null,
    failed: (message: string) => ({ type: 'failed', message } as unknown as ChatEvent),
    tryFailover: () => null,
    resolveFallback: () => null,
    installFailover: () => {},
  })) {
    events.push(event)
  }
  assert.equal(events.length, 1)
  assert.match((events[0] as { message: string }).message, /refuses provider substitution/)
})

test('policy-pinned routes validate against exact campaign identities', () => {
  const route = resolveChatRouteFromPolicy(
    policyOf('commandcode', 'claude-haiku-5-5', 'claude-haiku-5.5-commandcode'),
    { babelRoot: REPO_ROOT },
  )
  assert.equal(route.protocol, 'anthropic_messages')
  assert.equal(route.modelId, 'claude-haiku-5-5')
  assert.equal(route.credentialEnvVar, 'CMD_API_KEY')
  assert.equal(route.capabilities.source, 'policy_pinned')

  assert.throws(
    () => routeFromPolicySelection({
      selectorKey: 'glm-5.3-flash-commandcode',
      provider: 'commandcode',
      modelId: 'openai/gpt-6-luna',
      sourceUrl: null,
      verifiedAt: null,
      contextLength: null,
      maxOutputTokens: null,
    }),
    /does not match/,
  )
  assert.throws(
    () => routeFromPolicySelection({
      selectorKey: 'some-unrelated-model-commandcode',
      provider: 'commandcode',
      modelId: 'x',
      sourceUrl: null,
      verifiedAt: null,
      contextLength: null,
      maxOutputTokens: null,
    }),
    /campaign selector keys/,
  )
})

test('live backend admission covers the ten campaign routes only with exact ids', () => {
  assert.ok(isLiveModelBackend({
    backendKey: 'glm-5.3-flash-commandcode',
    provider: 'commandcode',
    providerModelId: 'z-ai/glm-5.3-flash',
  }))
  assert.ok(isLiveModelBackend({
    backendKey: 'deepseek-v4.1-flash-latest-openrouter',
    provider: 'openrouter',
    providerModelId: 'deepseek/deepseek-v4.1-flash-1017',
  }))
  // A campaign key with the wrong model id must not pass live admission.
  assert.equal(isLiveModelBackend({
    backendKey: 'glm-5.3-flash-commandcode',
    provider: 'commandcode',
    providerModelId: 'openai/gpt-6-luna',
  }), false)
  // Non-campaign commandcode backends stay unapproved.
  assert.equal(isLiveModelBackend({
    backendKey: 'some-other-commandcode',
    provider: 'commandcode',
    providerModelId: 'z-ai/glm-5.3-flash',
  }), false)
})
