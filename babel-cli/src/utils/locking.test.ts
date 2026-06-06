import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireLock, releaseLock } from './locking.js';

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'babel-locking-'));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('acquireLock blocks competing owners and lets the owner extend', () => {
  const fixture = makeRoot();
  try {
    const first = acquireLock('src/file.ts', fixture.root, 'agent-a', 'run-a', 'first', 60);
    assert.equal(first.success, true);

    const second = acquireLock('src/file.ts', fixture.root, 'agent-b', 'run-b', 'second', 60);
    assert.equal(second.success, false);
    assert.match(second.message, /already locked/);

    const extension = acquireLock('src/file.ts', fixture.root, 'agent-a', 'run-a', 'extend', 60);
    assert.equal(extension.success, true);
    assert.match(extension.message, /extended/);
  } finally {
    fixture.cleanup();
  }
});

test('releaseLock refuses to release another run owner', () => {
  const fixture = makeRoot();
  try {
    assert.equal(acquireLock('src/file.ts', fixture.root, 'agent-a', 'run-a', 'first', 60).success, true);

    const release = releaseLock('src/file.ts', fixture.root, 'run-b');
    assert.equal(release.success, false);
    assert.match(release.message, /Refusing to release/);
  } finally {
    fixture.cleanup();
  }
});
