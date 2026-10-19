import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runGitCommand, runGitCommandBytes } from './gitExec.js';

const options = {
  env: { ...process.env, BABEL_GIT_PATH: process.execPath },
  timeoutMs: 5000,
};

test('raw Git transport preserves invalid UTF-8 bytes while text callers retain decoding', () => {
  const args = ['-e', 'process.stdout.write(Buffer.from([0x61, 0xff, 0x00]))'];
  const raw = runGitCommandBytes(args, process.cwd(), options);
  assert.equal(raw.status, 0);
  assert.deepEqual(raw.stdout, Buffer.from([0x61, 0xff, 0x00]));
  const text = runGitCommand(args, process.cwd(), options);
  assert.equal(text.status, 0);
  assert.equal(text.stdout, 'a\ufffd\0');
});

test('raw Git transport preserves process failure and bounded output admission', () => {
  const failed = runGitCommandBytes(['-e', 'process.exit(7)'], process.cwd(), options);
  assert.equal(failed.status, 7);
  const oversized = runGitCommandBytes(
    ['-e', 'process.stdout.write(Buffer.alloc(32768))'],
    process.cwd(),
    { ...options, maxBuffer: 1024 },
  );
  assert.notEqual(oversized.status, 0);
});
