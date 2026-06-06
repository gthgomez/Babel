import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildBenchmarkRepairReport } from './benchmarkRepair.js';

test('benchmark repair report turns a failed run into a focused repair prompt', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-repair-'));
  const benchmarksRoot = join(root, 'benchmarks');
  const runDir = join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-r1');
  const trialDir = join(runDir, '01-llm-inference-batching-scheduler');
  const babelRunDir = join(root, 'babel-run-llm-batching');
  const outputDir = join(root, 'reports');
  mkdirSync(join(trialDir, 'logs', 'verifier'), { recursive: true });
  mkdirSync(join(babelRunDir, 'checkpoints'), { recursive: true });
  mkdirSync(join(benchmarksRoot, 'scripts'), { recursive: true });
  writeFileSync(join(benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs'), '', 'utf8');
  writeFileSync(join(babelRunDir, 'checkpoints', 'checkpoints.json'), JSON.stringify({
    checkpoints: [
      { id: 'cp_after_plan_b1', restore_status: 'available' },
    ],
  }), 'utf8');
  writeFileSync(join(babelRunDir, '04_execution_report.json'), JSON.stringify({
    tool_call_log: [
      { step: 1, tool: 'file_write', target: '/output_data/plan_b1.jsonl', exit_code: 0, checkpoint_ids: ['cp_after_plan_b1'], verified: true },
      { step: 2, tool: 'shell_exec', target: 'pytest /tests', exit_code: 1, stdout: '1 passed, 2 failed', stderr: 'Missing required output file /output_data/plan_b2.jsonl' },
    ],
  }), 'utf8');
  writeFileSync(join(trialDir, 'logs', 'verifier', 'ctrf.json'), JSON.stringify({
    results: {
      tests: [
        { name: 'test_plan_b1_schema', status: 'passed' },
        {
          name: 'test_plan_b2_exists',
          status: 'failed',
          message: 'Missing required output file /output_data/plan_b2.jsonl',
          trace: 'FileNotFoundError: /output_data/plan_b2.jsonl does not exist',
        },
        {
          name: 'test_request_coverage',
          status: 'failed',
          message: 'request_id coverage is incomplete',
        },
      ],
    },
  }), 'utf8');
  writeFileSync(join(trialDir, 'result.json'), JSON.stringify({
    task_name: 'llm-inference-batching-scheduler',
    trial_name: '01-llm-inference-batching-scheduler',
    trial_dir: trialDir,
    babel: {
      status: 'complete',
      exit_code: 0,
      result_status: 'COMPLETE',
      run_dir: babelRunDir,
    },
    verifier: {
      status: 1,
      exit_code: 1,
      reward: 0,
      passed: false,
    },
  }), 'utf8');
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({
    suite: 'pilot10',
    job_name: 'job-r1',
    summary: { trials: 1, passed: 0, failed: 1, mean_reward: 0, babel_completed: 1 },
    results: [
      {
        task_name: 'llm-inference-batching-scheduler',
        trial_name: '01-llm-inference-batching-scheduler',
        trial_dir: trialDir,
        reward: 0,
        passed: false,
        babel_status: 'complete',
        babel_result_status: 'COMPLETE',
        babel_run_dir: babelRunDir,
        verifier_status: 1,
      },
    ],
  }), 'utf8');

  const report = buildBenchmarkRepairReport({
    run: runDir,
    benchmarksRoot,
    outputDir,
    now: new Date('2026-04-29T00:00:00.000Z'),
  });

  assert.equal(report.task_name, 'llm-inference-batching-scheduler');
  assert.equal(report.failure_class, 'false_complete');
  assert.equal(report.partial_pass?.passed, 1);
  assert.equal(report.best_candidate_checkpoint, 'cp_after_plan_b1');
  assert.deepEqual(report.repair_strategy.target_artifacts, ['/output_data/plan_b1.jsonl', '/output_data/plan_b2.jsonl']);
  assert.match(report.repair_prompt, /Do not restart from scratch/);
  assert.match(report.repair_prompt, /plan_b1\.jsonl/);
  assert.match(report.repair_prompt, /reads them at runtime/);
  assert.match(report.commands.restore_checkpoint ?? '', /checkpoint restore cp_after_plan_b1/);
  assert.match(report.commands.targeted_benchmark ?? '', /--tasks llm-inference-batching-scheduler/);
  assert.equal(existsSync(report.artifacts.report_path), true);
  assert.equal(existsSync(report.artifacts.prompt_path), true);
});
