/**
 * Policy event log unit tests.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PolicyEventLog, type PolicyEvent } from './policyEventLog.js';

describe('policyEventLog', () => {
  test('records events in order', () => {
    const log = new PolicyEventLog();
    log.record({ at_turn: 0, kind: 'force_mutate', detail: 'turns_without_write=3' });
    log.record({ at_turn: 1, kind: 'read_thrash_fuse', detail: 'consecutive_read_only=5' });
    log.record({ at_turn: 2, kind: 'zero_write_hard_stop', detail: 'turns=8' });

    assert.equal(log.length, 3);
    assert.deepEqual(log.all()[0]!, { at_turn: 0, kind: 'force_mutate', detail: 'turns_without_write=3' });
    assert.deepEqual(log.all()[1]!, { at_turn: 1, kind: 'read_thrash_fuse', detail: 'consecutive_read_only=5' });
    assert.deepEqual(log.all()[2]!, { at_turn: 2, kind: 'zero_write_hard_stop', detail: 'turns=8' });
  });

  test('recordAll adds multiple events', () => {
    const log = new PolicyEventLog();
    log.recordAll([
      { at_turn: 0, kind: 'force_mutate', detail: 'a' },
      { at_turn: 1, kind: 'read_thrash_fuse', detail: 'b' },
      { at_turn: 2, kind: 'restrict_tools', detail: 'mode=mutate_only' },
    ]);

    assert.equal(log.length, 3);
    assert.equal(log.all()[0]!.kind, 'force_mutate');
    assert.equal(log.all()[2]!.kind, 'restrict_tools');
  });

  test('last(n) returns correct slice', () => {
    const log = new PolicyEventLog();
    for (let i = 0; i < 10; i++) {
      log.record({ at_turn: i, kind: 'force_mutate', detail: `turn=${i}` });
    }

    const last3 = log.last(3);
    assert.equal(last3.length, 3);
    assert.equal(last3[0]!.at_turn, 7);
    assert.equal(last3[1]!.at_turn, 8);
    assert.equal(last3[2]!.at_turn, 9);
  });

  test('last(n) with n larger than log returns all events', () => {
    const log = new PolicyEventLog();
    log.record({ at_turn: 0, kind: 'force_mutate' });
    log.record({ at_turn: 1, kind: 'read_thrash_fuse' });

    const all = log.last(10);
    assert.equal(all.length, 2);
  });

  test('countsByKind returns correct aggregations', () => {
    const log = new PolicyEventLog();
    log.record({ at_turn: 0, kind: 'force_mutate' });
    log.record({ at_turn: 1, kind: 'force_mutate' });
    log.record({ at_turn: 2, kind: 'read_thrash_fuse' });
    log.record({ at_turn: 3, kind: 'zero_write_hard_stop' });
    log.record({ at_turn: 4, kind: 'read_thrash_fuse' });
    log.record({ at_turn: 5, kind: 'restrict_tools' });

    const counts = log.countsByKind();
    assert.equal(counts.total, 6);
    assert.equal(counts.byKind['force_mutate'], 2);
    assert.equal(counts.byKind['read_thrash_fuse'], 2);
    assert.equal(counts.byKind['zero_write_hard_stop'], 1);
    assert.equal(counts.byKind['restrict_tools'], 1);
    assert.equal(counts.byKind['stall_intervention'], undefined);
  });

  test('countsByKind returns zero for empty log', () => {
    const log = new PolicyEventLog();
    const counts = log.countsByKind();
    assert.equal(counts.total, 0);
    assert.deepEqual(counts.byKind, {});
  });

  test('toJSON returns a copy not a reference', () => {
    const log = new PolicyEventLog();
    log.record({ at_turn: 0, kind: 'force_mutate' });

    const json = log.toJSON();
    assert.equal(json.length, 1);
    json.push({ at_turn: 1, kind: 'budget_kill' });
    // Original should be unaffected
    assert.equal(log.length, 1);
  });

  test('toJSONL produces one JSON object per line', () => {
    const log = new PolicyEventLog();
    log.record({ at_turn: 0, kind: 'force_mutate', detail: 'a' });
    log.record({ at_turn: 1, kind: 'read_thrash_fuse', detail: 'b' });

    const lines = log.toJSONL().split('\n');
    assert.equal(lines.length, 3); // two events + trailing newline = 3 lines, last empty
    assert.equal(lines[2], '');
    const parsed0 = JSON.parse(lines[0]!);
    assert.equal(parsed0.at_turn, 0);
    assert.equal(parsed0.kind, 'force_mutate');
    const parsed1 = JSON.parse(lines[1]!);
    assert.equal(parsed1.at_turn, 1);
    assert.equal(parsed1.kind, 'read_thrash_fuse');
  });

  test('toJSONL returns empty string for empty log', () => {
    const log = new PolicyEventLog();
    assert.equal(log.toJSONL(), '');
  });

  test('clear empties the log', () => {
    const log = new PolicyEventLog();
    log.record({ at_turn: 0, kind: 'force_mutate' });
    log.record({ at_turn: 1, kind: 'read_thrash_fuse' });
    assert.equal(log.length, 2);

    log.clear();
    assert.equal(log.length, 0);
    assert.deepEqual(log.all(), []);
    assert.equal(log.toJSONL(), '');
  });

  test('events carry optional tool field', () => {
    const log = new PolicyEventLog();
    log.record({ at_turn: 3, kind: 'phase_gate_block', tool: 'run_command', detail: 'phase=investigate' });

    assert.equal(log.length, 1);
    assert.equal(log.all()[0]!.tool, 'run_command');
  });
});
