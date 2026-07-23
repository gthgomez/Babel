import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  defaultImplementorProveCells,
  evaluateProveSmokeCell,
  runImplementorProveSmokeSuite,
} from './implementorProveSmoke.js';

describe('W0.5 implementor prove smokes (offline)', () => {
  test('default suite has exactly 3 hard cells', () => {
    assert.equal(defaultImplementorProveCells().length, 3);
  });

  test('3/3 capped smokes reach mutation without false zero-write hard stop', () => {
    const report = runImplementorProveSmokeSuite();
    assert.equal(report.cells_total, 3);
    assert.equal(report.cells_passed, 3);
    assert.equal(report.pass, true);
    for (const cell of report.cells) {
      assert.equal(cell.pass, true, `${cell.id}: ${cell.fail_reasons.join('; ')}`);
      assert.ok(cell.write_count > 0, `${cell.id} write_count`);
      assert.equal(cell.zero_write_hard_stop, false, `${cell.id} hard stop`);
      assert.equal(cell.zero_write_threshold, 0);
    }
  });

  test('TTF-Write samples are finite and median is published', () => {
    const report = runImplementorProveSmokeSuite();
    assert.ok(report.ttf_write_median != null);
    assert.ok(Number.isFinite(report.ttf_write_median!));
    // H1: 1 tool before write, H2: 3, H3: 5 → median 3
    assert.equal(report.ttf_write_median, 3);
  });

  test('cell with only reads fails prove (mutation required)', () => {
    const r = evaluateProveSmokeCell({
      id: 'negative-no-write',
      description: 'explorer death',
      taskClass: 'general_swe',
      executeIntent: true,
      completedTurns: 20,
      toolCalls: [
        { tool: 'read_file', target: 'a.ts' },
        { tool: 'grep', target: 'x' },
      ],
    });
    assert.equal(r.pass, false);
    assert.ok(r.fail_reasons.some((f) => f.includes('write_count')));
  });
});
