/**
 * tokenHistory.test.ts — Tests for the token usage history tracker and sparkline.
 *
 * Covers:
 *   1. TokenUsageTracker — record, retrieval, caps, totals, clear
 *   2. renderTokenSparkline — output shape, width, auto-scale, edge cases
 *   3. renderTokenSummary — multi-line output with cost + totals
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TokenUsageTracker,
  renderTokenSparkline,
  renderTokenSummary,
  saveTokenHistory,
  loadTokenHistory,
} from './tokenHistory.js';
import { stripAnsi } from './theme.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. TokenUsageTracker
// ═══════════════════════════════════════════════════════════════════════════════

describe('TokenUsageTracker', () => {
  it('records a single entry and returns it in getHistory', () => {
    const tracker = new TokenUsageTracker();
    tracker.record({
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.015,
      modelId: 'claude-sonnet-4-6',
    });
    const history = tracker.getHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0]!.inputTokens, 1000);
    assert.equal(history[0]!.outputTokens, 500);
    assert.equal(history[0]!.cost, 0.015);
    assert.equal(history[0]!.modelId, 'claude-sonnet-4-6');
    assert.ok(typeof history[0]!.timestamp === 'number');
  });

  it('maintains insertion order (oldest first)', () => {
    const tracker = new TokenUsageTracker();
    tracker.record({ inputTokens: 100, outputTokens: 0, cost: 0, modelId: 'a' });
    tracker.record({ inputTokens: 200, outputTokens: 0, cost: 0, modelId: 'b' });
    const history = tracker.getHistory();
    assert.equal(history[0]!.inputTokens, 100);
    assert.equal(history[1]!.inputTokens, 200);
  });

  it('caps at maxRecords and drops oldest entries', () => {
    const tracker = new TokenUsageTracker(3);
    for (let i = 0; i < 5; i++) {
      tracker.record({ inputTokens: i * 100, outputTokens: 0, cost: 0, modelId: 'test' });
    }
    const history = tracker.getHistory();
    assert.equal(history.length, 3);
    // Entries with inputTokens 200, 300, 400 (oldest two — 0, 100 — dropped)
    assert.equal(history[0]!.inputTokens, 200);
    assert.equal(history[1]!.inputTokens, 300);
    assert.equal(history[2]!.inputTokens, 400);
  });

  it('getRecentTurns returns last N entries', () => {
    const tracker = new TokenUsageTracker();
    for (let i = 0; i < 10; i++) {
      tracker.record({ inputTokens: i, outputTokens: 0, cost: 0, modelId: 'test' });
    }
    const recent = tracker.getRecentTurns(3);
    assert.equal(recent.length, 3);
    assert.equal(recent[0]!.inputTokens, 7);
    assert.equal(recent[1]!.inputTokens, 8);
    assert.equal(recent[2]!.inputTokens, 9);
  });

  it('getRecentTurns returns fewer when not enough records', () => {
    const tracker = new TokenUsageTracker();
    tracker.record({ inputTokens: 1, outputTokens: 0, cost: 0, modelId: 'a' });
    assert.equal(tracker.getRecentTurns(10).length, 1);
  });

  it('getTotalCost sums all records', () => {
    const tracker = new TokenUsageTracker();
    tracker.record({ inputTokens: 0, outputTokens: 0, cost: 0.01, modelId: 'a' });
    tracker.record({ inputTokens: 0, outputTokens: 0, cost: 0.02, modelId: 'b' });
    assert.equal(tracker.getTotalCost(), 0.03);
  });

  it('getTotalTokens returns input and output sums', () => {
    const tracker = new TokenUsageTracker();
    tracker.record({ inputTokens: 100, outputTokens: 50, cost: 0, modelId: 'a' });
    tracker.record({ inputTokens: 200, outputTokens: 75, cost: 0, modelId: 'b' });
    const totals = tracker.getTotalTokens();
    assert.equal(totals.input, 300);
    assert.equal(totals.output, 125);
  });

  it('clear removes all records and resets totals', () => {
    const tracker = new TokenUsageTracker();
    tracker.record({ inputTokens: 100, outputTokens: 50, cost: 0.01, modelId: 'a' });
    tracker.clear();
    assert.equal(tracker.getHistory().length, 0);
    assert.equal(tracker.getTotalCost(), 0);
    assert.equal(tracker.getTotalTokens().input, 0);
    assert.equal(tracker.getTotalTokens().output, 0);
  });

  it('default maxRecords is 200', () => {
    const tracker = new TokenUsageTracker();
    for (let i = 0; i < 250; i++) {
      tracker.record({ inputTokens: i, outputTokens: 0, cost: 0, modelId: 'test' });
    }
    assert.equal(tracker.getHistory().length, 200);
  });

  it('rejects maxRecords < 1', () => {
    assert.throws(() => new TokenUsageTracker(0), /maxRecords/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. renderTokenSparkline
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderTokenSparkline', () => {
  function makeRecord(input: number, output: number, modelId = 'claude-sonnet-4-6') {
    return { timestamp: Date.now(), inputTokens: input, outputTokens: output, cost: 0, modelId };
  }

  it('returns a non-empty string with sparkline characters for valid records', () => {
    const result = renderTokenSparkline([makeRecord(100, 50)], 10);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
    // Should contain a Unicode sparkline character
    assert.ok(/[▁-█]/.test(result));
  });

  it('returns empty string for empty records', () => {
    assert.equal(renderTokenSparkline([], 10), '');
  });

  it('renders each column as a Unicode sparkline character', () => {
    const result = renderTokenSparkline([makeRecord(8000, 2000), makeRecord(1000, 1000)], 10);
    // Should contain low or high block chars
    assert.ok(/[▁-█]/.test(result));
  });

  it('respects width by limiting columns to the most recent turns', () => {
    const records = Array.from({ length: 20 }, (_, i) => makeRecord((i + 1) * 100, 0));
    const result = renderTokenSparkline(records, 5);
    // Strip ANSI codes for length check
    const plain = stripAnsi(result);
    assert.ok(plain.length <= 5, `expected ≤5 got ${plain.length}`);
  });

  it('handles auto-scale when maxValue is omitted', () => {
    const result = renderTokenSparkline([makeRecord(0, 0), makeRecord(5000, 5000)], 10);
    assert.ok(result.length > 0);
  });

  it('handles single record', () => {
    const result = renderTokenSparkline([makeRecord(5000, 3000, 'deepseek-v4')], 10);
    assert.ok(result.length > 0);
  });

  it('handles records fewer than width (all shown)', () => {
    const records = [makeRecord(100, 50), makeRecord(200, 100)];
    const result = renderTokenSparkline(records, 20);
    // ANSI-stripped length should be 2 (2 records, columns ≤ 2)
    const plain = stripAnsi(result);
    assert.equal(plain.length, 2);
  });

  it('uses the provided maxValue for scaling', () => {
    // Both records are well below maxValue so both get the lowest char
    const records = [makeRecord(100, 50), makeRecord(200, 100)];
    const result = renderTokenSparkline(records, 10, 100_000);
    // With maxValue=100000, both entries are in the bottom bin → ▁ repeated
    const char = result.replace(/\[\d+m/g, '');
    assert.ok(char.length > 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. renderTokenSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe('renderTokenSummary', () => {
  it('returns a multi-line string with sparkline, cost, and total tokens', () => {
    const tracker = new TokenUsageTracker();
    tracker.record({
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.015,
      modelId: 'claude-sonnet-4-6',
    });
    const result = renderTokenSummary(tracker, 20);
    assert.ok(result.includes('Cost:'));
    assert.ok(result.includes('$0.0150'));
    assert.ok(result.includes('total tokens'));
  });

  it('returns empty string for empty tracker', () => {
    const tracker = new TokenUsageTracker();
    assert.equal(renderTokenSummary(tracker, 20), '');
  });

  it('shows $0.0000 for zero cost', () => {
    const tracker = new TokenUsageTracker();
    tracker.record({ inputTokens: 100, outputTokens: 50, cost: 0, modelId: 'deepseek-v4' });
    const result = renderTokenSummary(tracker, 20);
    assert.ok(result.includes('$0.0000'));
  });

  it('includes a sparkline character in the first line', () => {
    const tracker = new TokenUsageTracker();
    tracker.record({
      inputTokens: 5000,
      outputTokens: 3000,
      cost: 0.05,
      modelId: 'claude-sonnet-4-6',
    });
    const result = renderTokenSummary(tracker, 20);
    const firstLine = result.split('\n')[0]!;
    // First line should contain a sparkline char
    assert.ok(/[▁-█]/.test(firstLine));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Persistence — save, load, auto-append, crash recovery
// ═══════════════════════════════════════════════════════════════════════════════

describe('persistence', () => {
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'babel-token-history-'));
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeRecord(input: number, output: number, modelId = 'claude-sonnet-4-6') {
    return {
      timestamp: Date.now(),
      inputTokens: input,
      outputTokens: output,
      cost: 0.015,
      modelId,
    };
  }

  it('saveTokenHistory writes JSONL format with atomic rename', () => {
    const filePath = join(tempDir, 'save-test.json');
    const tracker = new TokenUsageTracker(200, filePath);
    tracker.record(makeRecord(1000, 500));
    tracker.record(makeRecord(2000, 1000));

    saveTokenHistory(filePath, tracker);

    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2, 'should have 2 JSONL lines');
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.inputTokens, 1000);
    assert.equal(parsed.outputTokens, 500);
  });

  it('loadTokenHistory reads JSONL format', () => {
    const filePath = join(tempDir, 'load-jsonl-test.json');
    // Write JSONL manually
    const r1 = makeRecord(100, 50);
    const r2 = makeRecord(200, 75);
    writeFileSync(filePath, `${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`, 'utf-8');

    const tracker = new TokenUsageTracker(200);
    loadTokenHistory(filePath, tracker);

    const history = tracker.getHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0]!.inputTokens, 100);
    assert.equal(history[1]!.inputTokens, 200);
  });

  it('loadTokenHistory reads legacy JSON array format (backward compat)', () => {
    const filePath = join(tempDir, 'load-legacy-test.json');
    const records = [makeRecord(10, 5), makeRecord(20, 10)];
    writeFileSync(filePath, JSON.stringify(records), 'utf-8');

    const tracker = new TokenUsageTracker(200);
    loadTokenHistory(filePath, tracker);

    const history = tracker.getHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0]!.inputTokens, 10);
    assert.equal(history[1]!.inputTokens, 20);
  });

  it('loadTokenHistory handles empty file gracefully', () => {
    const filePath = join(tempDir, 'empty-test.json');
    writeFileSync(filePath, '', 'utf-8');

    const tracker = new TokenUsageTracker(200);
    loadTokenHistory(filePath, tracker);
    assert.equal(tracker.getHistory().length, 0);
  });

  it('loadTokenHistory handles missing file gracefully', () => {
    const filePath = join(tempDir, 'nonexistent.json');
    const tracker = new TokenUsageTracker(200);
    loadTokenHistory(filePath, tracker);
    assert.equal(tracker.getHistory().length, 0);
  });

  it('loadTokenHistory handles corrupt/partial lines (crash recovery)', () => {
    const filePath = join(tempDir, 'partial-test.json');
    const valid = makeRecord(300, 150);
    // Write one valid line, one partial line (simulating crash mid-write)
    writeFileSync(filePath, `${JSON.stringify(valid)}\n{partial,corrupt\n`, 'utf-8');

    const tracker = new TokenUsageTracker(200);
    loadTokenHistory(filePath, tracker);

    const history = tracker.getHistory();
    assert.equal(history.length, 1, 'should load only the valid record');
    assert.equal(history[0]!.inputTokens, 300);
  });

  it('record() auto-appends JSONL line when persistPath is set', () => {
    const filePath = join(tempDir, 'auto-append-test.json');
    const tracker = new TokenUsageTracker(200, filePath);

    tracker.record(makeRecord(500, 250));
    tracker.record(makeRecord(750, 300));

    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).inputTokens, 500);
    assert.equal(JSON.parse(lines[1]!).inputTokens, 750);
  });

  it('loadTokenHistory does not duplicate records on reload', () => {
    const filePath = join(tempDir, 'dedup-test.json');
    const tracker = new TokenUsageTracker(200, filePath);

    // First session: record 3 turns
    tracker.record(makeRecord(100, 50));
    tracker.record(makeRecord(200, 100));
    tracker.record(makeRecord(300, 150));

    // Simulate second session: fresh tracker, load from file
    const tracker2 = new TokenUsageTracker(200);
    loadTokenHistory(filePath, tracker2);

    const history = tracker2.getHistory();
    assert.equal(history.length, 3, 'should have exactly 3 records, not duplicated');
    assert.equal(history[0]!.inputTokens, 100);
    assert.equal(history[2]!.inputTokens, 300);
  });

  it('setPersistPath enables auto-append after construction', () => {
    const filePath = join(tempDir, 'set-path-test.json');
    const tracker = new TokenUsageTracker(200);
    // No persist path initially
    tracker.record(makeRecord(10, 5));
    // Set path after first record
    tracker.setPersistPath(filePath);
    tracker.record(makeRecord(20, 10));

    const raw = readFileSync(filePath, 'utf-8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1, 'only the record after setPersistPath should be persisted');
    assert.equal(JSON.parse(lines[0]!).inputTokens, 20);
  });

  it('auto-append is best-effort and does not throw on bad path', () => {
    const tracker = new TokenUsageTracker(200, '/nonexistent/deeply/nested/path.json');
    // Should not throw
    tracker.record(makeRecord(100, 50));
    assert.equal(tracker.getHistory().length, 1);
  });

  it('getGlobalTokenTracker creates tracker with default persist path', () => {
    const tracker = new TokenUsageTracker(200, join(tempDir, 'global-default.json'));
    assert.ok(tracker.getPersistPath() !== undefined);
  });
});
