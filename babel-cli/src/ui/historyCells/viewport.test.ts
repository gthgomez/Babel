import assert from 'node:assert/strict';
import test from 'node:test';

import { stripAnsi } from '../theme.js';
import {
  createAssistantMessageCell,
  createToolCallCell,
  createUserMessageCell,
} from './cells.js';
import { HistoryCellViewport } from './viewport.js';
import { HistoryTranscript } from './transcript.js';

function buildLongTranscript(): HistoryTranscript {
  const transcript = new HistoryTranscript();
  transcript.beginTurn();
  transcript.onAnswerChunk('Intro.\n\n');
  for (let i = 0; i < 20; i++) {
    transcript.onAnswerChunk(`Paragraph ${i}: ${'word '.repeat(12)}`);
    transcript.beginToolCall(i + 1, 'file_read', `src/file${i}.ts`);
    transcript.completeToolCall(i + 1, `${i} KB`);
  }
  transcript.onAnswerChunk('Final summary.');
  transcript.finishTurn();
  return transcript;
}

test('HistoryCellViewport: getVisibleRows returns only viewport slice at bottom', () => {
  const viewport = new HistoryCellViewport(60);
  const transcript = buildLongTranscript();
  viewport.syncFromTranscript(transcript);

  assert.ok(viewport.totalRowCount > 10);
  const tail = viewport.getVisibleRows(5);
  assert.equal(tail.length, 5);
  assert.match(stripAnsi(tail.join('\n')), /Final summary/);
});

test('HistoryCellViewport: scroll offset reveals older rows', () => {
  const viewport = new HistoryCellViewport(60);
  viewport.syncFromTranscript(buildLongTranscript());

  const atBottom = stripAnsi(viewport.getVisibleRows(3).join('\n'));
  viewport.setScrollOffset(viewport.maxScrollOffset);
  const atTop = stripAnsi(viewport.getVisibleRows(3).join('\n'));

  assert.notEqual(atBottom, atTop);
  assert.doesNotMatch(atBottom, /Paragraph 0:/);
});

test('HistoryCellViewport: scrollToBottom resets offset and unseen', () => {
  const viewport = new HistoryCellViewport(60);
  viewport.syncFromTranscript(buildLongTranscript());
  viewport.setScrollOffset(10);
  viewport.incrementUnseen(3);
  viewport.scrollToBottom();

  const info = viewport.getScrollInfo();
  assert.equal(info.offset, 0);
  assert.equal(info.isAtBottom, true);
  assert.equal(info.unseenSinceLastView, 0);
});

test('HistoryCellViewport: setWidth reflows row heights', () => {
  const cell = createUserMessageCell('word '.repeat(30));
  const narrow = new HistoryCellViewport(40);
  const wide = new HistoryCellViewport(120);
  narrow.setCells([cell]);
  wide.setCells([cell]);

  assert.ok(narrow.totalRowCount >= wide.totalRowCount);
});

test('HistoryCellViewport: findCellIndexAtRow locates cells', () => {
  const viewport = new HistoryCellViewport(80);
  viewport.setCells([
    createUserMessageCell('hello'),
    createToolCallCell('file_read', 'a.ts', 'completed'),
    createAssistantMessageCell('done'),
  ]);

  const first = viewport.findCellIndexAtRow(0);
  const last = viewport.findCellIndexAtRow(viewport.totalRowCount - 1);
  assert.equal(first, 0);
  assert.equal(last, 2);
});

test('HistoryCellViewport: incremental sync skips identical cache key', () => {
  const viewport = new HistoryCellViewport(80);
  const transcript = new HistoryTranscript();
  transcript.beginTurn();
  transcript.onAnswerChunk('stable');
  viewport.syncFromTranscript(transcript);
  const rowsAfterFirst = viewport.totalRowCount;
  viewport.syncFromTranscript(transcript);
  assert.equal(viewport.totalRowCount, rowsAfterFirst);
  transcript.onAnswerChunk(' more');
  viewport.syncFromTranscript(transcript);
  assert.ok(viewport.totalRowCount >= rowsAfterFirst);
});

test('HistoryCellViewport: scrollToCell brings target near viewport top', () => {
  const viewport = new HistoryCellViewport(80);
  viewport.setCells([
    createUserMessageCell('first'),
    createAssistantMessageCell('middle '.repeat(20)),
    createUserMessageCell('last'),
  ]);

  viewport.scrollToCell(2, 5);
  const visible = stripAnsi(viewport.renderViewport(5));
  assert.match(visible, /last/);
});

test('HistoryCellViewport: search finds matches after warm index', () => {
  const viewport = new HistoryCellViewport(80);
  viewport.setCells([
    createUserMessageCell('searchable needle here'),
    createAssistantMessageCell('no match'),
    createToolCallCell('grep', '*.ts', 'completed', { detail: 'needle found' }),
  ]);
  viewport.warmSearchIndex();

  const matches = viewport.search('needle');
  assert.ok(matches.length >= 2);
  assert.ok(matches.some((match) => match.cellId !== undefined));
});