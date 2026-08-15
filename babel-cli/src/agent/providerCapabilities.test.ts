import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapReasoningEffort,
  resolveProviderCapabilities,
} from './providerCapabilities.js';
import type { ProviderCapabilities } from '../runners/base.js';

test('resolveProviderCapabilities: live providers carry the P1-C capability dimensions', () => {
  const deepseek = resolveProviderCapabilities('deepseek-v4-flash');
  assert.equal(deepseek.reasoningEffort?.supported, false);
  assert.equal(deepseek.promptCaching, 'implicit');
  assert.equal(deepseek.continuation, 'none');
  assert.equal(deepseek.nativeCompaction, false);

  const ollama = resolveProviderCapabilities('ollama/qwen3');
  assert.equal(ollama.promptCaching, 'none');
  assert.equal(ollama.reasoningEffort?.supported, false);
});

test('resolveProviderCapabilities: unknown providers get conservative defaults', () => {
  const caps = resolveProviderCapabilities('some-future-model');
  assert.equal(caps.reasoningEffort?.supported, false);
  assert.equal(caps.promptCaching, 'none');
  assert.equal(caps.continuation, 'none');
  assert.equal(caps.nativeCompaction, false);
});

test('resolveProviderCapabilities: overrides win for capability dimensions', () => {
  const caps = resolveProviderCapabilities('deepseek-v4-flash', {
    reasoningEffort: { supported: true, levels: ['low', 'medium', 'high'], source: 'provider' },
    continuation: 'opaque',
  });
  assert.equal(caps.reasoningEffort?.supported, true);
  assert.equal(caps.continuation, 'opaque');
  assert.equal(caps.promptCaching, 'implicit'); // untouched default preserved
});

test('mapReasoningEffort: unsupported dial resolves honestly, never faked', () => {
  const caps = resolveProviderCapabilities('deepseek-v4-flash');
  const r = mapReasoningEffort('high', caps);
  assert.equal(r.supportStatus, 'unsupported');
  assert.equal(r.effective, 'unsupported');
  assert.equal(r.requested, 'high');
});

test('mapReasoningEffort: supported dial maps the neutral level through', () => {
  const caps: ProviderCapabilities = {
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsThinking: true,
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
    supportsStreaming: true,
    thinkingWithTools: 'supported',
    reasoningEffort: { supported: true, levels: ['low', 'medium', 'high'], source: 'provider' },
  };
  assert.deepEqual(mapReasoningEffort('low', caps), {
    requested: 'low',
    effective: 'low',
    supportStatus: 'supported',
    mappingSource: 'provider',
  });
});

test('mapReasoningEffort: partial level sets fall back to the closest level', () => {
  const caps: ProviderCapabilities = {
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsThinking: true,
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
    supportsStreaming: true,
    thinkingWithTools: 'supported',
    reasoningEffort: { supported: true, levels: ['low', 'high'], source: 'policy' },
  };
  const medium = mapReasoningEffort('medium', caps);
  assert.equal(medium.effective, 'high'); // closest supported (documented policy choice)
  assert.equal(medium.mappingSource, 'policy');
});
