/**
 * usageCharts.test.ts — Tests for the usage/token chart visualization system.
 *
 * Covers:
 *   1. TokenUsageTracker — record, getSummary, getByModel, getDailyHistory, load, save, clear
 *   2. estimateCost — pricing calculation for known and unknown models
 *   3. renderHorizontalBar — output shape, width, edge cases
 *   4. renderSparkline — braille sparkline rendering, width, edge cases
 *   5. renderUsageSummary — full panel structure with box-drawing characters
 *   6. renderModelBreakdown — per-model table rendering
 *   7. renderDailyChart — daily chart with bars + sparkline
 *   8. renderDistributionSegment — proportional bar segments
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TokenUsageTracker,
  TokenUsageRecord,
  UsageSummary,
  estimateCost,
  renderHorizontalBar,
  renderSparkline,
  renderUsageSummary,
  renderModelBreakdown,
  renderDailyChart,
  renderDistributionSegment,
} from './usageCharts.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRecord(
  overrides: Partial<TokenUsageRecord> = {},
): TokenUsageRecord {
  return {
    timestamp: overrides.timestamp ?? Date.now(),
    sessionId: overrides.sessionId ?? 'test-session',
    model: overrides.model ?? 'claude-sonnet-4-6',
    promptTokens: overrides.promptTokens ?? 1000,
    completionTokens: overrides.completionTokens ?? 500,
    totalTokens: overrides.totalTokens ?? 1500,
  };
}

/** Strip ANSI escape codes for length/pattern assertions. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. TokenUsageTracker
// ═══════════════════════════════════════════════════════════════════════════════

describe('TokenUsageTracker', () => {
  it('records a single entry and returns it in getRecords', () => {
    const tracker = new TokenUsageTracker();
    tracker.record(makeRecord({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }));
    const records = tracker.getRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.promptTokens, 1000);
    assert.equal(records[0]!.completionTokens, 500);
    assert.equal(records[0]!.totalTokens, 1500);
    assert.equal(records[0]!.model, 'claude-sonnet-4-6');
    assert.equal(records[0]!.sessionId, 'test-session');
    assert.ok(typeof records[0]!.timestamp === 'number');
  });

  it('maintains insertion order (oldest first)', () => {
    const tracker = new TokenUsageTracker();
    tracker.record(makeRecord({ promptTokens: 100 }));
    tracker.record(makeRecord({ promptTokens: 200 }));
    const records = tracker.getRecords();
    assert.equal(records[0]!.promptTokens, 100);
    assert.equal(records[1]!.promptTokens, 200);
  });

  it('getByModel aggregates tokens per model', () => {
    const tracker = new TokenUsageTracker();
    tracker.record(makeRecord({ model: 'claude-sonnet-4-6', promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }));
    tracker.record(makeRecord({ model: 'claude-sonnet-4-6', promptTokens: 500, completionTokens: 300, totalTokens: 800 }));
    tracker.record(makeRecord({ model: 'claude-opus-4-8', promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 }));

    const byModel = tracker.getByModel();
    assert.equal(byModel.size, 2);

    const sonnet = byModel.get('claude-sonnet-4-6')!;
    assert.ok(sonnet);
    assert.equal(sonnet.promptTokens, 1500);
    assert.equal(sonnet.completionTokens, 800);
    assert.equal(sonnet.totalTokens, 2300);

    const opus = byModel.get('claude-opus-4-8')!;
    assert.ok(opus);
    assert.equal(opus.promptTokens, 2000);
    assert.equal(opus.completionTokens, 1000);
    assert.equal(opus.totalTokens, 3000);
  });

  it('getByModel returns empty map when no records', () => {
    const tracker = new TokenUsageTracker();
    const byModel = tracker.getByModel();
    assert.equal(byModel.size, 0);
  });

  it('getDailyHistory returns the correct number of days', () => {
    const tracker = new TokenUsageTracker();
    const history = tracker.getDailyHistory(7);
    assert.equal(history.length, 7);
  });

  it('getDailyHistory returns oldest-first ordering', () => {
    const tracker = new TokenUsageTracker();
    // Add a record to yesterday
    const yesterday = Date.now() - 86400000;
    tracker.record(makeRecord({ timestamp: yesterday, totalTokens: 100 }));
    // Add a record to today
    tracker.record(makeRecord({ timestamp: Date.now(), totalTokens: 200 }));

    const history = tracker.getDailyHistory(2);
    assert.equal(history.length, 2);
    // Oldest day (yesterday, index 0) should have lower tokens than today (index 1)
    assert.equal(history[0]!.totalTokens, 100);
    assert.equal(history[1]!.totalTokens, 200);
  });

  it('getDailyHistory includes today with zero tokens when no records exist', () => {
    const tracker = new TokenUsageTracker();
    const history = tracker.getDailyHistory(1);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.totalTokens, 0);
  });

  it('getDailyHistory attributes tokens to correct day', () => {
    const tracker = new TokenUsageTracker();
    // Create a record for yesterday
    const yesterday = Date.now() - 86400000;
    tracker.record(makeRecord({ timestamp: yesterday, totalTokens: 5000 }));
    const history = tracker.getDailyHistory(2);
    assert.equal(history.length, 2);
    // Yesterday should have 5000 tokens, today should have 0
    assert.equal(history[0]!.totalTokens, 5000);
    assert.equal(history[1]!.totalTokens, 0);
  });

  it('clear removes all records', () => {
    const tracker = new TokenUsageTracker();
    tracker.record(makeRecord());
    tracker.record(makeRecord());
    assert.equal(tracker.getRecords().length, 2);
    tracker.clear();
    assert.equal(tracker.getRecords().length, 0);
  });

  it('getSummary returns correct periods for today records', () => {
    const tracker = new TokenUsageTracker();
    tracker.record(makeRecord({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }));

    const summary = tracker.getSummary();
    // Today should include the record
    assert.equal(summary.today.totalTokens, 1500);
    assert.equal(summary.today.promptTokens, 1000);
    assert.equal(summary.today.completionTokens, 500);
    // All time should be same since there's only one record
    assert.equal(summary.allTime.totalTokens, 1500);
  });

  it('getSummary includes all records in allTime', () => {
    const tracker = new TokenUsageTracker();
    tracker.record(makeRecord({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }));
    tracker.record(makeRecord({ promptTokens: 200, completionTokens: 100, totalTokens: 300 }));

    const summary = tracker.getSummary();
    assert.equal(summary.allTime.totalTokens, 450);
    assert.equal(summary.allTime.promptTokens, 300);
    assert.equal(summary.allTime.completionTokens, 150);
  });

  it('getSummary computes cost for each period', () => {
    const tracker = new TokenUsageTracker();
    // Claude Sonnet: $3/M input, $15/M output
    tracker.record(makeRecord({
      model: 'claude-sonnet-4-6',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    }));

    const summary = tracker.getSummary();
    const expectedCost = 3 + 15; // $3 for 1M input + $15 for 1M output
    assert.ok(Math.abs(summary.allTime.cost - expectedCost) < 0.001);
  });

  it('getSummary periods nest correctly: today ⊆ thisWeek ⊆ allTime', () => {
    const tracker = new TokenUsageTracker();
    const now = new Date();
    const todayMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    // 1 hour before midnight today = yesterday at 11pm. This record is never in
    // today, always in allTime, and is in thisWeek UNLESS today is Monday (the
    // week starts Monday, so yesterday/Sunday falls in the previous week).
    const beforeToday = todayMidnight - 3600000;
    tracker.record(makeRecord({ timestamp: beforeToday, totalTokens: 1000 }));

    const summary = tracker.getSummary();
    assert.equal(summary.today.totalTokens, 0, 'yesterday record not in today');
    // yesterday is in this week on all days EXCEPT Monday (week starts Monday)
    const expectedThisWeek = now.getDay() === 1 ? 0 : 1000;
    assert.equal(summary.thisWeek.totalTokens, expectedThisWeek);
    assert.equal(summary.allTime.totalTokens, 1000, 'yesterday record is in all time');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. estimateCost
// ═══════════════════════════════════════════════════════════════════════════════

describe('estimateCost', () => {
  it('calculates cost for Claude Opus ($15/$75 per M)', () => {
    // 1M input + 1M output = $15 + $75 = $90
    const cost = estimateCost('claude-opus-4-8', 1_000_000, 1_000_000);
    assert.equal(cost, 90);
  });

  it('calculates cost for Claude Sonnet ($3/$15 per M)', () => {
    const cost = estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000);
    assert.equal(cost, 18);
  });

  it('calculates cost for Claude Haiku ($0.25/$1.25 per M)', () => {
    const cost = estimateCost('claude-haiku-4-5', 1_000_000, 1_000_000);
    assert.equal(cost, 1.5);
  });

  it('calculates cost for GPT-4o ($2.50/$10 per M)', () => {
    const cost = estimateCost('gpt-4o', 1_000_000, 1_000_000);
    assert.equal(cost, 12.5);
  });

  it('uses default pricing ($3/$15 per M) for unknown models', () => {
    const cost = estimateCost('unknown-model', 1_000_000, 1_000_000);
    assert.equal(cost, 18);
  });

  it('handles zero tokens gracefully', () => {
    const cost = estimateCost('claude-sonnet-4-6', 0, 0);
    assert.equal(cost, 0);
  });

  it('handles partial token counts (sub-million)', () => {
    // 1000 input + 500 output = (1000/1M)*3 + (500/1M)*15 = 0.003 + 0.0075 = 0.0105
    const cost = estimateCost('claude-sonnet-4-6', 1000, 500);
    // Use approximate comparison due to floating point arithmetic
    assert.ok(Math.abs(cost - 0.0105) < 0.0001, `expected ~0.0105, got ${cost}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. renderHorizontalBar
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderHorizontalBar', () => {
  it('returns a string with the label', () => {
    const result = renderHorizontalBar(50, 100, 10, 'Usage');
    assert.ok(result.includes('Usage'));
  });

  it('shows 100% when value equals max', () => {
    const result = renderHorizontalBar(100, 100, 10, 'Full');
    assert.ok(stripAnsi(result).includes('100%'));
  });

  it('shows 0% when value is 0', () => {
    const result = renderHorizontalBar(0, 100, 10, 'Empty');
    assert.ok(stripAnsi(result).includes('0%'));
  });

  it('contains block characters in the bar', () => {
    const result = renderHorizontalBar(75, 100, 10, 'Test');
    const plain = stripAnsi(result);
    // Should contain Unicode block characters or spaces for the bar
    assert.ok(/[█▉▊▋▌▍▎▏ ]/.test(plain));
  });

  it('handles max=0 gracefully (no division by zero)', () => {
    const result = renderHorizontalBar(0, 0, 10, 'Zero');
    assert.ok(stripAnsi(result).includes('0%'));
  });

  it('clamps value above max to 100%', () => {
    const result = renderHorizontalBar(200, 100, 10, 'Over');
    assert.ok(stripAnsi(result).includes('100%'));
  });

  it('respects width parameter', () => {
    const result = renderHorizontalBar(50, 100, 20, 'Wide');
    const plain = stripAnsi(result);
    // The bar portion should be roughly 20 chars of blocks/spaces
    // Label is padded to 10, so total should be > 10
    assert.ok(plain.length > 15);
  });

  it('renders NaN/negative values as 0%', () => {
    const result = renderHorizontalBar(-10, 100, 10, 'Neg');
    assert.ok(stripAnsi(result).includes('0%'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. renderSparkline
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderSparkline', () => {
  it('returns a non-empty string with braille characters for valid data', () => {
    const result = renderSparkline([100, 200, 300], 10);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
    const plain = stripAnsi(result);
    // Should contain braille characters
    assert.ok(/[⣀⣄⣤⣦⣶⣷⣿]/.test(plain));
  });

  it('returns empty string for empty values', () => {
    assert.equal(renderSparkline([], 10), '');
  });

  it('returns empty string for width <= 0', () => {
    assert.equal(renderSparkline([100], 0), '');
    assert.equal(renderSparkline([100], -1), '');
  });

  it('respects width by limiting columns to the most recent values', () => {
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    const result = renderSparkline(values, 5);
    const plain = stripAnsi(result);
    assert.equal(plain.length, 5, 'should have exactly 5 braille characters');
  });

  it('handles fewer values than width', () => {
    const result = renderSparkline([100, 200], 20);
    const plain = stripAnsi(result);
    assert.equal(plain.length, 2, 'should show exactly 2 braille characters');
  });

  it('handles single value', () => {
    const result = renderSparkline([5000], 10);
    assert.ok(result.length > 0);
    const plain = stripAnsi(result);
    assert.equal(plain.length, 1);
  });

  it('handles all-zero values gracefully', () => {
    const result = renderSparkline([0, 0, 0], 5);
    assert.ok(result.length > 0);
    // All zeros should map to the lowest braille character
    const plain = stripAnsi(result);
    assert.ok(plain.includes('⣀'));
  });

  it('produces monotonically increasing characters for increasing values', () => {
    const result = renderSparkline([1, 100, 10000], 10);
    const plain = stripAnsi(result);
    // The last character should be the highest braille char (⣿) since last value is max
    const lastChar = plain[plain.length - 1]!;
    assert.equal(lastChar, '⣿');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. renderUsageSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderUsageSummary', () => {
  function makeEmptySummary(): UsageSummary {
    return {
      today: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      thisWeek: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      thisMonth: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      allTime: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
    };
  }

  it('returns a multi-line string', () => {
    const result = renderUsageSummary(makeEmptySummary());
    const lines = result.split('\n');
    assert.ok(lines.length >= 5);
  });

  it('contains the header label', () => {
    const result = renderUsageSummary(makeEmptySummary());
    assert.ok(stripAnsi(result).includes('USAGE SUMMARY'));
  });

  it('contains box-drawing characters', () => {
    const result = renderUsageSummary(makeEmptySummary());
    assert.ok(result.includes('┌'));
    assert.ok(result.includes('┐'));
    assert.ok(result.includes('└'));
    assert.ok(result.includes('┘'));
    assert.ok(result.includes('│'));
  });

  it('contains all period labels', () => {
    const result = renderUsageSummary(makeEmptySummary());
    assert.ok(result.includes('Today'));
    assert.ok(result.includes('This Week'));
    assert.ok(result.includes('This Month'));
    assert.ok(result.includes('All Time'));
  });

  it('displays token counts from the summary data', () => {
    const summary: UsageSummary = {
      today: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500, cost: 0.015 },
      thisWeek: { promptTokens: 3000, completionTokens: 1500, totalTokens: 4500, cost: 0.045 },
      thisMonth: { promptTokens: 10000, completionTokens: 5000, totalTokens: 15000, cost: 0.15 },
      allTime: { promptTokens: 50000, completionTokens: 25000, totalTokens: 75000, cost: 0.75 },
    };
    const result = renderUsageSummary(summary);
    const plain = stripAnsi(result);
    // Each period row should show its token count (formatted with toFixed(0) for k/M)
    // 1500 → "2k" (rounded), 4500 → "5k", 15000 → "15k", 75000 → "75k"
    assert.ok(plain.includes('2k'), 'today should show 2k (1500 rounded)');
    assert.ok(plain.includes('5k'), 'this week should show 5k (4500 rounded)');
    assert.ok(plain.includes('15k'), 'this month should show 15k');
    assert.ok(plain.includes('75k'), 'all time should show 75k');
  });

  it('displays cost estimates', () => {
    const summary: UsageSummary = {
      today: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0.015 },
      thisWeek: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0.045 },
      thisMonth: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      allTime: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
    };
    const result = renderUsageSummary(summary);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('$0.0150'), 'today cost should appear');
    assert.ok(plain.includes('$0.0450'), 'this week cost should appear');
  });

  it('displays prompt/completion ratio', () => {
    const summary: UsageSummary = {
      today: { promptTokens: 750, completionTokens: 250, totalTokens: 1000, cost: 0 },
      thisWeek: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      thisMonth: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
      allTime: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 },
    };
    const result = renderUsageSummary(summary);
    const plain = stripAnsi(result);
    assert.ok(plain.includes('75/25'), 'should show 75/25 ratio');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. renderModelBreakdown
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderModelBreakdown', () => {
  it('returns empty string for empty map', () => {
    const result = renderModelBreakdown(new Map());
    assert.equal(result, '');
  });

  it('returns multi-line table for non-empty map', () => {
    const byModel = new Map<string, { promptTokens: number; completionTokens: number; totalTokens: number }>();
    byModel.set('claude-sonnet-4-6', { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });

    const result = renderModelBreakdown(byModel);
    const lines = result.split('\n');
    assert.ok(lines.length >= 5);
  });

  it('contains the header label', () => {
    const byModel = new Map<string, { promptTokens: number; completionTokens: number; totalTokens: number }>();
    byModel.set('test-model', { promptTokens: 100, completionTokens: 50, totalTokens: 150 });

    const result = renderModelBreakdown(byModel);
    assert.ok(stripAnsi(result).includes('TOKEN BREAKDOWN BY MODEL'));
  });

  it('contains box-drawing characters', () => {
    const byModel = new Map<string, { promptTokens: number; completionTokens: number; totalTokens: number }>();
    byModel.set('test', { promptTokens: 0, completionTokens: 0, totalTokens: 0 });

    const result = renderModelBreakdown(byModel);
    assert.ok(result.includes('┌'));
    assert.ok(result.includes('│'));
    assert.ok(result.includes('└'));
  });

  it('displays model names', () => {
    const byModel = new Map<string, { promptTokens: number; completionTokens: number; totalTokens: number }>();
    byModel.set('claude-sonnet-4-6', { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });

    const result = renderModelBreakdown(byModel);
    // Model name should be humanized
    assert.ok(stripAnsi(result).includes('Claude'));
  });

  it('sorts by total tokens descending', () => {
    const byModel = new Map<string, { promptTokens: number; completionTokens: number; totalTokens: number }>();
    byModel.set('model-a', { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    byModel.set('model-b', { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });

    const result = renderModelBreakdown(byModel);
    const plain = stripAnsi(result);
    // Model names are humanized: "model-a" → "Model A", "model-b" → "Model B"
    const modelAIdx = plain.indexOf('Model A');
    const modelBIdx = plain.indexOf('Model B');
    // model-b (1500 tokens) should appear before model-a (150 tokens)
    assert.ok(modelAIdx > modelBIdx, 'higher-token model should appear first');
  });

  it('handles single model entry', () => {
    const byModel = new Map<string, { promptTokens: number; completionTokens: number; totalTokens: number }>();
    byModel.set('claude-haiku-4-5', { promptTokens: 500, completionTokens: 200, totalTokens: 700 });

    const result = renderModelBreakdown(byModel);
    assert.ok(stripAnsi(result).includes('Haiku'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. renderDailyChart
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderDailyChart', () => {
  it('returns empty string for empty history', () => {
    const result = renderDailyChart([], 7);
    assert.equal(result, '');
  });

  it('returns multi-line output with dates and bars', () => {
    const history = [
      { date: 'Jul 01', totalTokens: 80000 },
      { date: 'Jun 30', totalTokens: 60000 },
      { date: 'Jun 29', totalTokens: 40000 },
    ];
    const result = renderDailyChart(history, 3);
    const lines = result.split('\n');
    assert.ok(lines.length >= 5);
  });

  it('contains the date labels', () => {
    const history = [
      { date: 'Jul 01', totalTokens: 50000 },
      { date: 'Jun 30', totalTokens: 30000 },
    ];
    const result = renderDailyChart(history, 2);
    assert.ok(result.includes('Jul 01'));
    assert.ok(result.includes('Jun 30'));
  });

  it('contains the trend sparkline label', () => {
    const history = [
      { date: 'Jul 01', totalTokens: 100 },
      { date: 'Jun 30', totalTokens: 200 },
    ];
    const result = renderDailyChart(history, 2);
    assert.ok(stripAnsi(result).includes('Trend'));
  });

  it('includes block characters in the bars', () => {
    const history = [
      { date: 'Jul 01', totalTokens: 50000 },
    ];
    const result = renderDailyChart(history, 1);
    assert.ok(/[█▉▊▋▌▍▎▏ ]/.test(stripAnsi(result)));
  });

  it('handles single day with zero tokens', () => {
    const history = [
      { date: 'Jul 01', totalTokens: 0 },
    ];
    const result = renderDailyChart(history, 1);
    assert.ok(result.includes('Jul 01'));
  });

  it('handles many days', () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      date: `Day ${(i + 1).toString().padStart(2, '0')}`,
      totalTokens: (i + 1) * 1000,
    }));
    const result = renderDailyChart(history, 30);
    const lines = result.split('\n');
    assert.ok(lines.length > 30);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. renderDistributionSegment
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderDistributionSegment', () => {
  it('returns a string with label and percentage', () => {
    const result = renderDistributionSegment(30, 100, 10, 'Test Label');
    assert.ok(result.includes('Test Label'));
    assert.ok(result.includes('30%'));
  });

  it('shows 0% for zero value', () => {
    const result = renderDistributionSegment(0, 100, 10, 'None');
    assert.ok(result.includes('0%'));
  });

  it('shows 100% when value equals total', () => {
    const result = renderDistributionSegment(100, 100, 10, 'All');
    assert.ok(result.includes('100%'));
  });

  it('contains block characters', () => {
    const result = renderDistributionSegment(50, 100, 10, 'Half');
    assert.ok(result.includes('█'));
  });

  it('handles total=0 gracefully', () => {
    const result = renderDistributionSegment(0, 0, 10, 'Zero');
    assert.ok(result.includes('0%'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Persistence — load and save
// ═══════════════════════════════════════════════════════════════════════════════

describe('persistence', () => {
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'babel-usage-charts-'));
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('save() writes records as JSON', async () => {
    const filePath = join(tempDir, 'usage-save.json');
    const tracker = new TokenUsageTracker(filePath);

    tracker.record(makeRecord({ model: 'claude-sonnet-4-6', promptTokens: 1000, totalTokens: 1500 }));
    tracker.record(makeRecord({ model: 'claude-opus-4-8', promptTokens: 2000, totalTokens: 3000 }));

    await tracker.save();

    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as TokenUsageRecord[];
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.promptTokens, 1000);
    assert.equal(parsed[1]!.promptTokens, 2000);
  });

  it('load() reads records from JSON', async () => {
    const filePath = join(tempDir, 'usage-load.json');
    const tracker = new TokenUsageTracker(filePath);

    tracker.record(makeRecord({ model: 'test-model', promptTokens: 500, totalTokens: 750 }));
    await tracker.save();

    const tracker2 = new TokenUsageTracker(filePath);
    await tracker2.load();

    const records = tracker2.getRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.promptTokens, 500);
    assert.equal(records[0]!.model, 'test-model');
  });

  it('load() handles missing file gracefully', async () => {
    const filePath = join(tempDir, 'nonexistent.json');
    const tracker = new TokenUsageTracker(filePath);
    await tracker.load();
    assert.equal(tracker.getRecords().length, 0);
  });

  it('load() handles corrupt JSON gracefully', async () => {
    const filePath = join(tempDir, 'corrupt.json');
    writeFileSync(filePath, '{corrupt json}', 'utf-8');

    const tracker = new TokenUsageTracker(filePath);
    await tracker.load();
    assert.equal(tracker.getRecords().length, 0);
  });

  it('load() handles empty file gracefully', async () => {
    const filePath = join(tempDir, 'empty.json');
    writeFileSync(filePath, '', 'utf-8');

    const tracker = new TokenUsageTracker(filePath);
    await tracker.load();
    assert.equal(tracker.getRecords().length, 0);
  });

  it('load() handles non-array JSON gracefully', async () => {
    const filePath = join(tempDir, 'non-array.json');
    writeFileSync(filePath, '{"some": "object"}', 'utf-8');

    const tracker = new TokenUsageTracker(filePath);
    await tracker.load();
    assert.equal(tracker.getRecords().length, 0);
  });

  it('save+load round-trip preserves all fields', async () => {
    const filePath = join(tempDir, 'roundtrip.json');
    const tracker = new TokenUsageTracker(filePath);

    const original: TokenUsageRecord = {
      timestamp: 1234567890000,
      sessionId: 'sess-42',
      model: 'claude-haiku-4-5',
      promptTokens: 333,
      completionTokens: 222,
      totalTokens: 555,
    };
    tracker.record(original);
    await tracker.save();

    const tracker2 = new TokenUsageTracker(filePath);
    await tracker2.load();
    const loaded = tracker2.getRecords()[0]!;

    assert.equal(loaded.timestamp, original.timestamp);
    assert.equal(loaded.sessionId, original.sessionId);
    assert.equal(loaded.model, original.model);
    assert.equal(loaded.promptTokens, original.promptTokens);
    assert.equal(loaded.completionTokens, original.completionTokens);
    assert.equal(loaded.totalTokens, original.totalTokens);
  });
});
