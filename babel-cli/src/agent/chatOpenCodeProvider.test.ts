import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatEngine } from './chatEngine.js';
import { OpenCodeApiRunner } from '../runners/openCodeApi.js';
import { resolveChatModelPolicy } from './chatModelPolicy.js';
import { resolveAskModelPolicyWithLiveGate } from '../services/askAnswer.js';

/**
 * OpenCode Zen routing invariants.
 *
 * Live lanes remain DeepSeek-only by default (LIVE_MODEL_POLICY), but an
 * explicit backend key whose provider is `opencode` (e.g. ox-alpha-free) is a
 * direct operator opt-in: chat/ask must route it through OpenCodeApiRunner.
 */

function withTestEnv(fn: () => void): void {
  const previousOffline = process.env['BABEL_OFFLINE'];
  const previousKey = process.env['OPENCODE_API_KEY'];
  delete process.env['BABEL_OFFLINE'];
  process.env['OPENCODE_API_KEY'] = 'synthetic-opencode-key';
  try {
    fn();
  } finally {
    if (previousOffline === undefined) delete process.env['BABEL_OFFLINE'];
    else process.env['BABEL_OFFLINE'] = previousOffline;
    if (previousKey === undefined) delete process.env['OPENCODE_API_KEY'];
    else process.env['OPENCODE_API_KEY'] = previousKey;
  }
}

test('live chat policy resolves an explicit opencode backend key without the DeepSeek gate', () => {
  withTestEnv(() => {
    const { policy } = resolveChatModelPolicy({ model: 'ox-alpha-free' });
    assert.equal(policy.provider, 'opencode');
    assert.equal(policy.providerModelId, 'x-preview-f-free');
    assert.equal(policy.resolvedBackendKey, 'ox-alpha-free');
  });
});

test('live ChatEngine routes an explicit opencode request to the OpenCode runner', () => {
  withTestEnv(() => {
    const engine = new ChatEngine({
      task: 't',
      projectRoot: process.cwd(),
      model: 'ox-alpha-free',
    });
    assert.equal((engine as unknown as { modelPolicy: { provider: string } }).modelPolicy.provider, 'opencode');
    const runner = (
      engine as unknown as { resolveDeliberationRunner: () => unknown }
    ).resolveDeliberationRunner();
    assert.ok(runner instanceof OpenCodeApiRunner);
  });
});

test('live chat still rejects legacy non-DeepSeek provider models', () => {
  withTestEnv(() => {
    assert.throws(
      () => new ChatEngine({ task: 't', projectRoot: process.cwd(), model: 'qwen3' }),
      /LIVE_MODEL_POLICY/,
    );
  });
});

test('ask lane resolves an explicit opencode request outside the DeepSeek-only gate', () => {
  withTestEnv(() => {
    const policy = resolveAskModelPolicyWithLiveGate(
      { model: 'ox-alpha-free' },
      true,
    );
    assert.ok(policy);
    assert.equal(policy.provider, 'opencode');
    assert.equal(policy.providerModelId, 'x-preview-f-free');
  });
});

test('ask lane keeps DeepSeek-only enforcement for other backends', () => {
  withTestEnv(() => {
    // resolveFamilyModelPolicy's fallback wraps policy denials, so accept both
    // the wrapped form and the raw LIVE_MODEL_POLICY denial — blocked is the
    // invariant.
    assert.throws(
      () => resolveAskModelPolicyWithLiveGate({ model: 'qwen3' }, true),
      /LIVE_MODEL_POLICY|is not configured/,
    );
    // No explicit model + non-live gate → no policy resolution at all.
    assert.equal(resolveAskModelPolicyWithLiveGate({}, false), undefined);
  });
});
