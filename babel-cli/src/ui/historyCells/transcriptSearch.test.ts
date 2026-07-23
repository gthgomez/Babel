import assert from 'node:assert/strict';
import test from 'node:test';

import { stripAnsi } from '../theme.js';
import {
  createAssistantMessageCell,
  createToolCallCell,
  createUserMessageCell,
} from './cells.js';
import { TranscriptSearchIndex, historyCellSearchText } from './transcriptSearch.js';
import { HistoryCellViewport } from './viewport.js';
import { HistoryTranscript } from './transcript.js';

test('TranscriptSearchIndex: warmFromViewportEntries indexes lowercase rows', () => {
  const viewport = new HistoryCellViewport(80);
  viewport.setCells([
    createUserMessageCell('Find the BUG in auth'),
    createToolCallCell('file_read', 'auth.ts', 'completed', { detail: 'Reading auth.ts' }),
    createAssistantMessageCell('The bug is in line 42.'),
  ]);
  viewport.warmSearchIndex();

  const matches = viewport.search('bug');
  assert.ok(matches.length >= 2);
  assert.ok(matches.every((match) => match.rowIndex >= 0));
});

test('TranscriptSearchIndex: warmFromLines supports scrollback fallback', () => {
  const index = new TranscriptSearchIndex();
  index.warmFromLines(['Hello World', 'Another line with WORLD']);

  const matches = index.search('world');
  assert.deepEqual(
    matches.map((match) => match.rowIndex),
    [0, 1],
  );
});

test('TranscriptSearchIndex: search is case-insensitive', () => {
  const index = new TranscriptSearchIndex();
  index.warmFromLines(['CamelCase Value']);

  assert.equal(index.search('camelcase').length, 1);
  assert.equal(index.search('VALUE').length, 1);
  assert.equal(index.search('missing').length, 0);
});

test('historyCellSearchText: strips ANSI and lowercases', () => {
  const cell = createAssistantMessageCell('Hello **World**');
  const text = historyCellSearchText(cell, 80);
  assert.match(text, /hello/);
  assert.doesNotMatch(text, /\x1b/);
});

test('HistoryCellViewport: warmSearchIndex returns 0 on cache hit', () => {
  const viewport = new HistoryCellViewport(80);
  viewport.setCells([createUserMessageCell('stable content')]);
  const first = viewport.warmSearchIndex();
  const second = viewport.warmSearchIndex();
  assert.ok(first >= 0);
  assert.equal(second, 0);
});

test('HistoryCellViewport: scrollToMatch centers target row', () => {
  const viewport = new HistoryCellViewport(40);
  const transcript = new HistoryTranscript();
  transcript.beginTurn();
  for (let i = 0; i < 30; i++) {
    transcript.onAnswerChunk(`line ${i} alpha beta gamma`);
  }
  transcript.finishTurn();
  viewport.syncFromTranscript(transcript);
  viewport.warmSearchIndex();

  const matches = viewport.search('line 5');
  assert.ok(matches.length > 0);
  viewport.scrollToMatch(matches[0]!, 5);

  const visible = stripAnsi(viewport.getVisibleRows(5).join('\n'));
  assert.match(visible, /line 5/);
});