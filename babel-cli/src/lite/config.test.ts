import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LiteError,
  discoverLiteCatalogModels,
  formatLiteProviderQualifiedIdentity,
  loadLiteCatalogSnapshot,
  resolveLiteRouteIdentity,
} from './config.js';
import { connectionIdentityForRoute } from '../intelligence/route-selection.js';

const CATALOG_PATH = fileURLToPath(
  new URL('../../../config/model-catalog.generated.json', import.meta.url),
);

test('chat_lite_subagent_route_parity', () => {
  // Lite resolves to the same exact-case provider-qualified identity used by
  // the chat and subagent (ModelRouter) surfaces.
  const deepseek = resolveLiteRouteIdentity('deepseek', 'deepseek-v4-flash');
  assert.deepEqual(deepseek, { provider: 'deepseek', modelId: 'deepseek-v4-flash' });
  assert.equal(formatLiteProviderQualifiedIdentity(deepseek), 'deepseek:deepseek-v4-flash');

  // Provider-defined case is preserved exactly; it is never case-folded.
  const deepinfra = resolveLiteRouteIdentity('deepinfra', 'deepseek-ai/DeepSeek-V3-0324');
  assert.equal(deepinfra.modelId, 'deepseek-ai/DeepSeek-V3-0324');

  // The shared connection identity derives the exact same provider+model pair
  // that Lite selected, tying the surfaces to one identity discipline.
  const connection = connectionIdentityForRoute({
    routeId: 'lite-deepseek',
    ref: deepseek,
    enabled: true,
  });
  assert.equal(connection.provider, 'deepseek');
  assert.equal(connection.modelId, 'deepseek-v4-flash');

  // An unsupported model on an exact provider is a typed refusal.
  assert.throws(
    () => resolveLiteRouteIdentity('deepseek', 'deepseek-not-a-model'),
    (error: unknown) => error instanceof LiteError && error.code === 'PROVIDER_UNKNOWN',
  );

  // The in-process mock provider has no registered route identity, so Lite
  // never fabricates one.
  assert.throws(
    () => resolveLiteRouteIdentity('mock', 'mock-lite-model'),
    (error: unknown) => error instanceof LiteError && error.code === 'PROVIDER_UNKNOWN',
  );
});

test('offline_start_uses_snapshot_without_network', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error('network is not permitted on the offline start path');
  }) as typeof fetch;
  try {
    const snapshot = loadLiteCatalogSnapshot({ path: CATALOG_PATH });
    assert.equal(snapshot.schemaVersion, 1);
    assert.ok(snapshot.revision.length > 0);
    assert.ok(snapshot.providerModels.length > 0);

    // The packaged default path resolves the committed snapshot with no network.
    const defaultSnapshot = loadLiteCatalogSnapshot();
    assert.ok(defaultSnapshot.providerModels.length > 0);

    const models = discoverLiteCatalogModels({ path: CATALOG_PATH });
    assert.ok(models.length > 0);
    const glm = models.find((model) => model.ref.modelId === 'z-ai/glm-5.3-flash');
    assert.ok(glm);
    assert.equal(glm.ref.provider, 'openrouter');
    assert.equal(glm.ref.modelId, 'z-ai/glm-5.3-flash');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
