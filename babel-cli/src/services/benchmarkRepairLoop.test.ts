import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  diffWorkspaceSnapshotsForRepairTest,
  restoreWorkspaceSnapshot,
  runBenchmarkRepairLoop,
  snapshotWorkspaceFilesForRepairTest,
} from './benchmarkRepairLoop.js';

test('benchmark repair loop dry-run prepares isolated workspace and replays checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-repair-loop-'));
  const benchmarksRoot = join(root, 'benchmarks');
  const taskDir = join(benchmarksRoot, 'terminal-bench-2', 'llm-inference-batching-scheduler');
  const runDir = join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-r1');
  const trialDir = join(runDir, '01-llm-inference-batching-scheduler');
  const appDir = join(trialDir, 'app');
  const babelRunDir = join(root, 'babel-run-llm-batching');
  const checkpointDir = join(babelRunDir, 'checkpoints', 'cp_after_plan_b1');
  const outputDir = join(root, 'repair-loops');
  mkdirSync(join(trialDir, 'logs', 'verifier'), { recursive: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(checkpointDir, { recursive: true });
  mkdirSync(join(taskDir, 'tests'), { recursive: true });
  mkdirSync(join(benchmarksRoot, 'scripts'), { recursive: true });

  writeFileSync(join(benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs'), '', 'utf8');
  writeFileSync(
    join(taskDir, 'task.toml'),
    'docker_image = "example/test-image:latest"\ncpus = 1\nmemory_mb = 512\n',
    'utf8',
  );
  writeFileSync(
    join(taskDir, 'instruction.md'),
    'Create /app/output_data/plan_b1.jsonl and /app/output_data/plan_b2.jsonl.',
    'utf8',
  );
  writeFileSync(join(appDir, 'solver.py'), 'after checkpoint\n', 'utf8');
  writeFileSync(
    join(trialDir, 'babel-task.md'),
    `Terminal-Bench 2 task: llm-inference-batching-scheduler\nTarget project root: ${appDir}\n`,
    'utf8',
  );

  writeFileSync(
    join(babelRunDir, 'checkpoints', 'checkpoints.json'),
    JSON.stringify({
      checkpoints: [{ id: 'cp_after_plan_b1', restore_status: 'available' }],
    }),
    'utf8',
  );
  writeFileSync(
    join(checkpointDir, 'metadata.json'),
    JSON.stringify({
      schema_version: 1,
      id: 'cp_after_plan_b1',
      run_id: 'babel-run-llm-batching',
      run_dir: babelRunDir,
      created_at: '2026-04-29T00:00:00.000Z',
      updated_at: '2026-04-29T00:00:00.000Z',
      tool: 'file_write',
      target: 'solver.py',
      project_root: appDir,
      shadow_root: null,
      dry_run: false,
      triggering_tool_call: {},
      restore_status: 'available',
      files: [
        {
          path: join(appDir, 'solver.py'),
          project_relative_path: 'solver.py',
          existed: true,
          size_bytes: 18,
          sha256: null,
          content_base64: Buffer.from('before checkpoint\n').toString('base64'),
        },
      ],
      post_states: [],
      notes: ['fixture checkpoint'],
    }),
    'utf8',
  );
  writeFileSync(
    join(babelRunDir, '04_execution_report.json'),
    JSON.stringify({
      tool_call_log: [
        {
          step: 1,
          tool: 'file_write',
          target: 'solver.py',
          exit_code: 0,
          checkpoint_ids: ['cp_after_plan_b1'],
          verified: true,
        },
        {
          step: 2,
          tool: 'shell_exec',
          target: 'pytest /tests',
          exit_code: 1,
          stdout: '1 passed, 2 failed',
          stderr: 'Missing required output file /output_data/plan_b2.jsonl',
        },
      ],
    }),
    'utf8',
  );
  writeFileSync(
    join(trialDir, 'logs', 'verifier', 'ctrf.json'),
    JSON.stringify({
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
    }),
    'utf8',
  );
  writeFileSync(
    join(trialDir, 'result.json'),
    JSON.stringify({
      task_name: 'llm-inference-batching-scheduler',
      trial_name: '01-llm-inference-batching-scheduler',
      trial_dir: trialDir,
      app_dir: appDir,
      docker_image: 'example/test-image:latest',
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
    }),
    'utf8',
  );
  writeFileSync(
    join(runDir, 'result.json'),
    JSON.stringify({
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
    }),
    'utf8',
  );

  const report = await runBenchmarkRepairLoop({
    run: runDir,
    benchmarksRoot,
    outputDir,
    dryRun: true,
    now: new Date('2026-04-29T00:00:00.000Z'),
  });

  assert.equal(report.status, 'planned');
  assert.equal(report.thresholds.max_iterations, 5);
  assert.equal(report.task_name, 'llm-inference-batching-scheduler');
  assert.equal(report.iterations.length, 1);
  const iteration = report.iterations[0]!;
  assert.equal(iteration.repair_execution.status, 'planned');
  assert.equal(iteration.verifier.status, 'planned');
  assert.equal(iteration.targeted_benchmark.status, 'planned');
  assert.deepEqual(iteration.changed_files, []);
  assert.deepEqual(iteration.snapshot.changed_files, []);
  assert.equal(iteration.snapshot.rollback.status, 'skipped');
  assert.equal(iteration.failure_capsule, null);
  assert.equal(iteration.checkpoint_replay?.status, 'restored');
  assert.ok(report.workspace_dir);
  assert.equal(
    readFileSync(join(report.workspace_dir, 'solver.py'), 'utf8'),
    'before checkpoint\n',
  );
  assert.equal(readFileSync(join(appDir, 'solver.py'), 'utf8'), 'after checkpoint\n');
  assert.match(readFileSync(iteration.prompt_path ?? '', 'utf8'), /REPAIR MODE/);
  assert.match(iteration.verifier.command ?? '', /docker run/);
  assert.match(iteration.targeted_benchmark.command ?? '', /run_babel_terminal_bench_pilot\.mjs/);
  assert.equal(existsSync(report.artifact_path), true);
});

test('repair workspace snapshot rollback removes failed pollution and restores changed files', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-repair-snapshot-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'math.js'), 'export const value = 1;\n', 'utf8');

  const before = snapshotWorkspaceFilesForRepairTest(root);
  writeFileSync(join(root, 'src', 'math.js'), 'export const value = 2;\n', 'utf8');
  writeFileSync(join(root, 'src', 'pollution.js'), 'failed attempt\n', 'utf8');
  const after = snapshotWorkspaceFilesForRepairTest(root);

  assert.deepEqual(diffWorkspaceSnapshotsForRepairTest(before, after), [
    'src/math.js',
    'src/pollution.js',
  ]);

  const rollback = restoreWorkspaceSnapshot(root, before, after);

  assert.equal(rollback.status, 'rolled_back');
  assert.deepEqual(rollback.files_restored, ['src/math.js']);
  assert.deepEqual(rollback.files_removed, ['src/pollution.js']);
  assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf8'), 'export const value = 1;\n');
  assert.equal(existsSync(join(root, 'src', 'pollution.js')), false);

  const cleanRetryBase = snapshotWorkspaceFilesForRepairTest(root);
  writeFileSync(join(root, 'src', 'math.js'), 'export const value = 3;\n', 'utf8');
  const cleanRetryAfter = snapshotWorkspaceFilesForRepairTest(root);

  assert.deepEqual(diffWorkspaceSnapshotsForRepairTest(cleanRetryBase, cleanRetryAfter), [
    'src/math.js',
  ]);
  assert.equal(existsSync(join(root, 'src', 'pollution.js')), false);
});
