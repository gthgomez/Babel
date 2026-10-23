import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCatalog } from '../control-plane/catalog.js';

import { runTokenUsageAudit } from './tokenUsage.js';

test('token audit reports scenario failures without claiming successful measurements', () => {
  const domain = parseCatalog(fileURLToPath(new URL('../../../prompt_catalog.yaml', import.meta.url)))
    .find(entry => entry.layer === 'domain_architect' && entry.status === 'active');
  assert.ok(domain);
  const result = runTokenUsageAudit({
    writeArtifacts: false,
    generatedAt: '2026-05-14T00:00:00.000Z',
  }, {
    loadCatalog: () => [{ ...domain, defaultSkillIds: ['fixture-skill'] }],
    loadSupplements: () => new Map(),
    measureEntry: entry => {
      assert.ok(entry.path, 'fixture domain must have a prompt path');
      return { id: entry.id, layer: entry.layer, relativePath: entry.path,
        declaredTokenBudget: 10, actualCompiledTokens: 12, deltaFromDeclared: 2, tags: [] };
    },
    analyze: () => { throw new Error('synthetic scenario failure'); },
  });

  assert.equal(result.summary.generatedAt, '2026-05-14T00:00:00.000Z');
  assert.equal(result.summary.tokenizerEncoding, 'o200k_base');
  assert.equal(result.summary.scenarioCount, 2);
  assert.equal(result.summary.successCount, 0);
  assert.equal(result.summary.failureCount, 2);
  assert.equal(result.scenarioFailures.every(failure => failure.error === 'synthetic scenario failure'), true);
  assert.equal(result.entryMeasurements.length, 1);
  assert.equal(
    result.summary.successCount + result.summary.failureCount,
    result.summary.scenarioCount,
  );
  assert.equal(Array.isArray(result.entryMeasurements), true);
  assert.equal(
    result.latestJsonPath.endsWith('artifacts\\token-audit\\latest\\token-usage-audit.json') ||
      result.latestJsonPath.endsWith('artifacts/token-audit/latest/token-usage-audit.json'),
    true,
  );
});
