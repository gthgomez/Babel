/**
 * G6 — IME cursor parking helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeImeCursorPos,
  cupSequence,
  shouldParkImeCursor,
} from './imeCursor.js';

describe('imeCursor', () => {
  it('computes caret under first-line prompt', () => {
    const pos = computeImeCursorPos({
      startRow: 20,
      queuedLines: 0,
      slashPopupLines: 0,
      cursorLine: 0,
      cursorCol: 3,
      prompt: '› ',
      continuationPrompt: '  ',
      termRows: 40,
      termCols: 80,
    });
    // prompt "› " is 2 cols → col = 1 + 2 + 3 = 6
    assert.equal(pos.row, 20);
    assert.equal(pos.col, 6);
  });

  it('accounts for continuation prompt on later lines', () => {
    const pos = computeImeCursorPos({
      startRow: 10,
      queuedLines: 0,
      slashPopupLines: 0,
      cursorLine: 1,
      cursorCol: 0,
      prompt: '› ',
      continuationPrompt: '..',
      termRows: 40,
      termCols: 80,
    });
    assert.equal(pos.row, 11);
    assert.equal(pos.col, 1 + 2 + 0);
  });

  it('offsets for queued lines and slash popup', () => {
    const pos = computeImeCursorPos({
      startRow: 5,
      queuedLines: 2,
      slashPopupLines: 3,
      cursorLine: 0,
      cursorCol: 0,
      prompt: '> ',
      continuationPrompt: '  ',
      termRows: 40,
      termCols: 80,
    });
    assert.equal(pos.row, 5 + 2 + 3);
  });

  it('cupSequence formats CSI H', () => {
    assert.equal(cupSequence({ row: 4, col: 7 }), '\x1b[4;7H');
  });

  it('shouldParkImeCursor true when composing', () => {
    assert.equal(shouldParkImeCursor(true), true);
  });
});
