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

test('HistoryCellViewport: reuses unchanged measurements when only the tail changes', () => {
  const viewport = new HistoryCellViewport(80);
  const committed = Array.from({ length: 10_000 }, (_, index) =>
    createUserMessageCell(`cell ${index}`, { cell_id: `cell-${index}` }),
  );
  viewport.setCells(committed);

  viewport.resetOperationCounts();
  viewport.setCells([
    ...committed,
    createAssistantMessageCell('live answer', {
      cell_id: 'live-answer',
      lifecycle: 'active',
      revision: 1,
    }),
  ]);

  const counts = viewport.getOperationCounts();
  assert.ok(
    counts.cellsMeasured <= 1,
    `remeasured ${counts.cellsMeasured} cells`,
  );
});

test('HistoryCellViewport: indexed visible lookup visits only the visible neighborhood', () => {
  const viewport = new HistoryCellViewport(80);
  viewport.setCells(
    Array.from({ length: 10_000 }, (_, index) =>
      createUserMessageCell(`cell ${index}`, { cell_id: `cell-${index}` }),
    ),
  );

  viewport.resetOperationCounts();
  const visible = viewport.getVisibleRows(4);
  const counts = viewport.getOperationCounts();

  assert.equal(visible.length, 4);
  assert.ok(
    counts.visibleEntriesVisited <= 8,
    `visited ${counts.visibleEntriesVisited} entries`,
  );
  assert.ok(counts.visibleLookupSteps <= 20);
});

test('HistoryCellViewport: preserves a scrolled cell anchor while tail content grows', () => {
  const viewport = new HistoryCellViewport(80);
  const cells = Array.from({ length: 20 }, (_, index) =>
    createUserMessageCell(`cell ${index}`, { cell_id: `cell-${index}` }),
  );
  viewport.setCells(cells);
  viewport.setScrollOffset(5);
  const before = stripAnsi(viewport.getVisibleRows(3).join('\n'));

  viewport.setCells([
    ...cells,
    createAssistantMessageCell('new tail', { cell_id: 'new-tail' }),
  ]);

  assert.equal(stripAnsi(viewport.getVisibleRows(3).join('\n')), before);
});

test('HistoryCellViewport: same-count revision replaces visible rows and search results', () => {
  const viewport = new HistoryCellViewport(80);
  viewport.setCells([
    createAssistantMessageCell('draft needle', {
      cell_id: 'assistant-1',
      lifecycle: 'active',
      revision: 1,
    }),
  ]);
  viewport.warmSearchIndex();

  assert.match(stripAnsi(viewport.renderViewport(5)), /draft needle/);
  assert.equal(viewport.search('draft').length, 1);

  viewport.setCells([
    createAssistantMessageCell('final answer', {
      cell_id: 'assistant-1',
      lifecycle: 'active',
      revision: 2,
    }),
  ]);

  assert.match(stripAnsi(viewport.renderViewport(5)), /final answer/);
  assert.doesNotMatch(stripAnsi(viewport.renderViewport(5)), /draft needle/);
  assert.equal(viewport.search('draft').length, 0);
  assert.equal(viewport.search('final').length, 1);
});

test('HistoryCellViewport: changed prefix and middle rebuild while unchanged suffix survives', () => {
  const viewport = new HistoryCellViewport(80);
  const first = createUserMessageCell('old first', { cell_id: 'first' });
  const middle = createAssistantMessageCell('old middle', {
    cell_id: 'middle',
  });
  const suffix = createToolCallCell('read', 'stable.ts', 'completed', {
    cell_id: 'suffix',
  });
  viewport.setCells([first, middle, suffix]);

  const replacement = createUserMessageCell('new first', {
    cell_id: 'first',
    revision: 1,
  });
  const middleReplacement = createAssistantMessageCell('new middle', {
    cell_id: 'middle',
    revision: 1,
  });
  viewport.setCells([replacement, middleReplacement, suffix]);

  assert.deepEqual(
    viewport.cellEntries.map((entry) => entry.cellId),
    ['first', 'middle', 'suffix'],
  );
  assert.equal(viewport.cellEntries[0]?.cell, replacement);
  assert.equal(viewport.cellEntries[1]?.cell, middleReplacement);
  assert.equal(viewport.cellEntries[2]?.cell, suffix);
  assert.match(
    stripAnsi(viewport.renderViewport(viewport.totalRowCount)),
    /new first/,
  );
  assert.match(
    stripAnsi(viewport.renderViewport(viewport.totalRowCount)),
    /new middle/,
  );
  assert.doesNotMatch(
    stripAnsi(viewport.renderViewport(viewport.totalRowCount)),
    /old first/,
  );
  assert.doesNotMatch(
    stripAnsi(viewport.renderViewport(viewport.totalRowCount)),
    /old middle/,
  );
});

