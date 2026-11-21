import assert from 'node:assert/strict'
import test from 'node:test'

import {
  shouldUseChatNativeTools,
  shouldUseChatTextTools,
} from './chatEngineProviderRuntime.js'
import {
  chatToolTransportForProvider,
  getProviderSpec,
  listProviderSpecs,
} from '../runners/providerRegistry.js'

const fakeRunner = (provider: string, nativeStream = true) =>
  ({
    provider,
    ...(nativeStream
      ? { executeWithToolsStream: async function* executeWithToolsStream() {} }
      : {}),
  }) as never

test('the provider registry declares the Chat tool transport it actually uses', () => {
  for (const spec of listProviderSpecs()) {
    assert.ok(
      spec.chatToolTransport === 'native' || spec.chatToolTransport === 'text',
      `${spec.id} must declare a Chat tool transport`,
    )
    // Live/certified providers must not advertise a native Chat transport they
    // cannot stream. Dormant (untested) providers are not activatable, so their
    // retained legacy profile is reported as-is rather than retuned here.
    if (spec.authorityConformance === 'certified' && spec.chatToolTransport === 'native') {
      assert.equal(
        spec.operations.includes('native_tool_stream'),
        true,
        `${spec.id} advertises native Chat tools without native_tool_stream capability`,
      )
    }
  }

  assert.equal(chatToolTransportForProvider('ollama'), 'text')
  assert.equal(chatToolTransportForProvider('openai'), 'native')
  assert.equal(chatToolTransportForProvider('unknown-provider'), null)
})

test('Chat never advertises native tool arrays for a text-transport provider', () => {
  const previousNative = process.env['BABEL_NATIVE_TOOLS']
  const previousProfile = process.env['BABEL_TOOL_PROFILE']
  try {
    delete process.env['BABEL_NATIVE_TOOLS']
    delete process.env['BABEL_TOOL_PROFILE']

    assert.equal(shouldUseChatNativeTools(fakeRunner('ollama')), false)
    assert.equal(shouldUseChatTextTools(() => fakeRunner('ollama')), true)

    assert.equal(shouldUseChatNativeTools(fakeRunner('openai')), true)
    assert.equal(shouldUseChatTextTools(() => fakeRunner('openai')), false)

    // The same decision follows ProviderEngine-declared identities too.
    assert.equal(shouldUseChatNativeTools(fakeRunner('openai-compatible')), true)
    assert.equal(shouldUseChatTextTools(() => fakeRunner('openai-compatible')), false)

    // Missing native implementation stays on the legacy JSON path, as before.
    assert.equal(shouldUseChatNativeTools(fakeRunner('openai', false)), false)

    // An explicit operator profile still wins over the registry default.
    process.env['BABEL_TOOL_PROFILE'] = 'text'
    assert.equal(shouldUseChatTextTools(() => fakeRunner('openai')), true)
    assert.equal(shouldUseChatNativeTools(fakeRunner('openai')), true)
  } finally {
    if (previousNative === undefined) delete process.env['BABEL_NATIVE_TOOLS']
    else process.env['BABEL_NATIVE_TOOLS'] = previousNative
    if (previousProfile === undefined) delete process.env['BABEL_TOOL_PROFILE']
    else process.env['BABEL_TOOL_PROFILE'] = previousProfile
  }
})

test('Ollama stays a certified coding connection even though Chat uses text tools', () => {
  const spec = getProviderSpec('ollama')
  assert.equal(spec.authorityConformance, 'certified')
  assert.equal(spec.chatToolTransport, 'text')
  assert.equal(spec.operations.includes('native_tool_stream'), true)
})
