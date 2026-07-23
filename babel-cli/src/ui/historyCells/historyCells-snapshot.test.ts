/**
 * HistoryCell snapshot regression suite — Phase B3.
 *
 * Target: 80+ stripped ANSI snapshots covering cell variants, tool types,
 * width edge cases, and transcript turn compositions.
 *
 * Run:   FORCE_COLOR=1 npx tsx --test src/ui/historyCells/historyCells-snapshot.test.ts
 * Update: UPDATE_SNAPSHOTS=1 FORCE_COLOR=1 npx tsx --test src/ui/historyCells/historyCells-snapshot.test.ts
 */

import test from 'node:test';

import { matchStrippedSnapshot } from '../snapshot.js';
import { TOOL_LABELS } from '../toolDisplay.js';
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
  renderHistoryCell,
} from './index.js';
import { HistoryTranscript } from './transcript.js';

const DEFAULT_WIDTH = 80;

function snap(name: string, output: string): void {
  matchStrippedSnapshot(output, name, import.meta.url);
}

function render(cell: HistoryCell, width = DEFAULT_WIDTH): string {
  return renderHistoryCell(cell, width);
}

function renderTranscript(cell: HistoryCell, width = DEFAULT_WIDTH): string {
  return cell.transcriptLines(width).join('\n');
}

function renderTurn(cells: HistoryCell[], width = DEFAULT_WIDTH): string {
  return cells.map((cell) => render(cell, width)).join('\n\n');
}

// ── User message variants ─────────────────────────────────────────────────────

const USER_CASES: { name: string; text: string; width?: number }[] = [
  { name: 'short', text: 'what is this repo?' },
  { name: 'multiline', text: 'line one\nline two' },
  { name: 'long-wrap', text: 'word '.repeat(40).trim() },
  { name: 'empty', text: '' },
  { name: 'emoji', text: 'Summarize 🚀 the chat engine changes' },
  { name: 'url-heavy', text: 'See https://example.com/docs/architecture for details' },
  { name: 'narrow-w40', text: 'Please explain how chatCore unifies CLI and REPL paths.', width: 40 },
  { name: 'wide-w120', text: 'Short question about history cells.', width: 120 },
];

for (const { name, text, width } of USER_CASES) {
  test(`snapshot user: ${name}`, () => {
    snap(`user:${name}`, render(createUserMessageCell(text), width ?? DEFAULT_WIDTH));
  });
}

// ── Assistant message variants ────────────────────────────────────────────────

const ASSISTANT_CASES: { name: string; text: string; width?: number }[] = [
  { name: 'short', text: 'A prompt operating system.' },
  { name: 'bold-italic', text: 'Use **chat mode** and _streaming_ for daily work.' },
  { name: 'inline-code', text: 'Edit `src/ui/waterfall.ts` and run tests.' },
  {
    name: 'code-fence',
    text: '```ts\nexport function hello(): void {\n  console.log("hi");\n}\n```',
  },
  { name: 'bullet-list', text: '- Phase A unified chat\n- Phase B adds history cells\n- Phase C composer' },
  { name: 'numbered-list', text: '1. Read the roadmap\n2. Implement B3\n3. Ship snapshots' },
  { name: 'blockquote', text: '> Competitive foundations require snapshot contracts.' },
  { name: 'link', text: 'Read [the reference](../docs/TUI_COMPETITIVE_REFERENCE.md).' },
  {
    name: 'table',
    text: '| Phase | Task |\n| --- | --- |\n| B1 | HistoryCell |\n| B3 | Snapshots |',
  },
  { name: 'multi-paragraph', text: 'First paragraph.\n\nSecond paragraph with more detail.' },
  { name: 'empty', text: '' },
  { name: 'narrow-w40', text: 'This answer should wrap aggressively at forty columns.', width: 40 },
  { name: 'medium-w60', text: 'Medium width wrap check for assistant markdown rendering.', width: 60 },
  { name: 'wide-w120', text: 'Wide terminal keeps short answers on one line.', width: 120 },
];

for (const { name, text, width } of ASSISTANT_CASES) {
  test(`snapshot assistant: ${name}`, () => {
    snap(`assistant:${name}`, render(createAssistantMessageCell(text), width ?? DEFAULT_WIDTH));
  });
}

// ── Tool call — every registered tool verb (completed) ────────────────────────

