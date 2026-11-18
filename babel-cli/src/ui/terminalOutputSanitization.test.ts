/**
 * TUI output neutralization (SC-11).
 *
 * Terminal protocol sequences from model/tool/command text must never reach
 * the terminal. Babel's own styling is allowed; untrusted OSC/CSI/DCS bytes
 * are not. Fixtures are inert text.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversationalRenderer } from './conversationalRenderer.js';
import {
  sanitizeUntrustedTerminalBlock,
  sanitizeUntrustedTerminalField,
} from './sanitize.js';
import { formatToolGroupSummary, groupToolExecutions } from './toolPresentation.js';

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
  renderer.writeAgentLine('subagent', `report ${OSC_CLIPBOARD}done${CSI_CLEAR}`);
  renderer.onFileChanged(`src/${CSI_TITLE}file.ts`, 1, 0, `diff ${OSC_CLIPBOARD}+line`);

  const joined = written.join('');
  assertNoTerminalProtocol(joined, 'renderer transcript');
  assert.match(joined, /shell_exec/);
  assert.match(joined, /stdout/);
  assert.match(joined, /stderr/);
});

test('positive control: ordinary ANSI-free text is preserved verbatim', () => {
  const text = 'src/index.ts — 42 lines';
  assert.equal(sanitizeUntrustedTerminalField(text), text);
  assert.equal(sanitizeUntrustedTerminalBlock(text), text);
});
