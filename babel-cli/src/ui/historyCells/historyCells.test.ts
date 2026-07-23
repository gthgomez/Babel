/**
 * HistoryCell snapshot tests — Phase B1 foundation (B3 expands variant count).
 *
 * Run:   FORCE_COLOR=1 npx tsx --test src/ui/historyCells/historyCells.test.ts
 * Update: UPDATE_SNAPSHOTS=1 FORCE_COLOR=1 npx tsx --test src/ui/historyCells/historyCells.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { matchStrippedSnapshot } from '../snapshot.js';
import { stripAnsi } from '../theme.js';
import type { HistoryCell } from './historyCell.js';
import {
  createAssistantMessageCell,
  createCompositeCell,
  createPlainCell,
  createSeparatorCell,
  createSessionHeaderCell,
  createThinkingCell,
  createToolCallCell,
  createUserMessageCell,
  historyCellFromRecord,
  renderHistoryCell,
  serializeHistoryCell,
} from './index.js';

const WIDTH = 80;

function renderCell(cell: HistoryCell, width = WIDTH): string {
  return renderHistoryCell(cell, width);
}

test('user message — short', () => {
  const cell = createUserMessageCell('what is this repo?');
  matchStrippedSnapshot(renderCell(cell), 'user short', import.meta.url);
});

test('user message — multiline', () => {
  const cell = createUserMessageCell('line one\nline two');
  matchStrippedSnapshot(renderCell(cell), 'user multiline', import.meta.url);
});

test('user message — long wrap', () => {
  const cell = createUserMessageCell(
    'Please audit the entire babel-cli package for streaming regressions and report any gaps in the competitive reference document.',
  );
  matchStrippedSnapshot(renderCell(cell), 'user long wrap', import.meta.url);
});

test('assistant message — short', () => {
  const cell = createAssistantMessageCell('A prompt operating system.');
  matchStrippedSnapshot(renderCell(cell), 'assistant short', import.meta.url);
});

test('assistant message — markdown emphasis', () => {
  const cell = createAssistantMessageCell('Use **chat mode** for conversational work.');
  matchStrippedSnapshot(renderCell(cell), 'assistant markdown', import.meta.url);
});

test('assistant message — fenced code', () => {
  const cell = createAssistantMessageCell('```ts\nconst x = 1;\n```');
  matchStrippedSnapshot(renderCell(cell), 'assistant code fence', import.meta.url);
});

test('tool call — running', () => {
  const cell = createToolCallCell('file_read', 'src/index.ts', 'running', {
    lifecycle: 'active',
  });
  matchStrippedSnapshot(renderCell(cell), 'tool running', import.meta.url);
});

test('tool call — completed with detail', () => {
  const cell = createToolCallCell('file_read', 'src/index.ts', 'completed', {
    detail: '1.2 KB',
  });
  matchStrippedSnapshot(renderCell(cell), 'tool completed', import.meta.url);
});

test('tool call — failed', () => {
  const cell = createToolCallCell('shell_exec', 'npm test', 'failed', {
    detail: 'exit 1',
  });
  matchStrippedSnapshot(renderCell(cell), 'tool failed', import.meta.url);
});

test('thinking — active default', () => {
  const cell = createThinkingCell(undefined, { lifecycle: 'active', revision: 1 });
  matchStrippedSnapshot(renderCell(cell), 'thinking active', import.meta.url);
});

test('separator — turn rule', () => {
  const cell = createSeparatorCell('turn');
  matchStrippedSnapshot(renderCell(cell), 'separator turn', import.meta.url);
});

test('separator — unseen pill', () => {
  const cell = createSeparatorCell('unseen', { label: '3' });
  matchStrippedSnapshot(renderCell(cell), 'separator unseen', import.meta.url);
});

test('plain notice cell', () => {
  const cell = createPlainCell(['Note: compaction truncated older turns.']);
  matchStrippedSnapshot(renderCell(cell), 'plain notice', import.meta.url);
});

test('session header', () => {
  const cell = createSessionHeaderCell('Babel Chat', {
    subtitle: 'feat/dag-workflow-engine',
    mode: 'chat',
    model: 'auto',
  });
  matchStrippedSnapshot(renderCell(cell), 'session header', import.meta.url);
});

test('composite — user then assistant', () => {
  const cell = createCompositeCell([
    createUserMessageCell('explain chatCore.ts'),
    createAssistantMessageCell('It unifies CLI and REPL chat through ChatEngine.'),
  ]);
  matchStrippedSnapshot(renderCell(cell), 'composite exchange', import.meta.url);
});

test('historyCellFromRecord round-trips composite children', () => {
  const user = createUserMessageCell('hello');
  const assistant = createAssistantMessageCell('hi there');
  const composite = createCompositeCell([user, assistant]);
  const restored = historyCellFromRecord(composite.toRecord(), [
    user.toRecord(),
    assistant.toRecord(),
  ]);
  assert.equal(restored.kind, 'composite');
  assert.equal(
    stripAnsi(renderHistoryCell(restored, WIDTH)),
    stripAnsi(renderHistoryCell(composite, WIDTH)),
  );
});

test('serializeHistoryCell preserves schema version', () => {
  const cell = createAssistantMessageCell('persist me');
  const record = serializeHistoryCell(cell);
  assert.equal(record.schema_version, 1);
  assert.equal(record.kind, 'assistant_message');
  const restored = historyCellFromRecord(record);
  assert.equal(stripAnsi(renderHistoryCell(restored, WIDTH)), stripAnsi(renderCell(cell)));
});

test('desiredHeight grows when lines wrap', () => {
  const narrow = createUserMessageCell('word '.repeat(40));
  const tall = narrow.desiredHeight(40);
  const short = narrow.desiredHeight(WIDTH);
  assert.ok(tall >= short);
});

test('tool call transcript lines differ from display lines', () => {
  const cell = createToolCallCell('file_read', 'README.md', 'completed', { detail: '4 KB' });
  const display = stripAnsi(renderHistoryCell(cell, WIDTH));
  const transcript = stripAnsi(cell.transcriptLines(WIDTH).join('\n'));
  assert.match(display, /Reading/);
  assert.match(transcript, /\$ file_read README\.md/);
  assert.notEqual(display, transcript);
});