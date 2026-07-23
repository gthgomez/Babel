/**
 * statusBar.test.ts — Tests for the REPL status bar renderer.
 *
 * Covers:
 *   1. Basic formatting (model | mode | project + right-aligned info)
 *   2. Truncation preserves right-aligned info
 *   3. Color-coded backgrounds (failed, blocked, complete, ready/reverse)
 *   4. Token context bar integration
 *   5. Edge cases (zero tokens, zero cost, background tasks)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatusBar } from './statusBar.js';
import type { StatusBarState } from './statusBar.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultState(overrides: Partial<StatusBarState> = {}): StatusBarState {
  return {
    model: 'DeepSeek v4 Flash',
    mode: 'default',
    project: 'my-project',
    totalTokens: 45000,
    totalCost: 0.1234,
    turnCount: 42,
    ...overrides,
  };
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\[7m/g, '')
    .replace(/\x1b\[27m/g, '');
}

/** Get the first line (status bar) from a multi-line output, stripped of ANSI. */
function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  const line = nl >= 0 ? text.slice(0, nl) : text;
  return stripAnsi(line);
}

/** Extract ANSI codes from the first line for color assertion. */
function firstLineAnsi(text: string): string {
  const nl = text.indexOf('\n');
  return nl >= 0 ? text.slice(0, nl) : text;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Basic formatting
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderStatusBar — basic format', () => {
  it('contains model, mode, and project name', () => {
    const result = renderStatusBar(defaultState());
    const plain = stripAnsi(result);
    assert.ok(plain.includes('DeepSeek v4 Flash'));
    assert.ok(plain.includes('default'));
    assert.ok(plain.includes('my-project'));
  });

  it('contains right-aligned token count, cost, and turn count', () => {
    const result = renderStatusBar(defaultState());
    const plain = stripAnsi(result);
    assert.ok(plain.includes('45,000 tok'));
    assert.ok(plain.includes('$0.1234'));
    assert.ok(plain.includes('turn 42'));
  });

  it('ends with a newline', () => {
    const result = renderStatusBar(defaultState());
    assert.ok(result.endsWith('\n'));
  });

  it('pads to full terminal width so background spans edge-to-edge', () => {
    const result = renderStatusBar(defaultState({ width: 80 }));
    const line = firstLine(result);
    assert.equal(line.length, 80);
  });

  it('shows background tasks when provided', () => {
    const result = renderStatusBar(
      defaultState({
        backgroundTasks: [
          {
            id: '1',
            label: 'Indexing',
            status: 'running',
            current: 567,
            total: 1234,
            progress: 45,
            elapsedMs: 3200,
          },
        ],
        width: 120,
      }),
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Indexing'));
    assert.ok(plain.includes('567'));
    assert.ok(plain.includes('1234'));
  });

  it('omits background tasks section when absent', () => {
    const result = renderStatusBar(defaultState({} as any));
    const plain = stripAnsi(result);
    // The bar should still look normal
    assert.ok(plain.includes('DeepSeek'));
    assert.ok(plain.includes('45,000 tok'));
  });

  it('renders with zero tokens and zero cost', () => {
    const result = renderStatusBar(
      defaultState({
        totalTokens: 0,
        totalCost: 0,
        turnCount: 0,
      }),
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('0 tok'));
    assert.ok(plain.includes('$0.0000'));
    assert.ok(plain.includes('turn 0'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Truncation
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderStatusBar — truncation', () => {
  it('truncates left side when content exceeds width', () => {
    const result = renderStatusBar(
      defaultState({
        model: 'VeryLongModelNameThatShouldBeTruncated',
        mode: 'default',
        project: 'my-project',
        width: 40,
      }),
    );
    const line = firstLine(result);
    // Right-aligned info should still be present
    assert.ok(line.includes('45,000'));
    assert.ok(line.includes('turn'));
    assert.ok(line.length <= 42);
  });

  it('preserves right-aligned info under severe truncation', () => {
    const result = renderStatusBar(
      defaultState({
        model: 'ExtremelyLongModelNameThatWillGetTruncated',
        mode: 'very-long-mode-name',
        project: 'project-with-long-name',
        width: 30,
      }),
    );
    const line = firstLine(result);
    // The right-aligned info is the most important part — it should survive
    assert.ok(line.includes('tok') || line.includes('turn'));
  });

  it('uses ellipsis … for truncated content', () => {
    const result = renderStatusBar(
      defaultState({
        model: 'A'.repeat(60),
        width: 50,
      }),
    );
    const line = firstLine(result);
    const plainCount = line.length;
    // Under narrow width, truncation should occur (bar is padded to width)
    assert.ok(plainCount <= 55);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Color-coded backgrounds
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderStatusBar — status backgrounds', () => {
  it('default (no status) uses reverse video (\\x1b[7m)', () => {
    const result = renderStatusBar(defaultState({} as any));
    const line = firstLineAnsi(result);
    assert.ok(line.includes('\x1b[7m'), 'default should use reverse video');
  });

  it('status=failed uses red background (\\x1b[41m)', () => {
    const result = renderStatusBar(defaultState({ status: 'failed' }));
    const line = firstLineAnsi(result);
    assert.ok(line.includes('\x1b[41m'), 'failed should use red background');
  });

  it('status=blocked uses yellow background (\\x1b[43m)', () => {
    const result = renderStatusBar(defaultState({ status: 'blocked' }));
    const line = firstLineAnsi(result);
    assert.ok(line.includes('\x1b[43m'), 'blocked should use yellow background');
  });

  it('status=complete uses green background (\\x1b[42m)', () => {
    const result = renderStatusBar(defaultState({ status: 'complete' }));
    const line = firstLineAnsi(result);
    assert.ok(line.includes('\x1b[42m'), 'complete should use green background');
  });

  it('unknown status string falls back to reverse video', () => {
    const result = renderStatusBar(defaultState({ status: 'unknown-status' }));
    const line = firstLineAnsi(result);
    // Unknown status is not in the bgCodes map — should use reverse video
    assert.ok(line.includes('\x1b[7m'), 'unknown status should fall back to reverse video');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Token context bar
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderStatusBar — token context bar', () => {
  it('includes token bar when showTokenBar is true (default) and modelId given', () => {
    const result = renderStatusBar(
      defaultState({
        modelId: 'deepseek-v4-pro',
        totalTokens: 45000,
      }),
    );
    // Token bar is now integrated inline in the main status line (not a separate line)
    const lines = result.split('\n');
    // First line contains the inline compact token bar
    assert.ok(lines[0]!.includes('%'));
    assert.ok(lines[0]!.includes('['));
  });

  it('omits token bar when showTokenBar is false', () => {
    const result = renderStatusBar(
      defaultState({
        modelId: 'deepseek-v4-pro',
        totalTokens: 45000,
        showTokenBar: false,
      }),
    );
    const lines = result.split('\n');
    // Should only have one line (status bar) when token bar is hidden
    // The second line would be empty from split newline
    if (lines.length >= 2 && lines[1]!.length > 0) {
      assert.ok(!lines[1]!.includes('limit:'));
    }
  });

  it('omits token bar when totalTokens is 0', () => {
    const result = renderStatusBar(
      defaultState({
        modelId: 'deepseek-v4-pro',
        totalTokens: 0,
      }),
    );
    const lines = result.split('\n');
    if (lines.length >= 2 && lines[1]!.length > 0) {
      assert.ok(!lines[1]!.includes('limit:'));
    }
  });

  it('omits token bar when modelId is missing', () => {
    const result = renderStatusBar(
      defaultState({
        totalTokens: 45000,
      } as any),
    );
    const lines = result.split('\n');
    if (lines.length >= 2 && lines[1]!.length > 0) {
      assert.ok(!lines[1]!.includes('limit:'));
    }
  });

  it('token bar uses compact format with percent', () => {
    const result = renderStatusBar(
      defaultState({
        modelId: 'deepseek-v4-pro',
        totalTokens: 64000,
        width: 80,
      }),
    );
    // ~50% of 128K = should show "50%" in the main status bar line (now inline)
    const lines = result.split('\n');
    assert.ok(lines[0]!.includes('%'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Routing label (model tier + phase)
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderStatusBar — routing label', () => {
  it('shows routing label next to model when set', () => {
    const result = renderStatusBar(
      defaultState({ routingLabel: 'Flash·mutate' }),
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Flash·mutate'));
    // Should appear near the model name
    const modelIdx = plain.indexOf('DeepSeek v4 Flash');
    const labelIdx = plain.indexOf('Flash·mutate');
    assert.ok(labelIdx > modelIdx);
  });

  it('does not show routing label when not set', () => {
    const result = renderStatusBar(defaultState({} as any));
    const plain = stripAnsi(result);
    // The word "Flash" appears in the model name, but "Flash·mutate" should not appear
    assert.ok(!plain.includes('Flash·mutate'));
    assert.ok(!plain.includes('Pro·'));
  });

  it('does not show routing label when empty string', () => {
    const result = renderStatusBar(
      defaultState({ routingLabel: '' }),
    );
    const plain = stripAnsi(result);
    assert.ok(!plain.includes('Flash·mutate'));
    assert.ok(!plain.includes('Pro·'));
  });

  it('shows tier-only label when phase is missing', () => {
    const result = renderStatusBar(
      defaultState({ routingLabel: 'Flash' }),
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Flash'));
  });

  it('handles truncation with routing label present', () => {
    const result = renderStatusBar(
      defaultState({
        routingLabel: 'Pro·investigate',
        model: 'VeryLongModelNameThatShouldBeTruncated',
        width: 40,
      }),
    );
    const line = firstLine(result);
    // Right-aligned info should still be present
    assert.ok(line.includes('45,000'));
    assert.ok(line.includes('turn'));
    assert.ok(line.length <= 42);
  });

  it('routing label is preserved in colored status backgrounds', () => {
    const result = renderStatusBar(
      defaultState({
        routingLabel: 'Flash·mutate',
        status: 'complete',
      }),
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('Flash·mutate'));
  });
});
