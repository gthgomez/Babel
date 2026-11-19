/**
 * TF-23 — compaction failure state must be scoped to one run/session.
 *
 * `autoCompactIfNeeded` used a module-level consecutive-failure counter, so a
 * failing governed pipeline could trip the circuit breaker for an unrelated
 * session in the same process. The counter now lives in an explicit run state
 * the caller owns.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  autoCompactIfNeeded,
  createCompactionCircuitState,
  resetCompactionCircuitBreaker,
} from './compaction.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';

function logEntries(count: number): ToolCallLog[] {
  return Array.from({ length: count }, (_, index) => ({
    step: index + 1,
    tool: 'read_file' as const,
    target: `src/file-${index}.ts`,
    exit_code: 0,
    stdout: 'x'.repeat(4_096),
    stderr: '',
    read_only: true,
  })) as unknown as ToolCallLog[];
}

test('three failures in one run do not disable compaction for another run', async () => {
  const first = createCompactionCircuitState();
  const second = createCompactionCircuitState();

  first.consecutiveFailures = 3;
  const skipped = await autoCompactIfNeeded('history', 9, logEntries(8), undefined, undefined, first);
  assert.equal(skipped.compacted, false, 'the failed run must stay tripped');

  const other = await autoCompactIfNeeded('history', 9, logEntries(8), undefined, undefined, second);
  assert.equal(other.compacted, true, 'an unrelated run must still compact');
  assert.ok(other.tokensAfter < other.tokensBefore || other.bytesPruned > 0);
});

test('a failure increments only the supplied run state', async () => {
  const failing = createCompactionCircuitState();
  const healthy = createCompactionCircuitState();

  const hostile = [{
    step: 1,
    tool: 'read_file',
    target: 'src/broken.ts',
    exit_code: 0,
    get stdout(): string {
      throw new Error('synthetic read failure');
    },
    stderr: '',
    read_only: true,
  }, ...logEntries(6).slice(1)] as unknown as ToolCallLog[];

  for (let i = 0; i < 2; i++) {
    await autoCompactIfNeeded('history', 9, hostile, undefined, undefined, failing);
  }

  assert.equal(failing.consecutiveFailures, 2);
  assert.equal(healthy.consecutiveFailures, 0, 'a sibling run must not inherit failures');
  assert.equal((await autoCompactIfNeeded('history', 9, logEntries(8), undefined, undefined, healthy)).compacted, true);
});

test('interleaved failures in one run leave a concurrent sibling free to compact', async () => {
  const failing = createCompactionCircuitState();
  const healthy = createCompactionCircuitState();
  const hostile = [{
    step: 1,
    tool: 'read_file',
    target: 'src/broken.ts',
    exit_code: 0,
    get stdout(): string {
      throw new Error('synthetic read failure');
    },
    stderr: '',
    read_only: true,
  }, ...logEntries(6).slice(1)] as unknown as ToolCallLog[];

  const [failedRun, healthyRun] = await Promise.all([
    (async () => {
      for (let i = 0; i < 3; i++) {
        await autoCompactIfNeeded('history', 9, hostile, undefined, undefined, failing);
      }
      return autoCompactIfNeeded('history', 9, logEntries(8), undefined, undefined, failing);
    })(),
    autoCompactIfNeeded('history', 9, logEntries(8), undefined, undefined, healthy),
  ]);

  assert.equal(failing.consecutiveFailures, 3);
  assert.equal(failedRun.compacted, false);
  assert.equal(healthy.consecutiveFailures, 0);
  assert.equal(healthyRun.compacted, true);
});

test('reset clears only the targeted run state', async () => {
  const first = createCompactionCircuitState();
  const second = createCompactionCircuitState();
  first.consecutiveFailures = 3;
  second.consecutiveFailures = 3;

  resetCompactionCircuitBreaker(first);

  assert.equal(first.consecutiveFailures, 0);
  assert.equal(second.consecutiveFailures, 3);
  assert.equal((await autoCompactIfNeeded('history', 9, logEntries(8), undefined, undefined, first)).compacted, true);
});