const TOOL_TARGETS: Record<string, string> = {
  read_file: 'src/agent/chatEngine.ts',
  list_dir: 'src/ui/historyCells',
  write_file: 'src/ui/historyCells/transcript.ts',
  grep: 'HistoryTranscript',
  glob: '**/*.test.ts',
  run_command: 'npm test',
  apply_patch: 'chatCore.ts',
  web_search: 'babel cli tui competitive',
  web_fetch: 'https://example.com/api/docs',
  sub_agent: 'audit streaming renderer',
  finish: 'task complete',
  file_read: 'src/index.ts',
  directory_list: 'src/ui',
  semantic_search: 'virtual scroll viewport',
  file_write: 'babel-cli/CLAUDE.md',
  shell_exec: 'npm run build',
  test_run: 'src/ui/historyCells',
  verifier: 'transcript.jsonl',
  mcp_request: 'context7/get-library-docs',
};

for (const tool of Object.keys(TOOL_LABELS)) {
  test(`snapshot tool completed: ${tool}`, () => {
    const target = TOOL_TARGETS[tool] ?? 'target';
    snap(
      `tool:completed:${tool}`,
      render(createToolCallCell(tool, target, 'completed', { detail: 'ok' })),
    );
  });
}

// ── Tool call — status and edge variants ──────────────────────────────────────

const TOOL_STATUS_CASES: {
  name: string;
  tool: string;
  target: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  detail?: string;
  lifecycle?: 'active' | 'committed';
}[] = [
  { name: 'running-active', tool: 'file_read', target: 'src/index.ts', status: 'running', lifecycle: 'active' },
  { name: 'completed-detail', tool: 'file_read', target: 'src/index.ts', status: 'completed', detail: '1.2 KB' },
  { name: 'failed-exit', tool: 'shell_exec', target: 'npm test', status: 'failed', detail: 'exit 1' },
  { name: 'cancelled', tool: 'run_command', target: 'npm test', status: 'cancelled' },
  {
    name: 'long-target-truncated',
    tool: 'file_read',
    target: 'src/interactive/execution/chatCore.integration.test.ts',
    status: 'completed',
    detail: '4 KB',
  },
  { name: 'web-search-running', tool: 'web_search', target: 'codex history cell snapshots', status: 'running', lifecycle: 'active' },
  { name: 'sub-agent-completed', tool: 'sub_agent', target: 'competitive audit', status: 'completed', detail: '3 findings' },
  { name: 'mcp-failed', tool: 'mcp_request', target: 'server/tool', status: 'failed', detail: 'timeout' },
  { name: 'narrow-w40', tool: 'grep', target: 'HistoryCell', status: 'completed', detail: '12 matches' },
];

for (const { name, tool, target, status, detail, lifecycle } of TOOL_STATUS_CASES) {
  test(`snapshot tool status: ${name}`, () => {
    const opts: { lifecycle: 'active' | 'committed'; detail?: string } = {
      lifecycle: lifecycle ?? 'committed',
    };
    if (detail !== undefined) opts.detail = detail;
    const cell = createToolCallCell(tool, target, status, opts);
    snap(`tool:status:${name}`, render(cell));
  });
}

// ── Tool transcript lines (display differs from transcript overlay) ───────────

const TOOL_TRANSCRIPT_CASES = [
  { name: 'file-read', tool: 'file_read', target: 'README.md', detail: '4 KB' },
  { name: 'shell-exec', tool: 'shell_exec', target: 'npm test', detail: 'exit 0' },
  { name: 'web-fetch', tool: 'web_fetch', target: 'https://example.com', detail: '200' },
  { name: 'grep', tool: 'grep', target: 'HistoryTranscript', detail: '8 matches' },
  { name: 'failed', tool: 'run_command', target: 'npm run build', detail: 'exit 2' },
] as const;

for (const { name, tool, target, detail } of TOOL_TRANSCRIPT_CASES) {
  test(`snapshot tool transcript: ${name}`, () => {
    const cell = createToolCallCell(tool, target, name === 'failed' ? 'failed' : 'completed', {
      detail,
    });
    snap(`tool:transcript:${name}`, renderTranscript(cell));
  });
}

// ── Thinking, separator, plain, session ─────────────────────────────────────

const THINKING_CASES = [
  { name: 'default-active', text: undefined, lifecycle: 'active' as const },
  { name: 'custom-text', text: 'Analyzing imports…', lifecycle: 'active' as const },
  { name: 'committed', text: 'Done thinking.', lifecycle: 'committed' as const },
];

for (const { name, text, lifecycle } of THINKING_CASES) {
  test(`snapshot thinking: ${name}`, () => {
    snap(`thinking:${name}`, render(createThinkingCell(text, { lifecycle })));
  });
}

const SEPARATOR_CASES = [
  { name: 'turn', style: 'turn' as const, label: undefined },
  { name: 'section-labeled', style: 'section' as const, label: 'Earlier messages' },
  { name: 'unseen-one', style: 'unseen' as const, label: '1' },
  { name: 'unseen-many', style: 'unseen' as const, label: '12' },
];

