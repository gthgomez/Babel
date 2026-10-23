// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runTokenUsageAudit } from '../src/audit/tokenUsage.js';
import { runAgentBenchmarkSuite } from '../src/services/agentBenchmark.js';

test('complete catalog token audit preserves successful and failed scenario accounting', () => {
  const result = runTokenUsageAudit({ writeArtifacts: false, generatedAt: '2026-05-14T00:00:00.000Z' });
  assert.equal(result.summary.generatedAt, '2026-05-14T00:00:00.000Z');
  assert.equal(result.summary.tokenizerEncoding, 'o200k_base');
  assert.ok(result.summary.scenarioCount > 0);
  assert.equal(result.summary.successCount + result.summary.failureCount, result.summary.scenarioCount);
  assert.ok(result.entryMeasurements.length > 0);
});

test('real local mock parity benchmark produces a single selected cell and artifact', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'babel-benchmark-integration-'));
  try {
    const report = await runAgentBenchmarkSuite({ tier: 'A_daily', provider: 'mock', taskId: 'PAR-A01', evidenceDir });
    assert.equal(report.summary.tasks_selected, 1);
    assert.equal(report.results[0]?.benchmark_task_id, 'PAR-A01');
    assert.equal(report.results[0]?.source, 'babel_parity');
    assert.ok(existsSync(report.artifact_path));
    assert.ok(report.improvement_actions.length > 0);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});
