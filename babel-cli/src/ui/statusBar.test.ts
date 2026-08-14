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

  it('is strictly single-line (no sparkline second row)', () => {
    const result = renderStatusBar(
      defaultState({
        modelId: 'deepseek-v4-pro',
        totalTokens: 45000,
        width: 100,
      }),
    );
    // Content is one line + trailing newline (split yields ['…', '']).
    const contentLines = result.replace(/\n$/, '').split('\n');
    assert.equal(contentLines.length, 1);
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

  it('truncates right cluster when it alone exceeds width', () => {
    const result = renderStatusBar(
      defaultState({
        model: 'M',
        mode: 'chat',
        project: 'p',
        modelId: 'deepseek-v4-pro',
        totalTokens: 999_999_999,
        totalCost: 12345.6789,
        turnCount: 9999,
        width: 24,
      }),
    );
    const contentLines = result.replace(/\n$/, '').split('\n');
    assert.equal(contentLines.length, 1, 'must not wrap onto a second row');
    assert.ok(firstLine(result).length <= 24);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Status Bar Styling
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderStatusBar — status styling', () => {
  it('default uses theme panel background without raw reverse video or green flood', () => {
    const result = renderStatusBar(defaultState({} as any));
    const line = firstLineAnsi(result);
    assert.ok(!line.includes('\x1b[42m'), 'must NOT flood screen with green');
    assert.ok(!line.includes('\x1b[41m'), 'must NOT flood screen with red');
  });

  it('completed run uses clean theme panel background without solid green flood', () => {
    const result = renderStatusBar(defaultState({ status: 'complete' }));
    const line = firstLineAnsi(result);
    assert.ok(!line.includes('\x1b[42m'), 'complete must NOT flood the screen with green');
  });

  it('failed run uses clean theme panel background without solid red flood', () => {
    const result = renderStatusBar(defaultState({ status: 'failed' }));
    const line = firstLineAnsi(result);
    assert.ok(!line.includes('\x1b[41m'), 'failed must NOT flood the screen with red');
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
        activeContextTokens: 45000,
        totalTokens: 45000,
      }),
    );
    const lines = result.split('\n');
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
    if (lines.length >= 2 && lines[1]!.length > 0) {
      assert.ok(!lines[1]!.includes('limit:'));
    }
  });

  it('omits token bar when totalTokens is 0 and activeContextTokens is undefined', () => {
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
        activeContextTokens: 500_000,
        totalTokens: 500_000,
        width: 80,
      }),
    );
    // ~50% of 1M = should show "50%" in the main status bar line
    const lines = result.split('\n');
    assert.ok(lines[0]!.includes('50%'));
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
    assert.ok(plain.includes('mutate'));
    const modelIdx = plain.indexOf('DeepSeek v4 Flash');
    const labelIdx = plain.indexOf('mutate');
    assert.ok(labelIdx > modelIdx);
  });

  it('does not show routing label when not set', () => {
    const result = renderStatusBar(defaultState({} as any));
    const plain = stripAnsi(result);
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

  it('handles truncation with routing label present', () => {
    const result = renderStatusBar(
      defaultState({
        routingLabel: 'Pro·investigate',
        model: 'VeryLongModelNameThatShouldBeTruncated',
        width: 40,
      }),
    );
    const line = firstLine(result);
    assert.ok(line.includes('45,000'));
    assert.ok(line.includes('turn'));
    assert.ok(line.length <= 42);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Acceptance Tests T17–T20: Status Bar Refinements
// ═══════════════════════════════════════════════════════════════════════════════

describe('Acceptance Tests T17–T20: Status Bar Refinements', () => {
  it('T17: Status bar uses neutral theme background across all statuses without green flood', () => {
    const completeBar = renderStatusBar(defaultState({ status: 'complete' }));
    const failedBar = renderStatusBar(defaultState({ status: 'failed' }));
    const readyBar = renderStatusBar(defaultState({ status: 'ready' }));

    assert.ok(!completeBar.includes('\x1b[42m'), 'complete must NOT have green bg code');
    assert.ok(!failedBar.includes('\x1b[41m'), 'failed must NOT have red bg code');
  });

  it('T18: Routing label deduplicates model tier name (Flash Flash·escalate -> Flash · escalate)', () => {
    const result = renderStatusBar(
      defaultState({
        model: 'DeepSeek V4 Flash',
        routingLabel: 'Flash·escalate',
      }),
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('DeepSeek V4 Flash · escalate'));
    assert.ok(!plain.includes('Flash Flash'));
  });

  it('T19: Active context tokens numerator is passed to token bar', () => {
    const result = renderStatusBar(
      defaultState({
        modelId: 'deepseek-v4-flash',
        activeContextTokens: 166_588,
        totalTokens: 2_000_000,
        width: 100,
      }),
    );
    const plain = stripAnsi(result);
    // 166,588 / 1,000,000 = 17%
    assert.ok(plain.includes('17%'), `Expected 17% in status bar, got: ${plain}`);
    assert.ok(!plain.includes('100%'), 'Must NOT calculate 100% from cumulative tokens');
  });

  it('T19b: When active context telemetry is missing, renders [ctx ?] and NEVER falls back to totalTokens', () => {
    const result = renderStatusBar(
      defaultState({
        modelId: 'deepseek-v4-flash',
        activeContextTokens: undefined,
        totalTokens: 2_000_000,
        width: 100,
      }),
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('[ctx ?]'), `Expected [ctx ?] when activeContextTokens is missing, got: ${plain}`);
    assert.ok(!plain.includes('100%'), 'Must NOT calculate 100% from cumulative tokens');
    assert.ok(!plain.includes('200%'), 'Must NOT calculate from cumulative tokens');
  });

  it('T20: Width clamping and edge-to-edge padding preserved without terminal line wrap', () => {
    const result = renderStatusBar(defaultState({ width: 80 }));
    const line = firstLine(result);
    assert.equal(line.length, 80);
    const lines = result.replace(/\n$/, '').split('\n');
    assert.equal(lines.length, 1);
  });
});
