/**
 * renderers-snapshot.test.ts — ANSI snapshot tests for core Babel TUI renderers.
 *
 * Most tests import render functions directly and use matchStrippedSnapshot()
 * to compare ANSI-stripped output. The markdown rendering test for chat panel
 * spawns a subprocess with FORCE_COLOR=1 (same pattern as highlight.test.ts)
 * because renderMarkdown skips lexing when colors are unsupported.
 *
 * Run:   FORCE_COLOR=1 npx tsx --test src/ui/renderers-snapshot.test.ts
 * Update: UPDATE_SNAPSHOTS=1 FORCE_COLOR=1 npx tsx --test src/ui/renderers-snapshot.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { matchSnapshot, matchStrippedSnapshot } from './snapshot.js';
import { stripAnsi } from './theme.js';
import { renderCompactTokenBar } from './tokenBar.js';
import { renderStatusBar } from './statusBar.js';
import { renderChatTurn } from './chatPanel.js';
import { renderBadge } from './badges.js';
import { ConfirmDialog, SelectDialog, PermissionDialog } from './dialog.js';

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** Override terminal columns/rows for deterministic layout, returns restore fn. */
function fixedTermSize(columns: number, rows: number): () => void {
  const prevCols = (process.stdout as any).columns;
  const prevRows = (process.stdout as any).rows;
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  return () => {
    Object.defineProperty(process.stdout, 'columns', { value: prevCols, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: prevRows, configurable: true });
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════
// 1. TokenBar — renderCompactTokenBar
// ═══════════════════════════════════════════════════════════════════════════════════

test('renderCompactTokenBar at 0%, 25%, 50%, 75%, 90%, 100% utilization', () => {
  matchStrippedSnapshot(renderCompactTokenBar(0, 200_000, 20), 'compact bar 0%', import.meta.url);
  matchStrippedSnapshot(
    renderCompactTokenBar(50_000, 200_000, 20),
    'compact bar 25%',
    import.meta.url,
  );
  matchStrippedSnapshot(
    renderCompactTokenBar(100_000, 200_000, 20),
    'compact bar 50%',
    import.meta.url,
  );
  matchStrippedSnapshot(
    renderCompactTokenBar(150_000, 200_000, 20),
    'compact bar 75%',
    import.meta.url,
  );
  matchStrippedSnapshot(
    renderCompactTokenBar(180_000, 200_000, 20),
    'compact bar 90%',
    import.meta.url,
  );
  matchStrippedSnapshot(
    renderCompactTokenBar(200_000, 200_000, 20),
    'compact bar 100%',
    import.meta.url,
  );
});

test('renderCompactTokenBar at bar widths 10, 20, 30', () => {
  matchStrippedSnapshot(
    renderCompactTokenBar(50_000, 200_000, 10),
    'compact bar w10',
    import.meta.url,
  );
  matchStrippedSnapshot(
    renderCompactTokenBar(50_000, 200_000, 20),
    'compact bar w20',
    import.meta.url,
  );
  matchStrippedSnapshot(
    renderCompactTokenBar(50_000, 200_000, 30),
    'compact bar w30',
    import.meta.url,
  );
});

test('renderCompactTokenBar with small and large token counts', () => {
  matchStrippedSnapshot(
    renderCompactTokenBar(100, 200_000, 15),
    'compact bar 100 tok',
    import.meta.url,
  );
  matchStrippedSnapshot(
    renderCompactTokenBar(195_000, 200_000, 15),
    'compact bar 195k tok',
    import.meta.url,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════════
// 2. StatusBar — renderStatusBar
// ═══════════════════════════════════════════════════════════════════════════════════

test('renderStatusBar basic with model, mode, project, and cost info', () => {
  const out = renderStatusBar({
    model: 'DeepSeek V4 Flash',
    modelId: 'deepseek-v4',
    mode: 'default',
    project: 'babel',
    totalTokens: 15_000,
    totalCost: 0.1234,
    turnCount: 3,
    width: 80,
  });
  matchStrippedSnapshot(out, 'status bar basic', import.meta.url);
  matchSnapshot(out, 'status bar basic raw', import.meta.url);
});

test('renderStatusBar without token bar (zero cost, no tokens, showTokenBar=false)', () => {
  const out = renderStatusBar({
    model: 'Claude Sonnet 4.6',
    mode: 'chat',
    project: 'global',
    totalTokens: 0,
    totalCost: 0,
    turnCount: 0,
    width: 80,
    showTokenBar: false,
  });
  matchStrippedSnapshot(out, 'status bar no cost', import.meta.url);
});

test('renderStatusBar truncation at narrow widths 40 and 60', () => {
  const state = {
    model: 'deepseek-v4-flash',
    modelId: 'deepseek-v4',
    mode: 'deep',
    project: 'my-very-long-project-name-indeed',
    totalTokens: 50_000,
    totalCost: 0.5678,
    turnCount: 12,
    showTokenBar: false,
  };
  matchStrippedSnapshot(
    renderStatusBar({ ...state, width: 40 }),
    'status bar w40',
    import.meta.url,
  );
  matchStrippedSnapshot(
    renderStatusBar({ ...state, width: 60 }),
    'status bar w60',
    import.meta.url,
  );
});

test('renderStatusBar with failed status and background tasks', () => {
  const out = renderStatusBar({
    model: 'Claude Opus 4.8',
    modelId: 'claude-opus-4-8',
    mode: 'plan',
    project: 'big-project',
    totalTokens: 250_000,
    totalCost: 1.2345,
    turnCount: 7,
    status: 'failed',
    backgroundTasks: [
      {
        id: '1',
        label: 'Indexing',
        status: 'running',
        progress: 45,
        current: 567,
        total: 1234,
        elapsedMs: 5000,
      },
    ],
    width: 100,
  });
  matchStrippedSnapshot(out, 'status bar failed bg', import.meta.url);
});

// ═══════════════════════════════════════════════════════════════════════════════════
// 3. ChatPanel — renderChatTurn
// ═══════════════════════════════════════════════════════════════════════════════════

test('renderChatTurn user message', () => {
  const restore = fixedTermSize(88, 24);
  try {
    const out = renderChatTurn({
      role: 'user',
      input: 'Hello Babel, can you help me refactor this code?',
    });
    matchStrippedSnapshot(out, 'chat user', import.meta.url);
  } finally {
    restore();
  }
});

test('renderChatTurn assistant message with plain text', () => {
  const restore = fixedTermSize(88, 24);
  try {
    const out = renderChatTurn({
      role: 'assistant',
      answer: 'Sure, I can help you refactor that code. Please share the current implementation.',
    });
    matchStrippedSnapshot(out, 'chat assistant plain', import.meta.url);
  } finally {
    restore();
  }
});

test('renderChatTurn assistant with markdown (subprocess for deterministic color)', () => {
  // Spawn subprocess with FORCE_COLOR=1 so renderMarkdown lexes markdown and
  // emits ANSI highlights deterministically (same pattern as highlight.test.ts).
  const markdownAnswer =
    'Here is how you refactor:\n\n```typescript\nconst x = 1;\n```\n\nLet me know if you need more help.';
  const escapedAnswer = JSON.stringify(markdownAnswer);
  const script = [
    `import { renderChatTurn } from './src/ui/chatPanel.js';`,
    `const out = renderChatTurn({ role: 'assistant', answer: ${escapedAnswer} });`,
    `console.log(JSON.stringify(out));`,
  ].join('\n');

  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '' },
    timeout: 15_000,
  });
  assert.equal(result.status, 0, `subprocess failed: ${result.stderr}`);
  const out = JSON.parse(result.stdout.trim()) as string;
  matchStrippedSnapshot(out, 'chat assistant markdown', import.meta.url);
  matchSnapshot(out, 'chat assistant markdown raw', import.meta.url);
});

test('renderChatTurn tool call result (user turn with tool output)', () => {
  const restore = fixedTermSize(88, 24);
  try {
    const out = renderChatTurn({
      role: 'user',
      input: [
        '[Tool Result] read src/foo.ts',
        '  export function hello(): void {',
        '    console.log("world");',
        '  }',
        '  exit code: 0',
      ].join('\n'),
    });
    matchStrippedSnapshot(out, 'chat tool result', import.meta.url);
  } finally {
    restore();
  }
});

test('renderChatTurn empty turn renders (empty turn) placeholder', () => {
  const restore = fixedTermSize(88, 24);
  try {
    const out = renderChatTurn({ role: 'assistant' });
    matchStrippedSnapshot(out, 'chat empty', import.meta.url);
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════
// 4. Dialog frame rendering
// ═══════════════════════════════════════════════════════════════════════════════════
// These tests construct dialog instances and call render() to get the dialog string.
// Dialogs extend Component and use Box primitives for layout; render() returns a
// string (may include ANSI style sequences). matchStrippedSnapshot strips all CSI
// sequences, leaving frame characters, titles, message text, and button labels.

test('ConfirmDialog danger variant render output', () => {
  const restore = fixedTermSize(80, 40);
  try {
    const dialog = new ConfirmDialog({
      title: 'Confirm Delete',
      message:
        'Delete file src/old.ts?\nThis cannot be undone.\nAre you sure?\nThe file will be moved to trash.',
      confirmLabel: 'Delete',
      rejectLabel: 'Cancel',
      danger: true,
      minWidth: 50,
    });
    const output = dialog.render();
    matchStrippedSnapshot(output, 'confirm dialog danger', import.meta.url);
  } finally {
    restore();
  }
});

test('SelectDialog render output with multiple options', () => {
  const restore = fixedTermSize(80, 40);
  try {
    const dialog = new SelectDialog({
      title: 'Select Action',
      message: 'Select an action:\n1. Run tests\n2. Build project\n3. Deploy to prod\n4. Cancel',
      options: ['Run tests', 'Build project', 'Deploy to prod', 'Cancel'],
      minWidth: 50,
    });
    const output = dialog.render();
    matchStrippedSnapshot(output, 'select dialog', import.meta.url);
  } finally {
    restore();
  }
});

test('PermissionDialog write_file render output with path, metadata, preview', () => {
  const restore = fixedTermSize(80, 40);
  try {
    const dialog = new PermissionDialog({
      title: 'Approve Write',
      message: 'Allow writing to the following file:',
      actionType: 'write_file',
      path: 'src/new-file.ts',
      preview: ['export function hello(): void {', '  console.log("world");', '}'].join('\n'),
      metadata: ['Lines: 5', 'Size: 120 bytes'],
      minWidth: 50,
    });
    const output = dialog.render();
    matchStrippedSnapshot(output, 'permission dialog write', import.meta.url);
  } finally {
    restore();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════
// 5. Badges — renderBadge
// ═══════════════════════════════════════════════════════════════════════════════════

test('renderBadge PASS, FAIL, ACTIVE, BLOCKED, PENDING', () => {
  matchStrippedSnapshot(renderBadge('PASS'), 'badge PASS', import.meta.url);
  matchStrippedSnapshot(renderBadge('FAIL'), 'badge FAIL', import.meta.url);
  matchStrippedSnapshot(renderBadge('ACTIVE'), 'badge ACTIVE', import.meta.url);
  matchStrippedSnapshot(renderBadge('BLOCKED'), 'badge BLOCKED', import.meta.url);
  matchStrippedSnapshot(renderBadge('PENDING'), 'badge PENDING', import.meta.url);
});

test('renderBadge normalizes aliases to canonical status', () => {
  assert.equal(stripAnsi(renderBadge('ERROR')), stripAnsi(renderBadge('FAIL')));
  assert.equal(stripAnsi(renderBadge('FAILED')), stripAnsi(renderBadge('FAIL')));
  assert.equal(stripAnsi(renderBadge('REJECT')), stripAnsi(renderBadge('FAIL')));
  assert.equal(stripAnsi(renderBadge('COMPLETE')), stripAnsi(renderBadge('PASS')));
  assert.equal(stripAnsi(renderBadge('WARNING')), stripAnsi(renderBadge('BLOCKED')));
  assert.equal(stripAnsi(renderBadge('WARN')), stripAnsi(renderBadge('BLOCKED')));
});
