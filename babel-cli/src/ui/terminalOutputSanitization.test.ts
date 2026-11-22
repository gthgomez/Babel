/**
 * TUI output neutralization (SC-11).
 *
 * Terminal protocol sequences from model/tool/command text must never reach
 * the terminal. Babel's own styling is allowed; untrusted OSC/CSI/DCS bytes
 * are not. Fixtures are inert text.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { ConversationalRenderer } from './conversationalRenderer.js';
import {
  sanitizeUntrustedTerminalBlock,
  sanitizeUntrustedTerminalField,
} from './sanitize.js';
import { formatToolGroupSummary, groupToolExecutions } from './toolPresentation.js';
import { renderSubAgentOverlay } from './subAgentOverlay.js';
import { createTuiStore } from './stateMutationBus.js';
import { activityColor, normalizeActivityLine } from './rendererSupport.js';
import { hyperlinkFile, supportsColor } from './theme.js';
import { formatPlanType } from './planView.js';

const OSC_CLIPBOARD = '\x1b]52;c;dzA4LXN5bnRoZXRpYw==\x07';
const CSI_CLEAR = '\x1b[2J';
const CSI_TITLE = '\x1b]0;synthetic-title\x1b\\';
const DCS = '\x1bPq#0;2;0;0;0\x1b\\';

function assertNoTerminalProtocol(text: string, label: string): void {
  assert.equal(text.includes('\x1b]52'), false, `${label}: OSC 52 reached the terminal`);
  assert.equal(text.includes('\x1b]0;'), false, `${label}: title OSC reached the terminal`);
  assert.equal(text.includes('\x07'), false, `${label}: BEL reached the terminal`);
  assert.equal(text.includes('[2J'), false, `${label}: erase-display reached the terminal`);
  assert.equal(text.includes('\x1bP'), false, `${label}: DCS reached the terminal`);
}

test('single-line untrusted fields lose all control sequences and separators', () => {
  const field = sanitizeUntrustedTerminalField(
    `safe-prefix${OSC_CLIPBOARD}${CSI_CLEAR}${CSI_TITLE}${DCS}safe-suffix\r\nsecond`,
  );
  assertNoTerminalProtocol(field, 'field');
  assert.equal(field, 'safe-prefixsafe-suffix second');
  assert.equal(sanitizeUntrustedTerminalField(undefined), '');
});

test('untrusted fields and blocks drop non-printing DEL and C1 controls', () => {
  const text = `before${String.fromCharCode(0x7f, 0x9b)}after`;
  assert.equal(sanitizeUntrustedTerminalField(text), 'beforeafter');
  assert.equal(sanitizeUntrustedTerminalBlock(text), 'beforeafter');
});

test('untrusted blocks keep line structure but normalize carriage returns', () => {
  const block = sanitizeUntrustedTerminalBlock(`line-1${CSI_CLEAR}\r\nline-2\rline-3${OSC_CLIPBOARD}`);
  assertNoTerminalProtocol(block, 'block');
  assert.equal(block, 'line-1\nline-2\nline-3');
});

test('tool summaries neutralize terminal protocol in targets, details and errors', () => {
  const groups = groupToolExecutions([
    {
      tool: 'shell_exec',
      target: `src/${OSC_CLIPBOARD}file.ts`,
      detail: `failed ${CSI_CLEAR}`,
      error: `stderr ${CSI_TITLE}`,
      exitCode: 1,
    },
  ]);
  const rendered = formatToolGroupSummary(groups[0]!, true);
  assertNoTerminalProtocol(rendered, 'expanded summary');
  assert.match(rendered, /src\/file\.ts/);
});

test('collapsed tool summaries neutralize model-supplied tool names', () => {
  const groups = groupToolExecutions([
    { tool: `mcp_${OSC_CLIPBOARD}tool`, target: `src/${CSI_CLEAR}file.ts`, status: 'success' },
  ]);
  const rendered = formatToolGroupSummary(groups[0]!, false);
  assertNoTerminalProtocol(rendered, 'collapsed summary');
});

test('renderer neutralizes tool completion and agent stream text before writing', () => {
  const renderer = new ConversationalRenderer({ isTTY: false });
  const written: string[] = [];
  (renderer as unknown as { _writeTranscript: (text: string) => void })._writeTranscript = (text) => {
    written.push(text);
  };

  const id = renderer.onToolCallStart('shell_exec', `src/${OSC_CLIPBOARD}file.ts`);
  renderer.onToolCallComplete(id, `stdout ${CSI_CLEAR}`, `stderr ${DCS}`);
  const agentId = `sub${CSI_TITLE}agent`;
  renderer.registerAgent(agentId);
  renderer.writeAgentLine(agentId, `report ${OSC_CLIPBOARD}done${CSI_CLEAR}`);
  renderer.onAgentToolStart(agentId, 'read_file', `src/${DCS}file.ts`);
  renderer.onAgentToolComplete(agentId, 'read_file', `inspected ${CSI_CLEAR}file`);

  const joined = written.join('');
  assertNoTerminalProtocol(joined, 'renderer transcript');
  assert.match(joined, /shell_exec/);
  assert.match(joined, /stdout/);
  assert.match(joined, /stderr/);
  assert.match(joined, /subagent/);
  assert.match(joined, /report done/);
  assert.match(joined, /inspected file/);
});

test('TTY transcript neutralizes file changes, recovery and compaction notices', () => {
  const stateStore = createTuiStore();
  const renderer = new ConversationalRenderer({ isTTY: true, ownsInput: false, stateStore });
  const written: string[] = [];
  (renderer as unknown as { _writeTranscript: (text: string) => void })._writeTranscript = (text) => {
    written.push(text);
  };
  const originalPath = `src/${CSI_TITLE}file.ts`;
  renderer.onFileChanged(originalPath, 1, 0, `@@ -1 +1 @@\n+added ${OSC_CLIPBOARD}line`);
  assert.deepEqual(stateStore.currentState.activeFiles, [originalPath]);
  renderer.onProgressRecovery('nudge', 'fixture', 1, `recovery ${CSI_CLEAR}message`);
  renderer.onContextCompacted(`compaction ${DCS}message`);
  const joined = written.join('');
  assertNoTerminalProtocol(joined, 'TTY transcript');
  assert.match(joined, /src\/file\.ts/);
  assert.match(joined, /added line/);
  assert.match(joined, /recovery message/);
  assert.match(joined, /compaction message/);
});

test('overflow truncation cannot re-emit OSC from a sanitized summary', () => {
  const longTarget = `${OSC_CLIPBOARD}${'a'.repeat(60)}`;
  for (const item of [
    { tool: 'shell_exec', target: longTarget, detail: `failed ${CSI_CLEAR}`, exitCode: 1 },
    { tool: `${OSC_CLIPBOARD}${'mcp_'.repeat(20)}`, target: `src/${'b'.repeat(80)}`, status: 'success' as const },
    { tool: 'shell_exec', target: `/tmp/${OSC_CLIPBOARD}${'c'.repeat(60)}`, status: 'success' as const },
  ]) {
    const groups = groupToolExecutions([item]);
    for (const verbose of [true, false]) {
      const rendered = formatToolGroupSummary(groups[0]!, verbose, 40);
      assertNoTerminalProtocol(rendered, `overflow verbose=${verbose}`);
      assert.ok(rendered.length > 0);
    }
  }
});

test('subagent overlay neutralizes labels and failure text', () => {
  const now = Date.now();
  const lines = renderSubAgentOverlay(
    new Map([
      ['a', { label: `explore ${OSC_CLIPBOARD}repo${CSI_CLEAR}`, startTime: now - 1000, status: 'running' }],
      ['b', { label: `verify ${CSI_TITLE}`, startTime: now - 2000, status: 'failed', error: `boom ${DCS}` }],
    ]),
    '◐',
    now,
  );
  const rendered = lines.join('\n');
  assertNoTerminalProtocol(rendered, 'subagent overlay');
  assert.match(rendered, /explore repo/);
  assert.match(rendered, /boom/);
});

test('waterfall activity text neutralizes terminal protocol before color/truncate', () => {
  const raw = `Reading ${OSC_CLIPBOARD}src/file.ts${CSI_CLEAR}`;
  assertNoTerminalProtocol(normalizeActivityLine(raw) ?? '', 'normalized activity');
  assertNoTerminalProtocol(activityColor(raw), 'activity color');
  assert.equal(normalizeActivityLine(raw), 'Reading file');
});

test('file hyperlinks neutralize protocol in both URI and label', () => {
  const rendered = hyperlinkFile(`${OSC_CLIPBOARD}src/file.ts${CSI_CLEAR}`, `${OSC_CLIPBOARD}src/file.ts`);
  assertNoTerminalProtocol(rendered, 'hyperlink');
  assert.match(rendered, /src\/file\.ts/);
});

test('file hyperlinks preserve the actual destination while encoding URI separators', () => {
  const filePath = 'src/report #1.txt';
  const rendered = hyperlinkFile(filePath, 'report');
  if (supportsColor()) assert.ok(rendered.includes(pathToFileURL(filePath).href));
  assert.match(rendered, /report/);
});

test('plan type is neutralized before styled rendering', () => {
  assertNoTerminalProtocol(formatPlanType(`PLAN${OSC_CLIPBOARD}${CSI_TITLE}`), 'plan type');
  assert.equal(formatPlanType(), 'IMPLEMENTATION_PLAN');
  assert.equal(formatPlanType('REFACTOR_PLAN'), 'REFACTOR_PLAN');
});

test('positive control: ordinary ANSI-free text is preserved verbatim', () => {
  const text = 'src/index.ts — 42 lines';
  assert.equal(sanitizeUntrustedTerminalField(text), text);
  assert.equal(sanitizeUntrustedTerminalBlock(text), text);
});
