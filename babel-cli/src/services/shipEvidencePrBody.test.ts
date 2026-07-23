import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  buildEvidencePrBody,
  loadImplementorShipEvidenceFromRunDir,
  mergeShipEvidenceSources,
} from './shipEvidencePrBody.js';

describe('shipEvidencePrBody (W3.1)', () => {
  test('buildEvidencePrBody includes task, writes, verification, test plan', () => {
    const body = buildEvidencePrBody({
      task: 'Fix parser off-by-one',
      write_count: 2,
      tools_before_first_write: 3,
      changed_files: ['src/parser.ts'],
      verification: [{ command: 'npm test', status: 'passed', exit_code: 0 }],
      phase_gate_write_block_count: 0,
      status: 'ANSWER_READY',
    });
    assert.ok(body.includes('Fix parser off-by-one'));
    assert.ok(body.includes('src/parser.ts'));
    assert.ok(body.includes('npm test'));
    assert.ok(body.includes('Test plan'));
    assert.ok(body.includes('Babel implementor'));
  });

  test('loadImplementorShipEvidenceFromRunDir reads harness fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-ev-pr-'));
    writeFileSync(
      join(dir, 'harness.json'),
      JSON.stringify({
        status: 'ANSWER_READY',
        write_count: 1,
        env_blocked: false,
        phase_gate_write_block_count: 2,
        changed_files: ['src/a.ts'],
        task: 'edit a',
      }),
      'utf8',
    );
    const ev = loadImplementorShipEvidenceFromRunDir(dir);
    assert.equal(ev.write_count, 1);
    assert.equal(ev.phase_gate_write_block_count, 2);
    assert.deepEqual(ev.changed_files, ['src/a.ts']);
    assert.equal(ev.task, 'edit a');
  });

  test('mergeShipEvidenceSources unions files and notes', () => {
    const merged = mergeShipEvidenceSources({
      runEvidence: { write_count: 1, changed_files: ['a.ts'] },
      changedFiles: ['b.ts'],
      prSummary: ['summary line'],
      verification: [{ command: 't', status: 'passed' }],
    });
    assert.ok(merged.changed_files?.includes('a.ts'));
    assert.ok(merged.changed_files?.includes('b.ts'));
    assert.equal(merged.verification?.length, 1);
    assert.ok(merged.notes?.some((n) => n.includes('summary line')));
  });
});
