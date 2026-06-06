import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { analyzeTerminalBenchRun } from './benchmarkAnalysis.js';

test('benchmark analyzer classifies false complete and emits a work packet', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-analysis-'));
  const runDir = join(root, 'job-r1');
  const trialDir = join(runDir, '01-gpt2-codegolf');
  mkdirSync(join(trialDir, 'logs', 'verifier'), { recursive: true });
  writeFileSync(join(trialDir, 'babel-stdout.txt'), 'done', 'utf8');
  writeFileSync(join(trialDir, 'babel-stderr.txt'), '', 'utf8');
  writeFileSync(join(trialDir, 'result.json'), JSON.stringify({
    task_name: 'gpt2-codegolf',
    trial_name: '01-gpt2-codegolf',
    trial_dir: trialDir,
    babel: {
      status: 'complete',
      exit_code: 0,
      result_status: 'COMPLETE',
      timed_out: false,
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
    summary: {
      trials: 1,
      passed: 0,
      failed: 1,
      mean_reward: 0,
      babel_completed: 1,
    },
    results: [
      {
        task_name: 'gpt2-codegolf',
        trial_name: '01-gpt2-codegolf',
        trial_dir: trialDir,
        reward: 0,
        passed: false,
        babel_status: 'complete',
        babel_result_status: 'COMPLETE',
        verifier_status: 1,
      },
    ],
  }), 'utf8');

  const analysis = analyzeTerminalBenchRun({
    run: runDir,
    now: new Date('2026-04-29T00:00:00.000Z'),
  });

  assert.equal(analysis.summary.false_completes, 1);
  assert.equal(analysis.selected_failure?.failure_class, 'false_complete');
  assert.equal(analysis.work_packet.focus_task, 'gpt2-codegolf');
  assert.match(analysis.work_packet.headline, /Fix gpt2-codegolf/);
  assert.ok(analysis.work_packet.evidence_paths.some((path) => path.endsWith('babel-stdout.txt')));
});

test('benchmark analyzer marks interrupted runs non-countable', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-analysis-'));
  const runDir = join(root, 'job-r2');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({
    suite: 'pilot10',
    job_name: 'job-r2',
    countable: false,
    interrupted: true,
    summary: {
      trials: 0,
      passed: 0,
      failed: 0,
      mean_reward: 0,
    },
    results: [],
  }), 'utf8');

  const analysis = analyzeTerminalBenchRun({ run: runDir });

  assert.equal(analysis.countable, false);
  assert.equal(analysis.interrupted, true);
  assert.equal(analysis.failure_counts.interrupted, 1);
  assert.equal(analysis.work_packet.focus_task, null);
  assert.equal(analysis.work_packet.likely_owner, 'Loop budget / deadline controller');
});

test('benchmark analyzer surfaces risk labels and repair fingerprints', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-analysis-'));
  const runDir = join(root, 'job-r3');
  const trialDir = join(runDir, '01-largest-eigenval');
  const babelRunDir = join(root, 'babel-run-largest');
  mkdirSync(join(trialDir, 'logs', 'verifier'), { recursive: true });
  mkdirSync(babelRunDir, { recursive: true });
  writeFileSync(join(babelRunDir, '09_executor_gate_trace.json'), JSON.stringify({
    repair_state: {
      status: 'strategy_exhausted',
      max_failures: 3,
      failure_count: 4,
      last_fingerprint: {
        command: 'python eval.py',
        exitCode: 1,
        testId: 'test_outputs.py::test_speedup[10]',
        stderrSummary: '0.009 seconds/call > 0.000044 seconds/call',
      },
      failures: [
        { repeatedCount: 1 },
        { repeatedCount: 2 },
      ],
    },
  }), 'utf8');
  writeFileSync(join(trialDir, 'result.json'), JSON.stringify({
    task_name: 'largest-eigenval',
    trial_name: '01-largest-eigenval',
    trial_dir: trialDir,
    babel: {
      status: 'failed',
      exit_code: 1,
      result_status: 'EXECUTOR_HALTED',
      run_dir: babelRunDir,
    },
    verifier: {
      status: 0,
      exit_code: 0,
      reward: 0,
      passed: false,
    },
  }), 'utf8');
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({
    suite: 'pilot10',
    job_name: 'job-r3',
    summary: {
      trials: 1,
      passed: 0,
      failed: 1,
      mean_reward: 0,
    },
    results: [
      {
        task_name: 'largest-eigenval',
        trial_name: '01-largest-eigenval',
        trial_dir: trialDir,
        reward: 0,
        passed: false,
        babel_status: 'failed',
        babel_result_status: 'EXECUTOR_HALTED',
        babel_run_dir: babelRunDir,
        verifier_status: 0,
      },
    ],
  }), 'utf8');

  const analysis = analyzeTerminalBenchRun({ run: runDir });

  assert.equal(analysis.selected_failure?.risk_labels.includes('numerical_performance'), true);
  assert.match(analysis.work_packet.failure_fingerprint ?? '', /test_speedup/);
  assert.equal(analysis.work_packet.likely_owner, 'Babel executor repair convergence');
  assert.match(analysis.work_packet.notes.join('\n'), /Repeated recoverable failure fingerprint/);
});

