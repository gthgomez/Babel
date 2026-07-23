import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildLiteUsabilityReport } from './liteUsability.js';

test.skip('lite usability fixtures keep daily session routes shorter than full Babel', () => {
  // SKIP: functionality consolidated into chat mode — routing uses 'run' not 'daily'
  const outputDir = mkdtempSync(join(tmpdir(), 'babel-lite-usability-'));
  const report = buildLiteUsabilityReport({ outputDir });

  assert.equal(report.benchmark_type, 'babel_lite_usability');
  assert.equal(report.summary.scenarios, 8);
  assert.equal(report.summary.fail, 0);
  for (const scenario of report.scenarios) {
    assert.equal(scenario.status, 'pass');
    assert.equal(scenario.comparison.shorter_than_full, true);
  }
});
