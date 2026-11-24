import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteVisualSelection,
  getNormalizedVisualRange,
  getSelectionColRange,
  getVisualSelectionText,
} from './promptVisualRange.js';

test('normalizes a backward character selection with an exclusive end column', () => {
  assert.deepEqual(getNormalizedVisualRange({
    visualStart: { line: 1, col: 2 },
    visualMode: 'char',
    cursorLine: 0,
    cursorCol: 1,
    lines: ['alpha', 'bravo'],
  }), { startLine: 0, startCol: 1, endLine: 1, endCol: 3 });
});

test('returns per-line selection columns for character and line selections', () => {
  const lines = ['alpha', 'bravo', 'charlie'];
  assert.deepEqual(getSelectionColRange({
    line: 2, lines, visualStart: { line: 0, col: 2 }, visualMode: 'char', cursorLine: 2, cursorCol: 3,
  }), { start: 0, end: 4 });
  assert.deepEqual(getSelectionColRange({
    line: 1, lines, visualStart: { line: 0, col: 2 }, visualMode: 'line', cursorLine: 2, cursorCol: 0,
  }), { start: 0, end: 5 });
});

test('deletes a multiline character selection and yanks the same exact text', () => {
  const lines = ['alpha', 'bravo'];
  const selection = {
    visualStart: { line: 0, col: 1 },
    visualMode: 'char' as const,
    cursorLine: 1,
    cursorCol: 2,
  };
  assert.equal(getVisualSelectionText({ ...selection, lines }), 'lpha\nbra');
  assert.deepEqual(deleteVisualSelection({ ...selection, lines }), {
    killBuffer: 'lpha\nbra', cursorLine: 0, cursorCol: 1,
  });
  assert.deepEqual(lines, ['avo']);
});