test('benchmark analyzer ranks best candidate by visible verifier progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-analysis-'));
  const runDir = join(root, 'job-r4');
  const trialDir = join(runDir, '01-largest-eigenval');
  const babelRunDir = join(root, 'babel-run-largest');
  mkdirSync(join(trialDir, 'logs', 'verifier'), { recursive: true });
  mkdirSync(join(babelRunDir, 'checkpoints'), { recursive: true });
  writeFileSync(join(babelRunDir, 'checkpoints', 'checkpoints.json'), JSON.stringify({
    checkpoints: [
      { id: 'cp_low', restore_status: 'available', tool: 'file_write', target: 'eigen.py' },
      { id: 'cp_high', restore_status: 'available', tool: 'file_write', target: 'eigen.py' },
      { id: 'cp_regressed', restore_status: 'available', tool: 'file_write', target: 'eigen.py' },
    ],
  }), 'utf8');
  writeFileSync(join(babelRunDir, '04_execution_report.json'), JSON.stringify({
    tool_call_log: [
      { step: 1, tool: 'file_write', target: 'eigen.py', exit_code: 0, checkpoint_ids: ['cp_low'], verified: true },
      { step: 2, tool: 'shell_exec', target: 'python eval.py', exit_code: 1, stdout: '1 passed, 1 failed', stderr: 'AssertionError' },
      { step: 3, tool: 'file_write', target: 'eigen.py', exit_code: 0, checkpoint_ids: ['cp_high'], verified: true },
      { step: 4, tool: 'shell_exec', target: 'python eval.py', exit_code: 1, stdout: '3 passed, 1 failed', stderr: 'AssertionError' },
      { step: 5, tool: 'file_write', target: 'eigen.py', exit_code: 0, checkpoint_ids: ['cp_regressed'], verified: true },
      { step: 6, tool: 'shell_exec', target: 'python eval.py', exit_code: 1, stdout: '2 passed, 2 failed', stderr: 'AssertionError' },
    ],
  }), 'utf8');
  writeFileSync(join(trialDir, 'result.json'), JSON.stringify({
    task_name: 'largest-eigenval',
    trial_name: '01-largest-eigenval',
    trial_dir: trialDir,
    babel: {
      status: 'failed',
      exit_code: 1,
      result_status: 'EXECUTOR_HALTED',
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
    job_name: 'job-r4',
    summary: { trials: 1, passed: 0, failed: 1, mean_reward: 0 },
    results: [
      {
        task_name: 'largest-eigenval',
        trial_name: '01-largest-eigenval',
        trial_dir: trialDir,
        reward: 0,
        passed: false,
        babel_status: 'failed',
        babel_result_status: 'EXECUTOR_HALTED',
        babel_run_dir: babelRunDir,
        verifier_status: 1,
      },
    ],
  }), 'utf8');

  const analysis = analyzeTerminalBenchRun({ run: runDir });

  assert.equal(analysis.work_packet.best_candidate_checkpoint, 'cp_high');
  assert.equal(analysis.work_packet.best_candidate?.passed_tests, 3);
  assert.match(analysis.work_packet.best_candidate?.reason ?? '', /3\/4 visible checks passed/);
  assert.match(analysis.work_packet.notes.join('\n'), /restore cp_high first/);
});

