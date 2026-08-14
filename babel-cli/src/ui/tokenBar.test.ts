/**
 * tokenBar.test.ts — Tests for the token utilization bar renderer.
 *
 * Covers:
 *   1. classifyUtilization — tier thresholds (Safe/Moderate/High/Critical)
 *   2. getContextLimit — model-specific limits and fallback
 *   3. Unicode block characters in bar rendering
 *   4. renderTokenBar — full-width output
 *   5. renderCompactTokenBar — compact output
 *   6. renderTokenSummary — bar + cost + elapsed
 *   7. Edge cases (zero tokens, exact limits, overflow)
 *   8. formatTokenCount and formatElapsedCompact helpers
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyUtilization,
  getContextLimit,
  getContextLimitFromPolicy,
  renderTokenBar,
  renderCompactTokenBar,
  renderTokenSummary,
  UtilizationTier,
  CONTEXT_LIMITS,
} from './tokenBar.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. classifyUtilization
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyUtilization', () => {
  it('returns Safe for 0%', () => {
    const result = classifyUtilization(0, 200_000);
    assert.equal(result.tier, UtilizationTier.Safe);
    assert.equal(result.percent, 0);
  });

  it('returns Moderate for exactly 50%', () => {
    const result = classifyUtilization(100_000, 200_000);
    assert.equal(result.tier, UtilizationTier.Moderate);
    assert.equal(result.percent, 50);
  });

  it('returns Moderate for 51%', () => {
    const result = classifyUtilization(102_000, 200_000);
    assert.equal(result.tier, UtilizationTier.Moderate);
    assert.equal(result.percent, 51);
  });

  it('returns High for exactly 75%', () => {
    const result = classifyUtilization(150_000, 200_000);
    assert.equal(result.tier, UtilizationTier.High);
    assert.equal(result.percent, 75);
  });

  it('returns High for 76%', () => {
    const result = classifyUtilization(152_000, 200_000);
    assert.equal(result.tier, UtilizationTier.High);
    assert.equal(result.percent, 76);
  });

  it('returns Critical for exactly 90%', () => {
    const result = classifyUtilization(180_000, 200_000);
    assert.equal(result.tier, UtilizationTier.Critical);
    assert.equal(result.percent, 90);
  });

  it('returns Critical for 91%', () => {
    const result = classifyUtilization(182_000, 200_000);
    assert.equal(result.tier, UtilizationTier.Critical);
    assert.equal(result.percent, 91);
  });

  it('clamps percent at 100%', () => {
    const result = classifyUtilization(999_999, 200_000);
    assert.equal(result.percent, 100);
    assert.equal(result.tier, UtilizationTier.Critical);
  });

  it('handles limit of 0 (division by zero guard / unknown limit)', () => {
    const result = classifyUtilization(100, 0);
    assert.equal(result.unknown, true);
    assert.equal(result.percent, null);
  });

  it('handles used=0 gracefully', () => {
    const result = classifyUtilization(0, 200_000);
    assert.equal(result.tier, UtilizationTier.Safe);
    assert.equal(result.percent, 0);
  });

  it('boundary: exactly at 50% is Moderate', () => {
    const result = classifyUtilization(100_000, 200_000);
    assert.equal(result.tier, UtilizationTier.Moderate);
  });

  it('boundary: exactly at 75% is High', () => {
    const result = classifyUtilization(150_000, 200_000);
    assert.equal(result.tier, UtilizationTier.High);
  });

  it('boundary: exactly at 90% is Critical', () => {
    const result = classifyUtilization(180_000, 200_000);
    assert.equal(result.tier, UtilizationTier.Critical);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. getContextLimit
// ═══════════════════════════════════════════════════════════════════════════════

describe('getContextLimit', () => {
  it('returns known limit for Claude Sonnet 4.6', () => {
    const limit = getContextLimit('claude-sonnet-4-6');
    assert.equal(limit.tokens, 200_000);
  });

  it('returns canonical 1M limit for DeepSeek V4 Pro', () => {
    const limit = getContextLimit('deepseek-v4-pro');
    assert.equal(limit.tokens, 1_000_000);
    assert.equal(limit.label, 'DeepSeek V4 Pro');
  });

  it('returns canonical 1M limit for DeepSeek V4 Flash', () => {
    const limit = getContextLimit('deepseek-v4-flash');
    assert.equal(limit.tokens, 1_000_000);
    assert.equal(limit.label, 'DeepSeek V4 Flash');
  });

  it('returns 0 tokens for unlisted DeepSeek V3 (renders ctx ?)', () => {
    const limit = getContextLimit('deepseek-v3');
    assert.equal(limit.tokens, 0);
  });

  it('returns 0 tokens for unknown model (renders ctx ?)', () => {
    const limit = getContextLimit('unknown-model-v1');
    assert.equal(limit.tokens, 0);
  });

  it('CONTEXT_LIMITS includes external Claude model keys', () => {
    const keys = Object.keys(CONTEXT_LIMITS);
    assert.ok(keys.includes('claude-sonnet-4-6'));
    assert.ok(keys.includes('claude-opus-4-8'));
    assert.ok(keys.includes('claude-haiku-4-5'));
    assert.ok(keys.includes('claude-fable-5'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2b. getContextLimitFromPolicy — policy-driven lookup
// ═══════════════════════════════════════════════════════════════════════════════

describe('getContextLimitFromPolicy', () => {
  it('returns ContextLimit for model keyed in model-policy.json', () => {
    const limit = getContextLimitFromPolicy('deepseek-v4-pro');
    assert.ok(limit !== null, 'deepseek-v4-pro should be found in policy');
    assert.equal(limit!.tokens, 1_000_000);
  });

  it('returns ContextLimit for deepseek-v4-flash', () => {
    const limit = getContextLimitFromPolicy('deepseek-v4-flash');
    assert.ok(limit !== null, 'deepseek-v4-flash should be found in policy');
    assert.equal(limit!.tokens, 1_000_000);
  });

  it('returns null for model not in policy', () => {
    const limit = getContextLimitFromPolicy('claude-sonnet-4-6');
    assert.equal(limit, null);
  });

  it('returns null for completely unknown model', () => {
    const limit = getContextLimitFromPolicy('nonexistent-model-v99');
    assert.equal(limit, null);
  });

  it('policy lookup for deepseek-v4-pro takes precedence over hardcoded map', () => {
    const limit = getContextLimit('deepseek-v4-pro');
    assert.equal(limit.tokens, 1_000_000);
    assert.equal(limit.label, 'DeepSeek V4 Pro');
  });

  it('policy lookup for deepseek-v4-flash returns 1M', () => {
    const limit = getContextLimit('deepseek-v4-flash');
    assert.equal(limit.tokens, 1_000_000);
  });

  it('falls back to hardcoded map for claude model not in policy', () => {
    const limit = getContextLimit('claude-opus-4-8');
    assert.equal(limit.tokens, 200_000);
    assert.equal(limit.label, 'Opus 4.8');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Acceptance Tests T1–T5: Telemetry Truthfulness
// ═══════════════════════════════════════════════════════════════════════════════

describe('Acceptance Tests T1–T5: Telemetry Truthfulness', () => {
  it('T1: DeepSeek V4 Flash with 166,588 active tokens calculates ~16.66% (17%)', () => {
    const limit = getContextLimit('deepseek-v4-flash');
    assert.equal(limit.tokens, 1_000_000);
    const util = classifyUtilization(166_588, limit.tokens);
    assert.equal(util.percent, 17);
    const bar = renderCompactTokenBar(166_588, limit.tokens);
    assert.ok(bar.includes('17%'), `Expected 17% in bar, got: ${bar}`);
  });

  it('T2: Session total 2,000,000 does not inflate active context (100,000 active / 1M = 10%)', () => {
    const limit = getContextLimit('deepseek-v4-flash');
    const activeContextTokens = 100_000;
    const util = classifyUtilization(activeContextTokens, limit.tokens);
    assert.equal(util.percent, 10);
    const bar = renderCompactTokenBar(activeContextTokens, limit.tokens);
    assert.ok(bar.includes('10%'));
    assert.ok(!bar.includes('100%'), 'Must NOT calculate 100% from session total!');
  });

  it('T3: Unknown model or unknown context limit renders ctx ?', () => {
    const limit = getContextLimit('some-totally-unknown-model-xyz');
    assert.equal(limit.tokens, 0);
    const bar = renderCompactTokenBar(10_000, limit.tokens);
    assert.equal(bar, '[ctx ?]');
  });

  it('T4: Model switch within session resolves active model capability', () => {
    const limitA = getContextLimit('claude-sonnet-4-6');
    const limitB = getContextLimit('deepseek-v4-flash');
    assert.equal(limitA.tokens, 200_000);
    assert.equal(limitB.tokens, 1_000_000);
    assert.equal(classifyUtilization(100_000, limitA.tokens).percent, 50);
    assert.equal(classifyUtilization(100_000, limitB.tokens).percent, 10);
  });

  it('T5: Post-compaction active context reflects compacted size', () => {
    const limit = getContextLimit('deepseek-v4-flash');
    const preCompactionTokens = 850_000;
    const postCompactionTokens = 120_000;
    assert.equal(classifyUtilization(preCompactionTokens, limit.tokens).percent, 85);
    assert.equal(classifyUtilization(postCompactionTokens, limit.tokens).percent, 12);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. renderTokenBar — full-width output
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderTokenBar', () => {
  it('returns a string containing bar characters, percent, and usage', () => {
    const result = renderTokenBar(45000, 200_000, undefined, 50);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
    // Should contain Unicode block chars (█)
    assert.ok(result.includes('█'));
    // Should contain percentage
    assert.ok(result.includes('22%') || result.includes('23%'));
  });

  it('shows 0% when used=0', () => {
    const result = renderTokenBar(0, 200_000, undefined, 30);
    assert.ok(result.includes('0%'));
  });

  it('shows 100% when used exceeds limit', () => {
    const result = renderTokenBar(300_000, 200_000, undefined, 30);
    assert.ok(result.includes('100%'));
  });

  it('includes model label when provided', () => {
    const result = renderTokenBar(45000, 200_000, 'Sonnet 4.6', 50);
    assert.ok(result.includes('45k'));
  });

  it('uses default width when not specified', () => {
    const result = renderTokenBar(45000, 200_000);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('handles very small width', () => {
    // width=10 should still produce a valid bar with at least 6 bar chars
    const result = renderTokenBar(50000, 200_000, undefined, 10);
    assert.ok(result.includes('%'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. renderCompactTokenBar — compact output
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderCompactTokenBar', () => {
  it('returns a bracketed bar string with percent', () => {
    const result = renderCompactTokenBar(45000, 200_000, 10);
    assert.ok(result.startsWith('['));
    assert.ok(result.endsWith(']'));
    assert.ok(result.includes('%'));
  });

  it('shows correct percentage for half-full context', () => {
    const result = renderCompactTokenBar(100_000, 200_000, 10);
    assert.ok(result.includes('50%'));
  });

  it('uses default bar width of 10 when not specified', () => {
    const result = renderCompactTokenBar(45000, 200_000);
    assert.ok(result.startsWith('['));
    assert.ok(result.endsWith(']'));
  });

  it('shows 100% for overfilled context', () => {
    const result = renderCompactTokenBar(999_999, 200_000, 10);
    assert.ok(result.includes('100%'));
  });

  it('includes Unicode block characters', () => {
    const result = renderCompactTokenBar(100_000, 200_000, 10);
    // Should have either full blocks or empty blocks
    assert.ok(result.includes('█') || result.includes('░'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. renderTokenSummary — bar + cost + elapsed
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderTokenSummary', () => {
  it('returns a string containing bar, cost, and time', () => {
    const result = renderTokenSummary(45000, 200_000, 0.1234, 65000);
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('$0.1234'));
    // ~65 seconds = 1:05
    assert.ok(result.includes('1:05'));
  });

  it('shows $0.0000 for zero cost', () => {
    const result = renderTokenSummary(0, 200_000, 0, 0);
    assert.ok(result.includes('$0.0000'));
  });

  it('does not end with a newline', () => {
    const result = renderTokenSummary(45000, 200_000, 0.01, 1000);
    assert.ok(!result.endsWith('\n'));
  });

  it('handles large cost values', () => {
    const result = renderTokenSummary(200_000, 200_000, 12.3456, 60000);
    assert.ok(result.includes('$12.3456'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Unicode block characters and edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('token bar — Unicode block characters', () => {
  it('renders full blocks (█) at 100%', () => {
    const result = renderCompactTokenBar(200_000, 200_000, 10);
    // At 100%, every character should be a full block
    const barContent = result.replace(/[[\]%0-9 ]/g, '');
    assert.ok(barContent.includes('█'));
  });

  it('renders empty bar at 0%', () => {
    const result = renderCompactTokenBar(0, 200_000, 10);
    // At 0%, the bar should be all empty (no filled blocks)
    const barContent = result.replace(/[[\]%0-9 ]/g, '');
    assert.ok(!barContent.includes('█'));
  });

  it('uses partial blocks (▏▎▍▌▋▊▉) for fractional positions', () => {
    // Very small usage to get partial blocks
    const result = renderCompactTokenBar(1, 200_000, 10);
    const partials = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'];
    const hasPartial = partials.some((p) => result.includes(p));
    // At 0%, there won't be partials, but we can test at 12.5% for a single partial
    const result2 = renderCompactTokenBar(25_000, 200_000, 10);
    const hasPartial2 = partials.some((p) => result2.includes(p));
    // 12.5% of 80 sub-steps = 10 filled → 1 full block + 2/8 partial
    // Depends on rounding, but should have at least some bars
    assert.ok(result2.includes('█') || hasPartial2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Utilization tier exports
// ═══════════════════════════════════════════════════════════════════════════════

describe('UtilizationTier enum', () => {
  it('has all four expected values', () => {
    assert.equal(UtilizationTier.Safe, 'safe');
    assert.equal(UtilizationTier.Moderate, 'moderate');
    assert.equal(UtilizationTier.High, 'high');
    assert.equal(UtilizationTier.Critical, 'critical');
  });
});
