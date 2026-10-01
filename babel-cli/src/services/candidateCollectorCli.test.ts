import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('candidate collector preserves the error and lets its host drain', () => {
  const source = `process.argv = ['node', 'collector', '--task'];
await import('./src/services/candidateCollectorCli.ts');
setImmediate(() => process.stdout.write('HOST_DRAINED\\n'));`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ERROR: Missing value for --task/);
  assert.match(result.stdout, /HOST_DRAINED/);
});
