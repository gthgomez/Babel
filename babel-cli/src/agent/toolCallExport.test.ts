import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  computeToolCallAggregates,
  enrichToolCallLog,
  exportEnrichedToolCallLog,
} from './toolCallExport.js';

void describe('computeToolCallAggregates', () => {
  void it('returns zeros for an empty log', () => {
    const result = computeToolCallAggregates([]);
    assert.deepEqual(result, {
      tool_call_count: 0,
      write_count: 0,
      verifier_attempt_count: 0,
    });
  });

  void it('counts write tools without error as writes', () => {
    const log: Array<{ tool: string; error?: string }> = [
      { tool: 'read_file' },
      { tool: 'write_file' },
      { tool: 'grep' },
    ];
    const result = computeToolCallAggregates(log);
    assert.equal(result.tool_call_count, 3);
    assert.equal(result.write_count, 1);  // write_file
    assert.equal(result.verifier_attempt_count, 0);
  });

  void it('does not count errored writes', () => {
    const log: Array<{ tool: string; error?: string }> = [
      { tool: 'write_file', error: 'blocked' },
      { tool: 'str_replace', error: 'old_str not found' },
      { tool: 'apply_patch', error: 'patch_failed' },
    ];
    const result = computeToolCallAggregates(log);
    assert.equal(result.tool_call_count, 3);
    assert.equal(result.write_count, 0);  // all have errors
    assert.equal(result.verifier_attempt_count, 0);
  });

  void it('counts verifier tools', () => {
    const log: Array<{ tool: string; error?: string }> = [
      { tool: 'test_run' },
      { tool: 'run_command' },
      { tool: 'shell_exec' },
      { tool: 'read_file' },
    ];
    const result = computeToolCallAggregates(log);
    assert.equal(result.tool_call_count, 4);
    assert.equal(result.write_count, 0);
    assert.equal(result.verifier_attempt_count, 3);
  });

  void it('counts str_replace as a write tool', () => {
    const log: Array<{ tool: string; error?: string }> = [
      { tool: 'str_replace' },
      { tool: 'file_delete' },
    ];
    const result = computeToolCallAggregates(log);
    assert.equal(result.write_count, 2);
  });

  void it('computes all counts together in mixed log', () => {
    const log: Array<{ tool: string; error?: string }> = [
      { tool: 'read_file' },
      { tool: 'write_file' },
      { tool: 'run_command' },
      { tool: 'grep' },
      { tool: 'test_run' },
    ];
    const result = computeToolCallAggregates(log);
    assert.equal(result.tool_call_count, 5);
    assert.equal(result.write_count, 1);
    assert.equal(result.verifier_attempt_count, 2);
  });
});

void describe('enrichToolCallLog', () => {
  const rawLog: Array<{
    tool: string; target: string; detail?: string; error?: string;
    index: number; exit_code?: number; stdout?: string; stderr?: string; verified?: boolean;
  }> = [
    { tool: 'read_file', target: 'src/a.ts', index: 0, exit_code: 0 },
    { tool: 'write_file', target: 'src/b.ts', index: 1, exit_code: 0, detail: 'wrote 20 lines' },
    { tool: 'run_command', target: 'npm test', index: 2, exit_code: 1, error: 'tests failed' },
  ];

  void it('maps turn numbers correctly', () => {
    const turnMap = new Map<number, number>([
      [0, 1],
      [1, 2],
      [2, 2],
    ]);
    const result = enrichToolCallLog(rawLog, turnMap);
    assert.equal(result[0]!.turn, 1);
    assert.equal(result[1]!.turn, 2);
    assert.equal(result[2]!.turn, 2);
  });

  void it('defaults missing turn to 0', () => {
    const turnMap = new Map<number, number>([[0, 1]]);  // index 1 and 2 missing
    const result = enrichToolCallLog(rawLog, turnMap);
    assert.equal(result[0]!.turn, 1);
    assert.equal(result[1]!.turn, 0);
    assert.equal(result[2]!.turn, 0);
  });

  void it('includes optional detail, error, exit_code when present', () => {
    const turnMap = new Map<number, number>();
    const result = enrichToolCallLog(rawLog, turnMap);
    // Entry 0: no detail/error, but has exit_code
    assert.equal(result[0]!.detail, undefined);
    assert.equal(result[0]!.error, undefined);
    assert.equal(result[0]!.exit_code, 0);
    // Entry 1: has detail
    assert.equal(result[1]!.detail, 'wrote 20 lines');
    // Entry 2: has error
    assert.equal(result[2]!.error, 'tests failed');
    assert.equal(result[2]!.exit_code, 1);
  });

  void it('includes duration_ms when durationMap has the index', () => {
    const turnMap = new Map<number, number>();
    const durationMap = new Map<number, number>([
      [0, 120],
      [2, 3500],
    ]);
    const result = enrichToolCallLog(rawLog, turnMap, durationMap);
    assert.equal(result[0]!.duration_ms, 120);
    assert.equal(result[1]!.duration_ms, undefined);
    assert.equal(result[2]!.duration_ms, 3500);
  });

  void it('returns empty array for empty input', () => {
    const result = enrichToolCallLog([], new Map());
    assert.deepEqual(result, []);
  });

  void it('handles optional fields omitted in raw log', () => {
    const minimalLog: Array<{
      tool: string; target: string; index: number;
    }> = [
      { tool: 'read_file', target: 'x.ts', index: 0 },
    ];
    const turnMap = new Map<number, number>([[0, 1]]);
    const result = enrichToolCallLog(minimalLog, turnMap);
    assert.equal(result[0]!.index, 0);
    assert.equal(result[0]!.turn, 1);
    assert.equal(result[0]!.tool, 'read_file');
    assert.equal(result[0]!.target, 'x.ts');
    // Optional fields should not be present when undefined
    assert.equal('detail' in result[0]!, false);
    assert.equal('error' in result[0]!, false);
    assert.equal('exit_code' in result[0]!, false);
    assert.equal('duration_ms' in result[0]!, false);
  });
});

void describe('exportEnrichedToolCallLog', () => {
  void it('is an alias for enrichToolCallLog with the same signature', () => {
    const rawLog: Array<{
      tool: string; target: string; index: number; exit_code?: number;
    }> = [
      { tool: 'write_file', target: 'x.ts', index: 0, exit_code: 0 },
    ];
    const turnMap = new Map<number, number>([[0, 1]]);
    const enriched = enrichToolCallLog(rawLog, turnMap);
    const exported = exportEnrichedToolCallLog(rawLog, turnMap);
    assert.deepEqual(exported, enriched);
  });
});
