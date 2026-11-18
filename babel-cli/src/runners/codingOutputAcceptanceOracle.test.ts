import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('ordinary-bug qualification oracle accepts equivalent correct implementations', () => {
  const result = spawnSync(
    process.execPath,
    [join(packageRoot, 'fixtures/coding-output-acceptance/oracle/ordinary-bug/grader.selftest.mjs')],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? '{}') as {
    accepted?: string[];
    rejected?: string[];
  };
  for (const name of ['canonical', 'commuted', 'reduce', 'spread-sum']) {
    assert.ok(report.accepted?.includes(name), `${name} must be accepted`);
  }
  for (const name of [
    'subtracts',
    'negative-collapse',
    'wrong-on-negative',
    'hardcoded-only-visible-case',
    'returns-string',
    'table-reading-spoof',
    'empty-stdout-report',
    'exits-during-import',
    'forged-stdout-report',
  ]) {
    assert.ok(report.rejected?.includes(name), `${name} must be rejected`);
  }
});
