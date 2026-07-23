import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BlockedAttemptLedger } from './blockedAttemptLedger.js';
import type { BlockedAttempt } from './blockedAttemptLedger.js';

describe('BlockedAttemptLedger', () => {
  test('starts empty', () => {
    const ledger = new BlockedAttemptLedger();
    assert.equal(ledger.length, 0);
    assert.deepStrictEqual(ledger.all(), []);
    assert.deepStrictEqual(ledger.countsByReason(), { total: 0, byReason: {} });
    assert.equal(ledger.summaryForGate(), null);
    assert.deepStrictEqual(ledger.toJSON(), []);
    assert.deepStrictEqual(ledger.topReasons(), []);
  });

  test('records a single blocked attempt', () => {
    const ledger = new BlockedAttemptLedger();
    ledger.record({ turn: 0, tool: 'str_replace', target: 'src/foo.ts', reason: 'str_replace_miss' });
    assert.equal(ledger.length, 1);
    assert.deepStrictEqual(ledger.countsByReason(), {
      total: 1,
      byReason: { str_replace_miss: 1 },
    });
    assert.ok(ledger.summaryForGate()!.includes('str_replace_miss'));
  });

  test('records multiple attempts with different reasons', () => {
    const ledger = new BlockedAttemptLedger();
    ledger.record({ turn: 1, tool: 'write_file', target: 'src/a.ts', reason: 'phase-gate' });
    ledger.record({ turn: 1, tool: 'write_file', target: 'src/b.ts', reason: 'phase-gate' });
    ledger.record({ turn: 2, tool: 'str_replace', target: 'src/c.ts', reason: 'str_replace_miss' });
    ledger.record({ turn: 3, tool: 'run_command', target: 'npm test', reason: 'policy' });

    assert.equal(ledger.length, 4);
    const counts = ledger.countsByReason();
    assert.equal(counts.total, 4);
    assert.equal(counts.byReason['phase-gate'], 2);
    assert.equal(counts.byReason['str_replace_miss'], 1);
    assert.equal(counts.byReason['policy'], 1);
  });

  test('recordAll adds batch entries', () => {
    const ledger = new BlockedAttemptLedger();
    const batch: BlockedAttempt[] = [
      { turn: 0, tool: 'write_file', target: 'src/x.ts', reason: 'plan-gate' },
      { turn: 0, tool: 'str_replace', target: 'src/y.ts', reason: 'str_replace_miss' },
      { turn: 1, tool: 'apply_patch', target: 'src/z.ts', reason: 'policy' },
    ];
    ledger.recordAll(batch);
    assert.equal(ledger.length, 3);
  });

  test('topReasons returns sorted descending by count', () => {
    const ledger = new BlockedAttemptLedger();
    ledger.record({ turn: 0, tool: 'str_replace', target: 'a', reason: 'str_replace_miss' });
    ledger.record({ turn: 1, tool: 'str_replace', target: 'b', reason: 'str_replace_miss' });
    ledger.record({ turn: 1, tool: 'str_replace', target: 'c', reason: 'str_replace_miss' });
    ledger.record({ turn: 2, tool: 'write_file', target: 'd', reason: 'phase-gate' });
    ledger.record({ turn: 2, tool: 'write_file', target: 'e', reason: 'phase-gate' });
    ledger.record({ turn: 3, tool: 'run_command', target: 'f', reason: 'policy' });

    const top = ledger.topReasons(2);
    assert.equal(top.length, 2);
    assert.deepStrictEqual(top[0], { reason: 'str_replace_miss', count: 3 });
    assert.deepStrictEqual(top[1], { reason: 'phase-gate', count: 2 });
  });

  test('summaryForGate formats top reasons', () => {
    const ledger = new BlockedAttemptLedger();
    ledger.record({ turn: 0, tool: 'str_replace', target: 'f.ts', reason: 'phase-gate' });
    ledger.record({ turn: 0, tool: 'write_file', target: 'f.ts', reason: 'phase-gate' });
    ledger.record({ turn: 1, tool: 'str_replace', target: 'g.ts', reason: 'str_replace_miss' });

    const summary = ledger.summaryForGate()!;
    assert.ok(summary.includes('Blocked attempts:'));
    assert.ok(summary.includes('phase-gate'));
    assert.ok(summary.includes('str_replace_miss'));
  });

  test('toJSON returns a deep copy', () => {
    const ledger = new BlockedAttemptLedger();
    ledger.record({ turn: 0, tool: 'str_replace', target: 'a.ts', reason: 'str_replace_miss' });
    const json = ledger.toJSON();
    assert.equal(json.length, 1);
    // Mutation of returned array should not affect the ledger
    json.push({ turn: 1, tool: 'x', target: 'y', reason: 'other' });
    assert.equal(ledger.length, 1);
  });

  test('clear resets to empty', () => {
    const ledger = new BlockedAttemptLedger();
    ledger.record({ turn: 0, tool: 'str_replace', target: 'a.ts', reason: 'str_replace_miss' });
    ledger.record({ turn: 1, tool: 'write_file', target: 'b.ts', reason: 'phase-gate' });
    assert.equal(ledger.length, 2);

    ledger.clear();
    assert.equal(ledger.length, 0);
    assert.deepStrictEqual(ledger.countsByReason(), { total: 0, byReason: {} });
    assert.equal(ledger.summaryForGate(), null);
  });

  test('all reason codes', () => {
    const ledger = new BlockedAttemptLedger();
    const reasons: Array<BlockedAttempt['reason']> = [
      'phase-gate', 'plan-gate', 'policy', 'str_replace_miss', 'path', 'other',
    ];
    for (const reason of reasons) {
      ledger.record({ turn: 0, tool: 'test', target: 'x', reason });
    }
    assert.equal(ledger.length, 6);
    const counts = ledger.countsByReason();
    for (const reason of reasons) {
      assert.equal(counts.byReason[reason], 1, `expected 1 for ${reason}`);
    }
  });

  test('detail field is preserved in toJSON', () => {
    const ledger = new BlockedAttemptLedger();
    ledger.record({ turn: 0, tool: 'str_replace', target: 'f.ts', reason: 'str_replace_miss', detail: 'old_str not found' });
    const json = ledger.toJSON();
    assert.equal(json[0]!.detail, 'old_str not found');
  });
});
