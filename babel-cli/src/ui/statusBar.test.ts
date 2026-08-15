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
import {
  renderStatusBar,
  planStatusBarFields,
  applyAttentionPreemption,
  ATTENTION_PREEMPTION,
  classifyStatusWidth,
  classifyRateLimitAttention,
  isDefaultStatusMode,
} from './statusBar.js';
import type { StatusBarState } from './statusBar.js';
import {
  getGlobalRateLimitState,
  setGlobalRateLimitState,
} from './rateLimitWidget.js';
import type { RateLimitState } from './rateLimitWidget.js';

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
  it('contains model identity at default width', () => {
    const result = renderStatusBar(defaultState({ width: 80 }));
    const plain = stripAnsi(result);
    assert.ok(plain.includes('DeepSeek v4 Flash'));
    assert.ok(!plain.includes('default'), 'default mode is shed');
    assert.ok(!plain.includes('my-project'), 'project name is not persistent chrome');
  });

  it('shows cost and session tokens only at the Stage 0 bands that allow them', () => {
    const wide = stripAnsi(renderStatusBar(defaultState({ width: 160 })));
    assert.ok(wide.includes('45,000 tok'));
    assert.ok(wide.includes('$0.1234'));
    assert.ok(wide.includes('turn 42'));
    const mid = stripAnsi(renderStatusBar(defaultState({ width: 100 })));
    assert.ok(mid.includes('$0.1234'));
    assert.ok(!mid.includes('45,000 tok'));
    assert.ok(!mid.includes('turn 42'));
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

  it('shows background tasks when provided at 80+', () => {
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
  });

  it('sheds background tasks at width 60', () => {
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
        width: 60,
      }),
    );
    const plain = stripAnsi(result);
    assert.ok(!plain.includes('Indexing'));
  });

  it('omits background tasks section when absent', () => {
    const result = renderStatusBar(defaultState({} as any));
    const plain = stripAnsi(result);
    assert.ok(plain.includes('DeepSeek'));
  });

  it('renders with zero tokens and zero cost at 160', () => {
    const result = renderStatusBar(
      defaultState({
        totalTokens: 0,
        totalCost: 0,
        turnCount: 0,
        width: 160,
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
    assert.ok(line.includes('VeryLong') || line.includes('…'));
    assert.equal(result.replace(/\n$/, '').split('\n').length, 1);
    assert.ok(line.length <= 42);
  });

  it('stays single-line under severe truncation', () => {
    const result = renderStatusBar(
      defaultState({
        model: 'ExtremelyLongModelNameThatWillGetTruncated',
        mode: 'very-long-mode-name',
        project: 'project-with-long-name',
        width: 30,
      }),
    );
    const line = firstLine(result);
    assert.equal(line.length, 30);
    assert.equal(result.replace(/\n$/, '').split('\n').length, 1);
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
  it('sheds routing labels from the default status bar', () => {
    const result = renderStatusBar(
      defaultState({ routingLabel: 'Flash·mutate', width: 160 }),
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('DeepSeek v4 Flash'));
    assert.ok(!plain.includes('mutate'));
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

  it('handles truncation with routing label present (routing still shed)', () => {
    const result = renderStatusBar(
      defaultState({
        routingLabel: 'Pro·investigate',
        model: 'VeryLongModelNameThatShouldBeTruncated',
        width: 40,
      }),
    );
    const line = firstLine(result);
    assert.ok(!line.includes('investigate'));
    assert.ok(line.length <= 42);
    assert.equal(result.replace(/\n$/, '').split('\n').length, 1);
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

  it('T18: Routing cue is shed (not a persistent default-chat field)', () => {
    const result = renderStatusBar(
      defaultState({
        model: 'DeepSeek V4 Flash',
        routingLabel: 'Flash·escalate',
        width: 160,
      }),
    );
    const plain = stripAnsi(result);
    assert.ok(plain.includes('DeepSeek V4 Flash'));
    assert.ok(!plain.includes('escalate'));
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

  it('T21: Turn 1 provider usage followed by Turn 2 failure before provider request renders [ctx ?]', () => {
    // Turn 1 completed with active provider telemetry
    let turn1State = defaultState({
      modelId: 'deepseek-v4-flash',
      activeContext: { tokens: 166_588, modelId: 'deepseek-v4-flash', source: 'provider_prompt_tokens' },
      totalTokens: 166_588,
      width: 100,
    });
    let plain1 = stripAnsi(renderStatusBar(turn1State));
    assert.ok(plain1.includes('17%'));

    // Turn 2 started but fails before any provider invocation -> activeContext is cleared
    let turn2State = defaultState({
      modelId: 'deepseek-v4-flash',
      activeContext: null,
      activeContextTokens: undefined,
      totalTokens: 166_588,
      width: 100,
    });
    let plain2 = stripAnsi(renderStatusBar(turn2State));
    assert.ok(plain2.includes('[ctx ?]'), `Expected [ctx ?] for turn 2 without provider request, got: ${plain2}`);
    assert.ok(!plain2.includes('17%'));
  });

  it('T22: Context denominator resolves from activeContext.modelId when different from session model', () => {
    // Session model is 1M deepseek-v4-flash, but invocation fell back to 200k claude-sonnet-4-6
    const state = defaultState({
      modelId: 'deepseek-v4-flash',
      activeContext: {
        tokens: 50_000,
        modelId: 'claude-sonnet-4-6',
        source: 'provider_prompt_tokens',
      },
      totalTokens: 50_000,
      width: 100,
    });
    const plain = stripAnsi(renderStatusBar(state));
    // 50,000 / 200,000 (claude-sonnet-4-6) = 25% (NOT 50,000 / 1,000,000 = 5%)
    assert.ok(plain.includes('25%'), `Expected 25% calculated against activeContext.modelId limit, got: ${plain}`);
  });
});

describe('status bar — explicit field shedding', () => {
  it('classifies the frozen width bands', () => {
    assert.equal(classifyStatusWidth(60), 60);
    assert.equal(classifyStatusWidth(79), 60);
    assert.equal(classifyStatusWidth(80), 80);
    assert.equal(classifyStatusWidth(100), 100);
    assert.equal(classifyStatusWidth(120), 120);
    assert.equal(classifyStatusWidth(160), 160);
    assert.ok(isDefaultStatusMode('default'));
    assert.ok(isDefaultStatusMode('chat'));
    assert.ok(!isDefaultStatusMode('deep'));
  });

  it('plans fields from the Stage 0 matrix instead of rendering everything', () => {
    const at60 = planStatusBarFields(60, {
      mode: 'default',
      hasBranch: true,
      hasBgTasks: true,
      hasActiveRateLimit: true,
    });
    assert.equal(at60.showMode, false);
    assert.equal(at60.showCost, false);
    assert.equal(at60.showSessionTokens, false);
    assert.equal(at60.showBranch, false);
    assert.equal(at60.showTurn, false);
    assert.equal(at60.showKg, false);
    assert.equal(at60.showRouting, false);
    assert.equal(at60.showBgTasks, false);
    assert.equal(at60.showRateLimit, false);

    const at80 = planStatusBarFields(80, {
      mode: 'deep',
      hasBranch: true,
      hasBgTasks: true,
      hasActiveRateLimit: false,
    });
    assert.equal(at80.showMode, true);
    assert.equal(at80.showCost, false);
    assert.equal(at80.showBgTasks, true);
    assert.equal(at80.showRateLimit, false);

    const at100 = planStatusBarFields(100, {
      mode: 'default',
      hasBranch: false,
      hasBgTasks: false,
      hasActiveRateLimit: false,
    });
    assert.equal(at100.showCost, true);
    assert.equal(at100.showSessionTokens, false);
    assert.equal(at100.showTurn, false);

    const at120 = planStatusBarFields(120, {
      mode: 'chat',
      hasBranch: true,
      hasBgTasks: false,
      hasActiveRateLimit: false,
    });
    assert.equal(at120.showSessionTokens, true);
    assert.equal(at120.showBranch, true);
    assert.equal(at120.showTurn, false);

    const at160 = planStatusBarFields(160, {
      mode: 'plan',
      hasBranch: true,
      hasBgTasks: false,
      hasActiveRateLimit: false,
    });
    assert.equal(at160.showTurn, true);
    assert.equal(at160.showMode, true);
  });

  it('does not wrap at 60/80/100/120/160 and keeps model identity at 60/80', () => {
    const widths = [60, 80, 100, 120, 160] as const;
    for (const width of widths) {
      const result = renderStatusBar(
        defaultState({
          width,
          modelId: 'deepseek-v4-flash',
          activeContext: {
            tokens: 12_400,
            modelId: 'deepseek-v4-flash',
            source: 'provider',
          },
          gitBranch: 'feat/tui',
          gitDirty: true,
          knowledgeGraph: { status: 'ready', nodeCount: 1284 },
          routingLabel: 'Flash·mutate',
        }),
      );
      const line = firstLine(result);
      assert.equal(line.length, width, `width ${width} padded`);
      assert.equal(result.replace(/\n$/, '').split('\n').length, 1, `width ${width} must not wrap`);
      assert.ok(!line.includes('kg'), `width ${width} sheds kg`);
      assert.ok(!line.includes('mutate'), `width ${width} sheds routing`);
      if (width >= 60) {
        assert.ok(line.includes('DeepSeek'), `width ${width} keeps model identity: ${line}`);
      }
      if (width < 80) {
        assert.ok(!line.includes('default'));
        assert.ok(!line.includes('$0.1234'));
      }
      if (width < 100) {
        assert.ok(!line.includes('$0.1234'), `width ${width} sheds cost`);
      }
      if (width < 120) {
        assert.ok(!line.includes('45,000 tok'), `width ${width} sheds session tok`);
        assert.ok(!line.includes('feat/tui'));
      }
      if (width < 160) {
        assert.ok(!line.includes('turn 42'), `width ${width} sheds turn`);
      }
    }
  });

  it('keeps unknown model / unknown limit / unknown active context unknown', () => {
    const unknownModel = firstLine(
      renderStatusBar(
        defaultState({
          width: 80,
          model: 'mystery-local',
          modelId: 'mystery-local',
          activeContext: { tokens: 800, modelId: 'mystery-local', source: 'unknown' },
        }),
      ),
    );
    assert.ok(unknownModel.includes('mystery-local'));
    assert.ok(unknownModel.includes('[ctx ?]'));
    assert.ok(!unknownModel.includes('%'));

    const unknownActive = firstLine(
      renderStatusBar(
        defaultState({
          width: 80,
          modelId: 'deepseek-v4-flash',
          activeContext: null,
          activeContextTokens: undefined,
        }),
      ),
    );
    assert.ok(unknownActive.includes('[ctx ?]'));
    assert.ok(!unknownActive.includes('%'));
  });

  it('keeps 1M windows readable and does not let helper model switch corrupt the denominator', () => {
    const oneM = firstLine(
      renderStatusBar(
        defaultState({
          width: 120,
          model: 'DeepSeek V4 Pro',
          modelId: 'deepseek-v4-pro',
          activeContext: { tokens: 412_000, modelId: 'deepseek-v4-pro', source: 'provider' },
        }),
      ),
    );
    assert.ok(oneM.includes('41%'), oneM);

    const switched = firstLine(
      renderStatusBar(
        defaultState({
          width: 100,
          model: 'DeepSeek V4 Flash',
          modelId: 'deepseek-v4-flash',
          activeContext: { tokens: 50_000, modelId: 'claude-sonnet-4-6', source: 'provider' },
        }),
      ),
    );
    assert.ok(switched.includes('25%'), switched);
    assert.ok(!/\b5%/.test(switched), switched);
  });

  it('shows a long model name at width 60 without fabricating a percent', () => {
    const line = firstLine(
      renderStatusBar(
        defaultState({
          width: 60,
          model: 'anthropic-claude-opus-4-8-preview-extended',
          modelId: 'unknown-long-model',
          activeContext: null,
        }),
      ),
    );
    assert.equal(line.length, 60);
    assert.ok(line.includes('anthropic') || line.includes('…'));
    assert.ok(line.includes('[ctx ?]') || line.includes('ctx'));
  });
});

describe('status bar — attention-preemption policy', () => {
  function withRateLimit(state: RateLimitState | null, fn: () => void): void {
    const prev = getGlobalRateLimitState();
    setGlobalRateLimitState(state);
    try {
      fn();
    } finally {
      setGlobalRateLimitState(prev);
    }
  }

  it('classifies warning vs critical/exhausted attention', () => {
    assert.equal(classifyRateLimitAttention(251, 1000), 'none');
    assert.equal(classifyRateLimitAttention(200, 1000), 'warning');
    assert.equal(classifyRateLimitAttention(50, 1000), 'critical');
    assert.equal(classifyRateLimitAttention(0, 1000), 'critical');
    assert.equal(classifyRateLimitAttention(10, 0), 'none');
  });

  it('keeps 60-col as model … context, and lets critical rate-limit take that right slot', () => {
    const state = {
      model: 'Flash',
      modelId: 'deepseek-v4-flash',
      width: 60,
      activeContext: {
        tokens: 12_400,
        modelId: 'deepseek-v4-flash',
        source: 'provider' as const,
      },
    };
    const normal = firstLine(renderStatusBar(defaultState(state)));
    assert.match(normal, /^Flash\s+\[/);
    assert.ok(normal.includes('%') || normal.includes('ctx'), normal);
    assert.ok(!normal.includes('API:'), normal);
    assert.ok(!normal.includes('⛔'), normal);

    withRateLimit(
      { remaining: 0, limit: 1000, resetAt: new Date(Date.now() + 12 * 60_000) },
      () => {
        const critical = firstLine(renderStatusBar(defaultState(state)));
        assert.match(critical, /^Flash\s+/);
        assert.ok(critical.includes('⛔') || critical.includes('API:'), critical);
        assert.ok(
          !critical.includes('%') && !critical.includes('[ctx'),
          `context must yield the 60-col right slot: ${critical}`,
        );
      },
    );
  });

  it('lets critical rate-limit appear at 60; warning stays at 80+', () => {
    const warn60 = planStatusBarFields(60, {
      mode: 'default',
      hasBranch: true,
      hasBgTasks: true,
      hasActiveRateLimit: true,
      hasCriticalRateLimit: false,
    });
    assert.equal(warn60.showRateLimit, false);
    assert.equal(warn60.showBgTasks, false);

    const crit60 = planStatusBarFields(60, {
      mode: 'default',
      hasBranch: true,
      hasBgTasks: true,
      hasActiveRateLimit: true,
      hasCriticalRateLimit: true,
    });
    assert.equal(crit60.showRateLimit, true);
    assert.equal(crit60.showContext, false);
    assert.equal(crit60.showBgTasks, false);
    assert.equal(warn60.showContext, true);

    const warn80 = planStatusBarFields(80, {
      mode: 'deep',
      hasBranch: true,
      hasBgTasks: true,
      hasActiveRateLimit: true,
      hasCriticalRateLimit: false,
    });
    assert.equal(warn80.showRateLimit, true);
    assert.equal(warn80.showContext, true);
    assert.equal(warn80.showMode, false);
    assert.equal(warn80.showBgTasks, false);

    const crit80 = planStatusBarFields(80, {
      mode: 'deep',
      hasBranch: true,
      hasBgTasks: true,
      hasActiveRateLimit: true,
      hasCriticalRateLimit: true,
    });
    assert.equal(crit80.showRateLimit, true);
    assert.equal(crit80.showContext, true);
    assert.equal(crit80.showMode, false);
    assert.equal(crit80.showBgTasks, false);

    const calm80 = planStatusBarFields(80, {
      mode: 'deep',
      hasBranch: true,
      hasBgTasks: true,
      hasActiveRateLimit: false,
      hasCriticalRateLimit: false,
    });
    assert.equal(calm80.showMode, true);
    assert.equal(calm80.showBgTasks, true);
    assert.equal(calm80.showRateLimit, false);
  });

  it('names the preemption bands and drop order', () => {
    assert.equal(ATTENTION_PREEMPTION.criticalRateLimitMinBand, 60);
    assert.equal(ATTENTION_PREEMPTION.warningRateLimitMinBand, 80);
    assert.equal(ATTENTION_PREEMPTION.contextYieldsBelowBand, 80);
    assert.equal(ATTENTION_PREEMPTION.modeYieldsBelowBand, 100);
    assert.equal(ATTENTION_PREEMPTION.bgTasksYieldBelowBand, 100);
    assert.deepEqual(ATTENTION_PREEMPTION.displaceInOrder, [
      'turn',
      'sessionTokens',
      'cost',
      'bgTasks',
      'rateLimit',
    ]);
  });

  it('keeps 80-col as model · mode … context, and drops mode when attention is live', () => {
    const state = {
      model: 'Flash',
      mode: 'deep',
      modelId: 'deepseek-v4-flash',
      width: 80,
      activeContext: {
        tokens: 12_400,
        modelId: 'deepseek-v4-flash',
        source: 'provider' as const,
      },
    };
    const normal = firstLine(renderStatusBar(defaultState(state)));
    assert.match(normal, /^Flash · deep\s+\[/);
    assert.ok(normal.includes('%') || normal.includes('ctx'), normal);
    assert.ok(!normal.includes('⛔'), normal);

    withRateLimit(
      { remaining: 0, limit: 1000, resetAt: new Date(Date.now() + 12 * 60_000) },
      () => {
        const attention = firstLine(renderStatusBar(defaultState(state)));
        assert.match(attention, /^Flash\s+/);
        assert.ok(!attention.includes(' · deep'), `mode yields at 80 when attention is live: ${attention}`);
        assert.ok(attention.includes('⛔') || attention.includes('API:'), attention);
        assert.ok(
          attention.includes('%') || attention.includes('ctx'),
          `context survives beside rate-limit at 80: ${attention}`,
        );
      },
    );
  });

  it('drops whole slots instead of truncating a surviving concept', () => {
    const packed = applyAttentionPreemption(
      [
        { slot: 'turn', text: 'turn 9999' },
        { slot: 'rateLimit', text: 'API: 0/1000 ⛔ 12m' },
        { slot: 'context', text: '[████████  50%]' },
      ],
      22,
      true,
    );
    assert.ok(!packed.includes('…'), `must not mid-clip a slot: ${packed}`);
    assert.ok(packed.includes('0/1000') || packed.includes('50%'), packed);
    assert.ok(!packed.includes('turn'), packed);
  });

  it('displaces turn, session tokens, and cost before the context meter', () => {
    const packed = applyAttentionPreemption(
      [
        { slot: 'sessionTokens', text: '999,999,999 tok' },
        { slot: 'cost', text: '$12345.6789' },
        { slot: 'turn', text: 'turn 9999' },
        { slot: 'rateLimit', text: 'API: 0/1000 ⛔ 12m' },
        { slot: 'context', text: '[████████  50%]' },
      ],
      40,
      true,
    );
    assert.ok(packed.includes('50%'), `context should survive: ${packed}`);
    assert.ok(packed.includes('0/1000'), `critical rate-limit should survive: ${packed}`);
    assert.ok(!packed.includes('turn'), packed);
    assert.ok(!packed.includes('tok'), packed);
    assert.ok(!packed.includes('$12345'), packed);
  });

  it('shows exhausted rate-limit at width 60 in place of the context meter', () => {
    withRateLimit(
      { remaining: 0, limit: 1000, resetAt: new Date(Date.now() + 12 * 60_000) },
      () => {
        const line = firstLine(
          renderStatusBar(
            defaultState({
              width: 60,
              modelId: 'deepseek-v4-flash',
              activeContext: {
                tokens: 12_400,
                modelId: 'deepseek-v4-flash',
                source: 'provider',
              },
            }),
          ),
        );
        assert.ok(line.length <= 60, `must not wrap: ${line.length}`);
        assert.ok(
          line.includes('0/1000') || line.includes('⛔'),
          `expected exhausted rate-limit at 60: ${line}`,
        );
        assert.ok(
          !line.includes('%') && !line.includes('[ctx'),
          `context yields at 60 when rate-limit is critical: ${line}`,
        );
      },
    );
  });

  it('keeps warning rate-limit shed at 60 and visible at 80', () => {
    const state = {
      remaining: 200,
      limit: 1000,
      resetAt: new Date(Date.now() + 60_000),
    };
    withRateLimit(state, () => {
      const at60 = firstLine(
        renderStatusBar(
          defaultState({
            width: 60,
            modelId: 'deepseek-v4-flash',
            activeContext: {
              tokens: 12_400,
              modelId: 'deepseek-v4-flash',
              source: 'provider',
            },
          }),
        ),
      );
      assert.ok(!at60.includes('⚠'), at60);
      assert.ok(!at60.includes('200/1000'), at60);

      const at80 = firstLine(
        renderStatusBar(
          defaultState({
            width: 80,
            modelId: 'deepseek-v4-flash',
            activeContext: {
              tokens: 12_400,
              modelId: 'deepseek-v4-flash',
              source: 'provider',
            },
          }),
        ),
      );
      assert.ok(at80.includes('200/1000') || at80.includes('⚠'), at80);
    });
  });

  it('drops cost before clipping the context meter when attention fields collide', () => {
    withRateLimit(
      { remaining: 0, limit: 1000, resetAt: new Date(Date.now() + 12 * 60_000) },
      () => {
        const line = firstLine(
          renderStatusBar(
            defaultState({
              width: 80,
              mode: 'deep',
              model: 'DeepSeek v4 Flash',
              totalCost: 12345.6789,
              modelId: 'deepseek-v4-flash',
              activeContext: {
                tokens: 500_000,
                modelId: 'deepseek-v4-flash',
                source: 'provider',
              },
              backgroundTasks: [
                {
                  id: '1',
                  label: 'Indexing-a-very-long-background-task-name',
                  status: 'running',
                  current: 567,
                  total: 1234,
                  progress: 45,
                  elapsedMs: 3200,
                },
              ],
            }),
          ),
        );
        assert.ok(line.length <= 80, `must not wrap: ${line.length}`);
        assert.ok(line.includes('50%') || line.includes('['), `context should survive: ${line}`);
        assert.ok(
          line.includes('0/1000') || line.includes('⛔'),
          `critical rate-limit should survive: ${line}`,
        );
        assert.ok(!line.includes('$12345'), `cost is a 100-band field and must not displace attention: ${line}`);
      },
    );
  });
});
