import assert from 'node:assert/strict';
import test from 'node:test';

import { TurnHistory } from './turnHistory.js';
import type { TurnRecord } from './turnHistory.js';
import type { ExecutorTurn, ToolCallLog } from '../schemas/agentContracts.js';

function makeToolCallTurn(turn: number, tool: string, target: string): TurnRecord {
  return {
    turn,
    startedAt: new Date().toISOString(),
    response: {
      type: 'tool_call',
      thinking: `thinking turn ${turn}`,
      tool,
      path: target,
    } as ExecutorTurn,
    toolResult: {
      step: turn,
      tool,
      target,
      exit_code: 0,
      stdout: 'output '.repeat(100),
      stderr: '',
      denial: undefined,
      mcp_lifecycle: undefined,
      checkpoint_ids: undefined,
      verified: true,
      status: undefined,
      fingerprint: undefined,
      retry_forbidden: false,
    } as ToolCallLog,
    promptTokens: 1000,
    completionTokens: 100,
  };
}

function makeCompletionTurn(turn: number): TurnRecord {
  return {
    turn,
    startedAt: new Date().toISOString(),
    response: {
      type: 'completion',
      status: 'EXECUTION_COMPLETE',
    } as ExecutorTurn,
    toolResult: null,
    promptTokens: 800,
    completionTokens: 50,
  };
}

// ── Construction & basic operations ────────────────────────────────

test('TurnHistory starts empty', () => {
  const h = new TurnHistory();
  assert.equal(h.count, 0);
  assert.equal(h.latest, undefined);
  assert.equal(h.totalToolCalls(), 0);
});

test('TurnHistory.append adds records', () => {
  const h = new TurnHistory();
  h.append(makeToolCallTurn(1, 'file_read', 'src/a.ts'));
  assert.equal(h.count, 1);
  assert.equal(h.latest?.turn, 1);
  assert.equal(h.totalToolCalls(), 1);
});

test('TurnHistory tracks tool call count correctly', () => {
  const h = new TurnHistory();
  h.append(makeToolCallTurn(1, 'file_read', 'a.ts'));
  h.append(makeCompletionTurn(2));
  h.append(makeToolCallTurn(3, 'file_write', 'b.ts'));
  assert.equal(h.totalToolCalls(), 2);
});

test('TurnHistory tracks token counts', () => {
  const h = new TurnHistory();
  h.append(makeToolCallTurn(1, 'file_read', 'a.ts'));
  h.append(makeToolCallTurn(2, 'file_write', 'b.ts'));
  assert.equal(h.totalPromptTokens(), 2000);
  assert.equal(h.totalCompletionTokens(), 200);
});

// ── summarizeLast ───────────────────────────────────────────────────

test('TurnHistory.summarizeLast adds summary to most recent turn', () => {
  const h = new TurnHistory();
  h.append(makeToolCallTurn(1, 'file_read', 'a.ts'));
  h.summarizeLast('pruned due to compaction');
  assert.equal(h.latest?.summary, 'pruned due to compaction');
});

// ── fullTurns / prunedTurns ─────────────────────────────────────────

test('TurnHistory.fullTurns excludes summarized turns', () => {
  const h = new TurnHistory();
  h.append(makeToolCallTurn(1, 'file_read', 'a.ts'));
  h.append(makeToolCallTurn(2, 'file_write', 'b.ts'));
  h.summarizeLast('compacted');
  assert.equal(h.fullTurns.length, 1);
  assert.equal(h.prunedTurns.length, 1);
});

// ── snapshot ────────────────────────────────────────────────────────

test('TurnHistory.snapshot returns immutable copy', () => {
  const h = new TurnHistory();
  h.append(makeToolCallTurn(1, 'file_read', 'a.ts'));
  const snap = h.snapshot();
  assert.equal(snap.totalTurns, 1);
  assert.equal(snap.totalToolCalls, 1);
  // Mutating snapshot should not affect source
  snap.turns.pop();
  assert.equal(h.count, 1);
});

