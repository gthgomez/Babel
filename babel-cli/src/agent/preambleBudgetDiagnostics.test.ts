import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistPreambleBudget } from './preambleBudgetDiagnostics.js';
import { enforcePreambleBudget, describePreambleBudget } from './preambleBudget.js';

test('preamble diagnostic is retained without writing stdout or stderr', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-preamble-diagnostic-'));
  const budget = enforcePreambleBudget('fixture instruction', 'fixture map', { historyTokens: 12, contextWindowTokens: 128000 });
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let terminalWrites = 0;
  try {
    process.stdout.write = process.stderr.write = (() => { terminalWrites++; return true; }) as typeof process.stdout.write;
    assert.equal(persistPreambleBudget(root, budget), true);
    assert.equal(persistPreambleBudget(join(root, 'missing'), budget), false);
  } finally { process.stdout.write = originalOut; process.stderr.write = originalErr; }
  assert.equal(terminalWrites, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'preamble-budget.json'), 'utf8')), describePreambleBudget(budget));
});
