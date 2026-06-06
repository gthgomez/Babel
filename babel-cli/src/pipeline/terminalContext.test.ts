import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectTerminalContext } from './terminalContext.js';

test('collectTerminalContext returns empty context when run artifacts are absent', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-terminal-context-'));
  try {
    const context = collectTerminalContext(runDir);

    assert.deepEqual(context.toolCallLog, []);
    assert.equal(context.condition, null);
    assert.equal(context.failureCapsulePath, null);
    assert.equal(context.attemptSafetySummaryPath, null);
    assert.equal(context.rollbackSummaryPath, null);
    assert.equal(context.worktreeSafetySummaryPath, null);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('collectTerminalContext reads terminal artifacts used by finalization', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-terminal-context-'));
  try {
    writeJson(runDir, '04_execution_report.json', {
      tool_call_log: [
        {
          tool: 'shell_exec',
          target: 'npm test',
          exit_code: 1,
          stdout: '',
          stderr: 'failed',
          verified: false,
        },
      ],
      pipeline_error: { condition: 'STEP_VERIFICATION_FAIL' },
    });
    writeJson(runDir, 'repair_attempt_timeline.json', {
      attempts: [
        { failure_capsule_path: '' },
        { failure_capsule_path: join(runDir, 'failure_capsule.json') },
      ],
    });
    writeJson(runDir, 'attempt_safety_summary.json', { rollback_mode: 'none' });
    writeJson(runDir, 'rollback_summary.json', { status: 'none' });
    writeJson(runDir, 'worktree_safety_summary.json', { target_dirty_conflicts: [] });

    const context = collectTerminalContext(runDir);

    assert.equal(context.toolCallLog.length, 1);
    assert.equal(context.condition, 'STEP_VERIFICATION_FAIL');
    assert.equal(context.failureCapsulePath, join(runDir, 'failure_capsule.json'));
    assert.equal(context.repairAttemptTimelinePath, join(runDir, 'repair_attempt_timeline.json'));
    assert.equal(context.attemptSafetySummaryPath, join(runDir, 'attempt_safety_summary.json'));
    assert.equal(context.rollbackSummaryPath, join(runDir, 'rollback_summary.json'));
    assert.equal(context.worktreeSafetySummaryPath, join(runDir, 'worktree_safety_summary.json'));
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

function writeJson(runDir: string, filename: string, value: unknown): void {
  writeFileSync(join(runDir, filename), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}
