import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const oracleRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/coding-output-acceptance/oracle/multi-file',
);

test('multi-file acceptance grader selftest (operator oracle, no live API)', () => {
  const output = execFileSync(process.execPath, [join(oracleRoot, 'grader.selftest.mjs')], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.match(output, /grader_selftest.*pass/);
});
