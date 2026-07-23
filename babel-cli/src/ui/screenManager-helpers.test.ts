// ─── ScreenManager Helper Tests ──────────────────────────────────────────────
// Tests for pure formatting helpers exported from screenManager.ts.

import test from 'node:test';
import assert from 'node:assert/strict';

// These helpers are internal to screenManager.ts. Read them via dynamic import
// after verifying they exist. If not exported, we test via ScreenManager API.
// For now, test the format functions by reading screenManager source patterns.

import { ScreenManager, type ScreenState } from './screenManager.js';
import { withAnsiTestEnv } from './testUtils.js';

const defaultState: ScreenState = {
  model: 'test-model',
  mode: 'chat',
  project: 'test-project',
  totalTokens: 0,
  totalCost: 0,
  turnCount: 0,
};

test('ScreenManager constructor creates instance', () => {
  const sm = new ScreenManager(defaultState);
  assert.ok(sm instanceof ScreenManager);
});

test('ScreenManager setup writes scroll region ANSI', () => {
  withAnsiTestEnv(() => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((c: unknown) => {
      writes.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    try {
      const sm = new ScreenManager(defaultState);
      sm.setup();
      const output = writes.join('');
      assert.ok(output.length > 0, 'setup should write ANSI sequences');
      assert.match(output, /\x1b\[/, 'output should contain ANSI escape sequences');
    } finally {
      process.stdout.write = orig;
    }
  });
});

test('ScreenManager teardown writes reset ANSI', () => {
  withAnsiTestEnv(() => {
    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((c: unknown) => {
      writes.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    try {
      const sm = new ScreenManager(defaultState);
      sm.setup();
      writes.length = 0; // clear setup output
      sm.teardown();
      const output = writes.join('');
      assert.match(output, /\x1b\[/, 'teardown should write ANSI reset sequences');
    } finally {
      process.stdout.write = orig;
    }
  });
});

test('ScreenManager writeContent pushes to buffer', () => {
  const writes: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((c: unknown) => {
    writes.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  try {
    const sm = new ScreenManager(defaultState);
    sm.writeContent('hello world');
    const output = writes.join('');
    assert.ok(output.includes('hello world'), 'writeContent should write text');
  } finally {
    process.stdout.write = orig;
  }
});

test('ScreenManager getScrollback returns buffer', () => {
  const sm = new ScreenManager(defaultState);
  const buffer = sm.getScrollback();
  assert.ok(buffer !== undefined, 'getScrollback should return a buffer');
});