// ── compaction ──────────────────────────────────────────────────────

test('TurnHistory.compact does nothing when below keepRecent threshold', () => {
  const h = new TurnHistory();
  for (let i = 1; i <= 3; i++) {
    h.append(makeToolCallTurn(i, 'file_read', `f${i}.ts`));
  }
  const compacted = h.compact({ keepRecent: 5 });
  assert.equal(compacted, 0);
  assert.equal(h.fullTurns.length, 3);
});

test('TurnHistory.compact summarizes old turns beyond keepRecent', () => {
  const h = new TurnHistory();
  for (let i = 1; i <= 10; i++) {
    h.append(makeToolCallTurn(i, 'file_read', `f${i}.ts`));
  }
  const compacted = h.compact({ keepRecent: 3, maxFullTurns: 5 });
  assert.ok(compacted > 0, 'should have compacted some turns');
  // Recent 3 turns (8, 9, 10) should remain full
  assert.ok(h.fullTurns.length >= 3, 'recent turns should stay uncompacted');
});

test('TurnHistory.compact respects maxFullTurns', () => {
  const h = new TurnHistory();
  for (let i = 1; i <= 30; i++) {
    h.append(makeToolCallTurn(i, 'file_read', `f${i}.ts`));
  }
  const compacted = h.compact({ keepRecent: 3, maxFullTurns: 10 });
  assert.ok(h.fullTurns.length <= 10 + 3, `expected <=13 full turns, got ${h.fullTurns.length}`);
  assert.ok(compacted > 0);
});

test('TurnHistory.compact on already-compacted turns is idempotent', () => {
  const h = new TurnHistory();
  for (let i = 1; i <= 8; i++) {
    h.append(makeToolCallTurn(i, 'file_read', `f${i}.ts`));
  }
  const first = h.compact({ keepRecent: 2 });
  const second = h.compact({ keepRecent: 2 });
  assert.equal(second, 0, 'second compact should do nothing');
});

test('TurnHistory.compact handles completion turns', () => {
  const h = new TurnHistory();
  for (let i = 1; i <= 6; i++) {
    h.append(makeToolCallTurn(i, 'file_read', `f${i}.ts`));
  }
  h.append(makeCompletionTurn(7));
  const compacted = h.compact({ keepRecent: 2, maxFullTurns: 3 });
  assert.ok(compacted > 0);
  // The completion turn should also be compactable
  const hasPrunedCompletion = h.prunedTurns.some((t) => t.response.type === 'completion');
  assert.ok(hasPrunedCompletion || h.fullTurns.some((t) => t.response.type === 'completion'));
});

// ── reset ───────────────────────────────────────────────────────────

test('TurnHistory.reset clears all turns', () => {
  const h = new TurnHistory();
  h.append(makeToolCallTurn(1, 'file_read', 'a.ts'));
  h.append(makeToolCallTurn(2, 'file_write', 'b.ts'));
  h.reset();
  assert.equal(h.count, 0);
  assert.equal(h.totalToolCalls(), 0);
});

// ── output trimming ─────────────────────────────────────────────────

test('TurnHistory compaction trims long stdout in summaries', () => {
  const h = new TurnHistory();
  const rec = makeToolCallTurn(1, 'shell_exec', 'test.sh');
  // Make stdout very long
  if (rec.toolResult) {
    rec.toolResult.stdout = 'x'.repeat(10000);
  }
  h.append(rec);
  // Force compaction by adding more recent turns
  for (let i = 2; i <= 8; i++) {
    h.append(makeToolCallTurn(i, 'file_read', `f${i}.ts`));
  }
  h.compact({ keepRecent: 2, maxFullTurns: 3, outputByteLimit: 100 });
  const pruned = h.prunedTurns;
  assert.ok(pruned.length > 0);
  const firstSummary = pruned[0]?.summary ?? '';
  assert.ok(firstSummary.includes('truncated'), 'summary should mention truncation');
  assert.ok(firstSummary.length < 5000, `summary too long: ${firstSummary.length} chars`);
});
