import assert from 'node:assert/strict';
import test from 'node:test';
import { OutputBuffer } from './outputBuffer.js';
import { registerExclusiveTerminalRunner } from './inputCoordinator.js';
import { renderInteractiveChecklist } from './checklist.js';
import { renderInteractivePlan } from './planView.js';

async function prompt<T>(work: () => Promise<T>, keys: string): Promise<{ result: T; output: string }> {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const originalWrite = process.stdout.write;
  const a11y = process.env['BABEL_A11Y'];
  const offline = process.env['BABEL_PIPELINE_V9_OFFLINE'];
  let output = '';
  let ownsSurface = false;
  const release = registerExclusiveTerminalRunner(async (reason, run) => {
    assert.equal(reason, 'raw-stdin-prompt');
    ownsSurface = true;
    try { return await run(); } finally { ownsSurface = false; }
  });
  try {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env['BABEL_A11Y'] = '1';
    delete process.env['BABEL_PIPELINE_V9_OFFLINE'];
    OutputBuffer.resetInstance();
    process.stdout.write = ((chunk: unknown) => { assert.equal(ownsSurface, true); output += String(chunk); return true; }) as typeof process.stdout.write;
    const pending = work();
    assert.equal(ownsSurface, true);
    process.stdin.emit('data', Buffer.from(keys));
    const result = await pending;
    assert.equal(ownsSurface, false);
    return { result, output };
  } finally {
    // Synthetic key delivery opens stdin's flowing mode; release that test-owned handle.
    process.stdin.pause();
    process.stdout.write = originalWrite;
    if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    if (a11y === undefined) delete process.env['BABEL_A11Y']; else process.env['BABEL_A11Y'] = a11y;
    if (offline === undefined) delete process.env['BABEL_PIPELINE_V9_OFFLINE']; else process.env['BABEL_PIPELINE_V9_OFFLINE'] = offline;
    OutputBuffer.resetInstance();
    release();
  }
}

test('checklist keeps selected steps, controls and exclusive terminal ownership', async () => {
  const steps = [{ description: 'Read', tool: 'read_file' }, { description: 'Test', tool: 'shell' }];
  const { result, output } = await prompt(() => renderInteractiveChecklist(steps), ' \r');
  assert.deepEqual(result, [steps[1]]);
  assert.match(output, /Review Implementation Plan/);
  assert.ok(output.includes('\x1b[s') && output.includes('\x1b[u') && output.includes('\x1b[J'));
  assert.doesNotMatch(output, /\x1b\[\d+m/);
});

for (const [keys, expected] of [['a', 'approve'], ['e', 'edit'], ['r', 'reject'], ['\x03', null]] as const) {
  test(`plan decision ${expected} preserves prompt rendering and ownership`, async () => {
    const { result, output } = await prompt(() => renderInteractivePlan({ taskSummary: 'Review changes', steps: [{ description: 'Inspect code', tool: 'read_file' }] }), keys);
    assert.equal(result, expected);
    assert.match(output, /Inspect code/);
    assert.ok(output.includes('\x1b[2J\x1b[H'));
    assert.doesNotMatch(output, /\x1b\[\d+m/);
  });
}