for (const { name, style, label } of SEPARATOR_CASES) {
  test(`snapshot separator: ${name}`, () => {
    snap(`separator:${name}`, render(createSeparatorCell(style, label !== undefined ? { label } : {})));
  });
}

const PLAIN_CASES = [
  { name: 'single-line', lines: ['Note: compaction truncated older turns.'] },
  { name: 'multiline', lines: ['Warning: context limit reached.', 'Older turns were truncated.'] },
];

for (const { name, lines } of PLAIN_CASES) {
  test(`snapshot plain: ${name}`, () => {
    snap(`plain:${name}`, render(createPlainCell(lines)));
  });
}

const SESSION_CASES = [
  {
    name: 'full',
    title: 'Babel Chat',
    options: { subtitle: 'feat/dag-workflow-engine', mode: 'chat', model: 'auto' },
  },
  { name: 'title-only', title: 'Babel', options: {} },
];

for (const { name, title, options } of SESSION_CASES) {
  test(`snapshot session: ${name}`, () => {
    snap(`session:${name}`, render(createSessionHeaderCell(title, options)));
  });
}

// ── Composite turn compositions ───────────────────────────────────────────────

test('snapshot composite: user-assistant exchange', () => {
  const cell = createCompositeCell([
    createUserMessageCell('explain chatCore.ts'),
    createAssistantMessageCell('It unifies CLI and REPL chat through ChatEngine.'),
  ]);
  snap('composite:exchange', render(cell));
});

test('snapshot composite: tool-heavy turn', () => {
  const cell = createCompositeCell([
    createUserMessageCell('fix the failing test'),
    createToolCallCell('file_read', 'src/ui/waterfall.ts', 'completed', { detail: '12 KB' }),
    createToolCallCell('shell_exec', 'npm test', 'completed', { detail: 'exit 0' }),
    createAssistantMessageCell('Fixed the snapshot assertion — all tests pass.'),
  ]);
  snap('composite:tool-heavy', render(cell));
});

test('snapshot composite: failed tool turn', () => {
  const cell = createCompositeCell([
    createUserMessageCell('run the build'),
    createToolCallCell('shell_exec', 'npm run build', 'failed', { detail: 'exit 1' }),
    createAssistantMessageCell('The build failed on the typecheck step.'),
  ]);
  snap('composite:failed-tool', render(cell));
});

// ── HistoryTranscript lifecycle compositions ──────────────────────────────────

test('snapshot transcript: answer then tool boundary', () => {
  const transcript = new HistoryTranscript();
  transcript.beginTurn();
  transcript.onAnswerChunk('Here is the plan:\n\n1. Add cells\n2. Add snapshots');
  transcript.beginToolCall(1, 'file_read', 'src/ui/historyCells/index.ts');
  transcript.completeToolCall(1, '2.1 KB');
  transcript.onAnswerChunk('Cells are wired and tested.');
  transcript.finishTurn();

  const cells = [...transcript.getCommittedCells()];
  snap('transcript:answer-tool-answer', renderTurn(cells));
});

test('snapshot transcript: parallel tools', () => {
  const transcript = new HistoryTranscript();
  transcript.beginTurn();
  transcript.beginToolCall(1, 'file_read', 'a.ts');
  transcript.beginToolCall(2, 'grep', 'HistoryCell');
  transcript.completeToolCall(2, '4 matches');
  transcript.completeToolCall(1, '1 KB');
  transcript.finishTurn();
  snap('transcript:parallel-tools', renderTurn([...transcript.getCommittedCells()]));
});

test('snapshot transcript: aborted turn', () => {
  const transcript = new HistoryTranscript();
  transcript.beginTurn();
  transcript.beginToolCall(1, 'shell_exec', 'npm test');
  transcript.abortTurn();
  snap('transcript:aborted', renderTurn([...transcript.getCommittedCells()]));
});

// ── Width matrix for height-sensitive cells ───────────────────────────────────

const WIDTH_MATRIX = [40, 60, 120] as const;

for (const width of WIDTH_MATRIX) {
  test(`snapshot width matrix user long @ w${width}`, () => {
    const cell = createUserMessageCell(
      'Please audit the entire babel-cli package for streaming regressions and report gaps.',
    );
    snap(`width:user-long:w${width}`, render(cell, width));
  });

  test(`snapshot width matrix assistant code @ w${width}`, () => {
    const cell = createAssistantMessageCell(
      '```ts\nconst transcript = new HistoryTranscript();\ntranscript.beginTurn();\n```',
    );
    snap(`width:assistant-code:w${width}`, render(cell, width));
  });
}