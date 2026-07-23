/**
 * SessionPicker unit tests — activity flag, non-TTY cancel, NO_COLOR safety.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionPicker } from './sessionPicker.js';
import { isA11yMode } from './a11y.js';
import type { ChatSessionInfo } from '../services/chatSessionIndex.js';

function makeSession(partial: Partial<ChatSessionInfo> & { id: string }): ChatSessionInfo {
  return {
    id: partial.id,
    mtimeMs: partial.mtimeMs ?? Date.now(),
    turnCount: partial.turnCount ?? 3,
    preview: partial.preview ?? 'hello world',
    transcriptPath: partial.transcriptPath ?? `/tmp/${partial.id}.jsonl`,
  };
}

test('SessionPicker.isActive is false when no picker is open', () => {
  assert.equal(SessionPicker.isActive(), false);
});

test('SessionPicker.show returns cancel on non-TTY', async () => {
  const origIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  try {
    assert.equal(SessionPicker.isActive(), false);
    const result = await SessionPicker.show([
      makeSession({ id: 'sess-1', preview: 'first session' }),
    ]);
    assert.deepEqual(result, { action: 'cancel' });
    assert.equal(SessionPicker.isActive(), false);
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
  }
});

test('SessionPicker.show returns cancel for empty session list', async () => {
  const result = await SessionPicker.show([]);
  assert.deepEqual(result, { action: 'cancel' });
  assert.equal(SessionPicker.isActive(), false);
});

test('NO_COLOR does not enable a11y mode (so picker CSI is not stripped)', () => {
  const prevNoColor = process.env['NO_COLOR'];
  const prevA11y = process.env['BABEL_A11Y'];
  process.env['NO_COLOR'] = '1';
  delete process.env['BABEL_A11Y'];
  try {
    assert.equal(isA11yMode(), false);
  } finally {
    if (prevNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = prevNoColor;
    if (prevA11y === undefined) delete process.env['BABEL_A11Y'];
    else process.env['BABEL_A11Y'] = prevA11y;
  }
});

test('BABEL_A11Y=1 enables a11y mode', () => {
  const prevNoColor = process.env['NO_COLOR'];
  const prevA11y = process.env['BABEL_A11Y'];
  delete process.env['NO_COLOR'];
  process.env['BABEL_A11Y'] = '1';
  try {
    assert.equal(isA11yMode(), true);
  } finally {
    if (prevNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = prevNoColor;
    if (prevA11y === undefined) delete process.env['BABEL_A11Y'];
    else process.env['BABEL_A11Y'] = prevA11y;
  }
});

test('interactive picker is opt-in (default is plain; non-TTY still cancels)', async () => {
  const prevFlag = process.env['BABEL_INTERACTIVE_RESUME_PICKER'];
  delete process.env['BABEL_INTERACTIVE_RESUME_PICKER'];

  const origIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  try {
    const result = await SessionPicker.show([
      {
        id: 'chat-1',
        mtimeMs: Date.now(),
        turnCount: 1,
        preview: 'hi',
        transcriptPath: '/tmp/chat-1.jsonl',
      },
    ]);
    // Non-TTY short-circuits before plain/interactive
    assert.deepEqual(result, { action: 'cancel' });
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
    if (prevFlag === undefined) delete process.env['BABEL_INTERACTIVE_RESUME_PICKER'];
    else process.env['BABEL_INTERACTIVE_RESUME_PICKER'] = prevFlag;
  }
});
