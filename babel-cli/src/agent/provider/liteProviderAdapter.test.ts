import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createLiteProviderAdapter,
  normalizeLiteWorkflowProvider,
  providerUsesOfflineEnv,
  resolveLiteProviders,
  resolveSmallFixProviderForCommand,
} from './liteProviderAdapter.js';

describe('liteProviderAdapter', () => {
  it('normalizes workflow provider flags', () => {
    assert.equal(normalizeLiteWorkflowProvider('mock'), 'mock');
    assert.equal(normalizeLiteWorkflowProvider('live'), 'live');
    assert.throws(() => normalizeLiteWorkflowProvider('offline'), /Invalid provider/);
  });

  it('maps live/mock to text provider ids with env offline fallback', () => {
    assert.deepEqual(resolveLiteProviders({ provider: 'mock' }), {
      fixProvider: 'mock',
      textProviderId: 'mock',
      offlineDemo: true,
    });
    assert.deepEqual(resolveLiteProviders({ provider: 'live' }), {
      fixProvider: 'live',
      textProviderId: 'auto',
      offlineDemo: false,
    });
    assert.deepEqual(resolveLiteProviders({}, { BABEL_LITE_OFFLINE: '1' }), {
      fixProvider: 'mock',
      textProviderId: 'mock',
      offlineDemo: true,
    });
    assert.deepEqual(resolveLiteProviders({}), {
      fixProvider: 'live',
      textProviderId: 'auto',
      offlineDemo: false,
    });
  });

  it('exposes adapter helpers and legacy fix resolver', () => {
    const adapter = createLiteProviderAdapter({ BABEL_LITE_OFFLINE: '1' });
    assert.equal(adapter.resolveFixProvider(), 'mock');
    assert.equal(adapter.resolveTextProviderId(), 'mock');
    assert.equal(
      resolveSmallFixProviderForCommand({ provider: 'live' }, { BABEL_LITE_OFFLINE: '1' }),
      'live',
    );
  });

  it('flags provider-aware verbs', () => {
    assert.equal(providerUsesOfflineEnv('fix'), true);
    assert.equal(providerUsesOfflineEnv('propose'), true);
    assert.equal(providerUsesOfflineEnv('patch'), true);
    assert.equal(providerUsesOfflineEnv('diff'), true);
    assert.equal(providerUsesOfflineEnv('plan'), false);
  });
});
