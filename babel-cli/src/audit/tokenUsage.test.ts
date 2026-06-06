import assert from 'node:assert/strict';
import test from 'node:test';

import { runTokenUsageAudit } from './tokenUsage.js';

test('token usage audit generates the expected summary shape without writing artifacts', () => {
  const result = runTokenUsageAudit({
    writeArtifacts: false,
    generatedAt: '2026-05-14T00:00:00.000Z',
  });

  assert.equal(result.summary.generatedAt, '2026-05-14T00:00:00.000Z');
  assert.equal(result.summary.tokenizerEncoding, 'o200k_base');
  assert.equal(result.summary.scenarioCount > 0, true);
  assert.equal(result.summary.successCount + result.summary.failureCount, result.summary.scenarioCount);
  assert.equal(Array.isArray(result.entryMeasurements), true);
  assert.equal(result.latestJsonPath.endsWith('artifacts\\token-audit\\latest\\token-usage-audit.json') || result.latestJsonPath.endsWith('artifacts/token-audit/latest/token-usage-audit.json'), true);
});