test('HistoryCellViewport: append, truncate, reorder and clear keep rows and offsets consistent', () => {
  const viewport = new HistoryCellViewport(80);
  const first = createUserMessageCell('first', { cell_id: 'first' });
  const second = createAssistantMessageCell('second', { cell_id: 'second' });
  const third = createToolCallCell('read', 'third.ts', 'completed', {
    cell_id: 'third',
  });
  viewport.setCells([first, second]);
  viewport.setCells([first, second, third]);
  assert.equal(viewport.getScrollInfo().cellCount, 3);

  viewport.setCells([first]);
  assert.equal(viewport.getScrollInfo().cellCount, 1);
  assert.equal(viewport.findCellIndexAtRow(0), 0);

  viewport.setCells([second, first]);
  assert.deepEqual(
    viewport.cellEntries.map((entry) => entry.cellId),
    ['second', 'first'],
  );
  assert.equal(
    viewport.findCellIndexAtRow(viewport.cellEntries[1]!.startRow),
    1,
  );

  viewport.setScrollOffset(viewport.maxScrollOffset);
  viewport.incrementUnseen(2);
  viewport.setCells([]);
  assert.equal(viewport.totalRowCount, 0);
  assert.equal(viewport.scrollOffsetRows, 0);
  assert.equal(viewport.getScrollInfo().unseenSinceLastView, 0);
});

test('HistoryCellViewport: same-count session replacement resets stale anchor and unseen state', () => {
  const viewport = new HistoryCellViewport(80);
  viewport.setCells([
    createUserMessageCell('old session first', { cell_id: 'old-1' }),
    createAssistantMessageCell('old session second', { cell_id: 'old-2' }),
  ]);
  viewport.setScrollOffset(viewport.maxScrollOffset);
  viewport.incrementUnseen(4);

  viewport.setCells([
    createUserMessageCell('new session first', { cell_id: 'new-1' }),
    createAssistantMessageCell('new session second', { cell_id: 'new-2' }),
  ]);

  assert.equal(viewport.scrollOffsetRows, 0);
  assert.equal(viewport.getScrollInfo().unseenSinceLastView, 0);
  assert.match(stripAnsi(viewport.renderViewport(5)), /new session second/);
  assert.doesNotMatch(stripAnsi(viewport.renderViewport(5)), /old session/);
});

test('HistoryCellViewport: committed lifecycle revisions are detected away from the tail', () => {
  const viewport = new HistoryCellViewport(80);
  const transcript = new HistoryTranscript();
  transcript.beginTurn();
  transcript.beginToolCall(1, 'read', 'first.ts');
  transcript.beginToolCall(2, 'read', 'second.ts');
  viewport.syncFromTranscript(transcript);
  assert.match(stripAnsi(viewport.renderViewport(10)), /second.ts/);

  transcript.completeToolCall(1, 'permission denied', true);
  viewport.syncFromTranscript(transcript);

  const visible = stripAnsi(viewport.renderViewport(10));
  assert.match(visible, /permission denied/);
  assert.match(visible, /✗/);
});

test('HistoryCellViewport: payload mutation without a revision does not reuse stale rows', () => {
  const viewport = new HistoryCellViewport(80);
  const cell = createAssistantMessageCell('before mutation', {
    cell_id: 'mutable',
    revision: 1,
  });
  viewport.setCells([cell]);

  (cell.record.payload as { message: string }).message = 'after mutation';
  viewport.setCells([cell]);

  const visible = stripAnsi(viewport.renderViewport(5));
  assert.match(visible, /after mutation/);
  assert.doesNotMatch(visible, /before mutation/);
});

test('HistoryCellViewport: search and unseen state remain coherent while a scrolled tail grows', () => {
  const viewport = new HistoryCellViewport(80);
  const cells = Array.from({ length: 6 }, (_, index) =>
    createUserMessageCell(`row ${index}`, { cell_id: `row-${index}` }),
  );
  viewport.setCells(cells);
  viewport.warmSearchIndex();
  viewport.setScrollOffset(2);
  const before = stripAnsi(viewport.renderViewport(2));

  viewport.setCells([
    ...cells,
    createAssistantMessageCell('new tail needle', { cell_id: 'tail' }),
  ]);

  assert.equal(stripAnsi(viewport.renderViewport(2)), before);
  assert.equal(viewport.search('needle').length, 1);
  assert.ok(viewport.getScrollInfo().unseenSinceLastView > 0);
});

test('HistoryCellViewport: operation counts expose comparisons, index work and bounded measurements', () => {
  const viewport = new HistoryCellViewport(80);
  const committed = Array.from({ length: 10_000 }, (_, index) =>
    createUserMessageCell(`cell ${index}`, { cell_id: `cell-${index}` }),
  );
  viewport.setCells(committed);
  viewport.resetOperationCounts();

  viewport.setCells([
    ...committed,
    createAssistantMessageCell('tail revision 0', {
      cell_id: 'tail',
      revision: 0,
    }),
  ]);

  const counts = viewport.getOperationCounts();
  assert.ok(counts.cellsCompared >= committed.length);
  assert.ok(counts.indexEntriesRebuilt >= committed.length + 1);
  assert.ok(counts.cellsMeasured <= 1);
  assert.ok(counts.cachedRevisionCount <= 512);

  for (let revision = 1; revision <= 600; revision += 1) {
    viewport.setCells([
      createAssistantMessageCell(`tail revision ${revision}`, {
        cell_id: 'tail',
        revision,
      }),
    ]);
  }
  assert.ok(viewport.getOperationCounts().cachedRevisionCount <= 512);
});
