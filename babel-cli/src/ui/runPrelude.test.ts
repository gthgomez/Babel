import assert from 'node:assert/strict';
import test from 'node:test';

import { renderTextRunPrelude, writeTextRunPrelude } from './runPrelude.js';
import { OutputBuffer } from './outputBuffer.js';
import { stripAnsi } from './theme.js';

test('default prelude output uses the coordinated terminal buffer', (context) => {
  const writes: string[] = [];
  context.mock.method(OutputBuffer.getInstance(), 'write', (text: string) => { writes.push(text); });
  const prelude = { task: 'Coordinated prelude', mode: 'deep' as const };
  writeTextRunPrelude(prelude);
  assert.deepEqual(writes, [renderTextRunPrelude(prelude)]);
});

test('an explicit prelude stream retains output ownership', (context) => {
  const writes: string[] = [];
  const bufferWrite = context.mock.method(OutputBuffer.getInstance(), 'write', () => {});
  context.mock.method(process.stdout, 'write', (text: string) => { writes.push(text); return true; });
  const prelude = { task: 'Explicit stream', mode: 'deep' as const };
  writeTextRunPrelude(prelude, process.stdout);
  assert.equal(writes.at(-1), renderTextRunPrelude(prelude));
  assert.equal(bufferWrite.mock.callCount(), 0);
});

test('renderTextRunPrelude includes task and pipeline sections', () => {
  const rendered = stripAnsi(
    renderTextRunPrelude({
      task: 'Fix failing tests',
      mode: 'deep',
      project: 'Babel',
      orchestrator: 'v9',
      executionProfile: 'safe_repo',
    }),
  );
  assert.match(rendered, /Fix failing tests/);
  assert.match(rendered, /PIPELINE/);
  assert.match(rendered, /STATUS/);
});

test('renderTextRunPrelude shows plan warning for plan mode', () => {
  const rendered = stripAnsi(
    renderTextRunPrelude({
      task: 'Prepare rollout plan',
      mode: 'plan',
    }),
  );
  assert.match(rendered, /PLAN MODE ACTIVE/);
});
