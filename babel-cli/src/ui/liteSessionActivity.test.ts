import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  extractLiteSessionActivity,
  formatLiteRouteSummary,
  formatLiteSessionActivityHuman,
  formatSessionLoopStepLine,
  formatToolCallLine,
  formatWorkerChainStatusHuman,
  shouldPrintLiteSessionActivity,
} from './liteSessionActivity.js';
import type { WorkerChainManifest } from '../services/liteRecovery.js';

test('formatLiteRouteSummary combines lane and execution_path', () => {
  const summary = formatLiteRouteSummary({
    selected_lane: 'lite_plan',
    execution_path: 'session_loop',
  });
  assert.equal(summary, 'lane=lite_plan | execution_path=session_loop');
});

test('extractLiteSessionActivity loads tool_call_log from execution report', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-lite-activity-'));
  try {
    writeFileSync(
      join(runDir, '04_execution_report.json'),
      JSON.stringify({
        status: 'PLAN_READY',
        tool_call_log: [
          {
            step: 1,
            tool: 'grep',
            target: 'src',
            exit_code: 0,
            stdout: '',
            stderr: '',
            duration_ms: 1,
          },
        ],
      }),
      'utf-8',
    );

    const activity = extractLiteSessionActivity(
      {
        session_loop_steps: [
          { phase: 'observe', status: 'pass', policy_decision: 'allow' },
          { phase: 'act', status: 'pass', policy_decision: 'allow' },
        ],
      },
      runDir,
    );

    assert.equal(activity.sessionLoopSteps.length, 2);
    assert.equal(activity.toolCallLog.length, 1);
    assert.equal(formatToolCallLine(activity.toolCallLog[0]!), 'grep src → ok');
    assert.equal(formatSessionLoopStepLine(activity.sessionLoopSteps[1]!), 'act pass');
    assert.equal(shouldPrintLiteSessionActivity(activity), true);
    assert.match(formatLiteSessionActivityHuman(activity), /Session loop:/);
    assert.match(formatLiteSessionActivityHuman(activity), /Tools:/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('extractLiteSessionActivity falls back to session_loop debug artifact', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-lite-activity-loop-'));
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'plan_session_loop.json'),
      JSON.stringify({
        schema_version: 1,
        tool_call_log: [
          {
            step: 1,
            tool: 'file_read',
            target: 'README.md',
            exit_code: 0,
            stdout: 'ok',
            stderr: '',
            duration_ms: 2,
          },
        ],
      }),
      'utf-8',
    );

    const activity = extractLiteSessionActivity({}, runDir);
    assert.equal(activity.toolCallLog.length, 1);
    assert.match(formatToolCallLine(activity.toolCallLog[0]!), /file_read README\.md/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('formatWorkerChainStatusHuman renders manifest steps', () => {
  const manifest: WorkerChainManifest = {
    schema_version: 1,
    artifact_type: 'babel_lite_worker_chain',
    session_run_id: 'demo',
    session_run_dir: '/tmp/demo',
    task: 'Fix tests',
    project: null,
    project_root: '/tmp',
    chain_status: 'in_progress',
    steps: [
      {
        verb: 'plan',
        status: 'PLAN_READY',
        exit_code: 0,
        run_dir: '/tmp/demo/plan',
      },
    ],
    next_verb: 'propose',
    updated_at: '2026-06-11T12:00:00.000Z',
  };
  const human = formatWorkerChainStatusHuman(manifest);
  assert.match(human, /Status: in_progress/);
  assert.match(human, /Next verb: propose/);
  assert.match(human, /plan PLAN_READY/);
});