test('benchmark analyzer includes stdout usage messages in repair fingerprints', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-analysis-'));
  const runDir = join(root, 'job-r5');
  const trialDir = join(runDir, '01-llm-inference-batching-scheduler');
  const babelRunDir = join(root, 'babel-run-llm-batching');
  mkdirSync(join(trialDir, 'logs', 'verifier'), { recursive: true });
  mkdirSync(babelRunDir, { recursive: true });
  writeFileSync(join(babelRunDir, '09_executor_gate_trace.json'), JSON.stringify({
    repair_state: {
      status: 'strategy_exhausted',
      max_failures: 3,
      failure_count: 4,
      last_fingerprint: {
        command: 'python task_file/scripts/optimized_packer.py',
        exitCode: 1,
        stderrSummary: '',
        stdoutSummary: 'Usage: python optimized_packer.py <input_file> <output_file>',
        testId: null,
      },
      failures: [
        { repeatedCount: 4 },
      ],
    },
  }), 'utf8');
  writeFileSync(join(trialDir, 'result.json'), JSON.stringify({
    task_name: 'llm-inference-batching-scheduler',
    trial_name: '01-llm-inference-batching-scheduler',
    trial_dir: trialDir,
    babel: {
      status: 'failed',
      exit_code: 1,
      result_status: 'EXECUTOR_HALTED',
      run_dir: babelRunDir,
    },
    verifier: {
      status: 0,
      exit_code: 0,
      reward: 0,
      passed: false,
    },
  }), 'utf8');
  writeFileSync(join(runDir, 'result.json'), JSON.stringify({
    suite: 'pilot10',
    job_name: 'job-r5',
    summary: { trials: 1, passed: 0, failed: 1, mean_reward: 0 },
    results: [
      {
        task_name: 'llm-inference-batching-scheduler',
        trial_name: '01-llm-inference-batching-scheduler',
        trial_dir: trialDir,
        reward: 0,
        passed: false,
        babel_status: 'failed',
        babel_result_status: 'EXECUTOR_HALTED',
        babel_run_dir: babelRunDir,
        verifier_status: 0,
      },
    ],
  }), 'utf8');

  const analysis = analyzeTerminalBenchRun({ run: runDir });

  assert.match(analysis.work_packet.failure_fingerprint ?? '', /stdout=Usage: python optimized_packer/);
  assert.equal(analysis.work_packet.likely_owner, 'Babel executor repair convergence');
  assert.ok(analysis.work_packet.risk_labels.includes('artifact_generation'));
});

test('benchmark analyzer extracts partial verifier progress from CTRF', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-analysis-'));
  const runDir = join(root, 'job-r6');
  const trialDir = join(runDir, '01-llm-inference-batching-scheduler');
  mkdirSync(join(trialDir, 'logs', 'verifier'), { recursive: true });
  writeFileSync(join(trialDir, 'logs', 'verifier', 'ctrf.json'), JSON.stringify({
    results: {
      tests: [
        { name: 'test_schema_plan_b1', status: 'passed' },
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
    job_name: 'job-r6',
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
        verifier_status: 1,
      },
    ],
  }), 'utf8');

  const analysis = analyzeTerminalBenchRun({ run: runDir });

  assert.equal(analysis.selected_failure?.partial_pass?.passed, 1);
  assert.equal(analysis.selected_failure?.partial_pass?.failed, 2);
  assert.equal(analysis.selected_failure?.partial_pass?.blocking_category, 'coverage');
  assert.equal(analysis.selected_failure?.partial_pass?.failure_categories.missing_output_artifact, 1);
  assert.match(analysis.work_packet.notes.join('\n'), /Partial verifier pass: 1\/3/);
  assert.equal(analysis.work_packet.partial_pass?.failed_tests[0]?.name, 'test_plan_b2_exists');
});
