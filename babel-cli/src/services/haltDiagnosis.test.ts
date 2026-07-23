import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { diagnoseRun } from './haltDiagnosis.js';

test('halt diagnosis identifies command-denial executor halts', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-diagnosis-'));
  try {
    writeFileSync(
      join(runDir, '04_execution_report.json'),
      JSON.stringify({
        status: 'EXECUTION_HALTED',
        pipeline_error: { halt_tag: 'STEP_VERIFICATION_FAIL' },
        tool_call_log: [
          {
            denial: {
              reason_code: 'command_allowlist_rejected',
            },
          },
        ],
      }),
      'utf-8',
    );

    const diagnosis = diagnoseRun({
      runDir,
      pipelineStatus: 'EXECUTOR_HALTED',
    });

    assert.equal(diagnosis.status, 'executor_halted');
    assert.equal(diagnosis.halt_tag, 'STEP_VERIFICATION_FAIL');
    assert.deepEqual(diagnosis.denial_reason_codes, ['command_allowlist_rejected']);
    assert.equal(
      diagnosis.next_actions.some((action) => /profile-supported command/.test(action)),
      true,
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('halt diagnosis recognizes verification failures after complete', () => {
  const diagnosis = diagnoseRun({
    pipelineStatus: 'COMPLETE',
    verification: {
      schema_version: 1,
      status: 'fail',
      reason: 'local tests failed',
      required: true,
      verification: null,
    },
  });

  assert.equal(diagnosis.status, 'verification_failed');
  assert.match(diagnosis.headline, /verification failed/i);
});
