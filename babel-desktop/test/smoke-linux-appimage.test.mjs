import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {stopProcessTree} from '../scripts/smoke-linux-appimage.mjs';

test('stopProcessTree kills a detached process and releases its pipes', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  await stopProcessTree(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.throws(() => process.kill(child.pid, 0));
});
