import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildBenchmarkImprovementLoopReport } from './benchmarkImprovementLoop.js';

test('benchmark loop gate requests a full pilot when no broad baseline exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-loop-'));
  const benchmarksRoot = join(root, 'benchmarks');
  mkdirSync(join(benchmarksRoot, 'scripts'), { recursive: true });
  writeFileSync(join(benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs'), '', 'utf8');

  const report = buildBenchmarkImprovementLoopReport({
    babelRoot: root,
    benchmarksRoot,
    outputDir: join(root, 'reports'),
    runLocalChecks: false,
    now: new Date('2026-04-29T00:00:00.000Z'),
  });

  assert.equal(report.local_readiness.status, 'pass');
  assert.equal(report.next_action.kind, 'run_full_benchmark');
  assert.match(report.next_action.command ?? '', /--max-tasks 10/);
});

test('benchmark loop gate selects a failed task for targeted canary before another full pilot', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-loop-'));
  const benchmarksRoot = join(root, 'benchmarks');
  mkdirSync(join(benchmarksRoot, 'scripts'), { recursive: true });
  mkdirSync(join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-r40'), { recursive: true });
  writeFileSync(join(benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs'), '', 'utf8');
  writeFileSync(
    join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-r40', 'result.json'),
    JSON.stringify({
      suite: 'pilot10',
      summary: {
        trials: 10,
        passed: 1,
        failed: 9,
        mean_reward: 0.1,
        babel_completed: 2,
      },
      results: [
        { task: 'gpt2-codegolf', passed: false, reward: 0 },
        { task: 'log-summary-date-ranges', passed: true, reward: 1 },
      ],
    }),
    'utf8',
  );

  const report = buildBenchmarkImprovementLoopReport({
    babelRoot: root,
    benchmarksRoot,
    outputDir: join(root, 'reports'),
    runLocalChecks: false,
    now: new Date('2026-04-29T00:00:00.000Z'),
  });

  assert.equal(report.terminal_bench.selected_task, 'gpt2-codegolf');
  assert.equal(report.next_action.kind, 'run_targeted_benchmark');
  assert.match(report.commands.targeted_benchmark ?? '', /--tasks gpt2-codegolf/);
  assert.match(report.commands.targeted_benchmark ?? '', /--deepinfra-timeout-ms 240000/);
  assert.match(report.commands.targeted_benchmark ?? '', /--waterfall-timeout-ms 720000/);
  assert.match(report.commands.full_benchmark, /--deepinfra-timeout-ms 240000/);
  assert.match(report.commands.full_benchmark, /--waterfall-timeout-ms 720000/);
});

test('benchmark loop gate escalates to full pilot after selected targeted canary passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-loop-'));
  const benchmarksRoot = join(root, 'benchmarks');
  mkdirSync(join(benchmarksRoot, 'scripts'), { recursive: true });
  mkdirSync(join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-r40'), { recursive: true });
  mkdirSync(join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-r41'), { recursive: true });
  writeFileSync(join(benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs'), '', 'utf8');
  writeFileSync(
    join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-r40', 'result.json'),
    JSON.stringify({
      suite: 'pilot10',
      summary: { trials: 10, passed: 1, failed: 9, mean_reward: 0.1, babel_completed: 1 },
      trials: [
        { task: 'gpt2-codegolf', passed: false, reward: 0 },
        { task: 'log-summary-date-ranges', passed: true, reward: 1 },
      ],
    }),
    'utf8',
  );
  writeFileSync(
    join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-r41', 'result.json'),
    JSON.stringify({
      suite: 'pilot10',
      summary: { trials: 1, passed: 1, failed: 0, mean_reward: 1, babel_completed: 1 },
      trials: [{ task: 'gpt2-codegolf', passed: true, reward: 1 }],
    }),
    'utf8',
  );

  const report = buildBenchmarkImprovementLoopReport({
    babelRoot: root,
    benchmarksRoot,
    outputDir: join(root, 'reports'),
    runLocalChecks: false,
    now: new Date('2026-04-29T00:00:00.000Z'),
  });

  assert.equal(report.next_action.kind, 'run_full_benchmark');
  assert.match(report.next_action.command ?? '', /--max-tasks 10/);
});

test('benchmark loop gate ignores stale targeted pass after a newer failed full pilot', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-loop-'));
  const benchmarksRoot = join(root, 'benchmarks');
  mkdirSync(join(benchmarksRoot, 'scripts'), { recursive: true });
  mkdirSync(join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-targeted-old'), {
    recursive: true,
  });
  mkdirSync(join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-full-new'), { recursive: true });
  writeFileSync(join(benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs'), '', 'utf8');
  writeFileSync(
    join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-targeted-old', 'result.json'),
    JSON.stringify({
      suite: 'pilot10',
      finished_at: '2026-04-29T01:00:00.000Z',
      summary: { trials: 1, passed: 1, failed: 0, mean_reward: 1, babel_completed: 1 },
      trials: [{ task: 'log-summary-date-ranges', passed: true, reward: 1 }],
    }),
    'utf8',
  );
  writeFileSync(
    join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-full-new', 'result.json'),
    JSON.stringify({
      suite: 'pilot10',
      finished_at: '2026-04-29T02:00:00.000Z',
      summary: { trials: 10, passed: 1, failed: 9, mean_reward: 0.1, babel_completed: 1 },
      trials: [
        { task: 'gpt2-codegolf', passed: false, reward: 0 },
        { task: 'log-summary-date-ranges', passed: true, reward: 1 },
      ],
    }),
    'utf8',
  );

  const report = buildBenchmarkImprovementLoopReport({
    babelRoot: root,
    benchmarksRoot,
    outputDir: join(root, 'reports'),
    runLocalChecks: false,
    now: new Date('2026-04-29T03:00:00.000Z'),
  });

  assert.equal(report.terminal_bench.selected_task, 'gpt2-codegolf');
  assert.equal(report.next_action.kind, 'run_targeted_benchmark');
  assert.match(report.commands.targeted_benchmark ?? '', /--tasks gpt2-codegolf/);
});

test('benchmark loop gate rotates away from repeated failed targeted canaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-loop-'));
  const benchmarksRoot = join(root, 'benchmarks');
  mkdirSync(join(benchmarksRoot, 'scripts'), { recursive: true });
  mkdirSync(join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-r40'), { recursive: true });
  mkdirSync(join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-r41'), { recursive: true });
  writeFileSync(join(benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs'), '', 'utf8');
  writeFileSync(
    join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-r40', 'result.json'),
    JSON.stringify({
      suite: 'pilot10',
      summary: { trials: 10, passed: 0, failed: 10, mean_reward: 0, babel_completed: 0 },
      trials: [
        { task: 'gpt2-codegolf', passed: false, reward: 0 },
        { task: 'llm-inference-batching-scheduler', passed: false, reward: 0 },
        { task: 'write-compressor', passed: false, reward: 0 },
      ],
    }),
    'utf8',
  );
  writeFileSync(
    join(benchmarksRoot, 'runs', 'terminal-bench-2', 'job-r41', 'result.json'),
    JSON.stringify({
      suite: 'pilot10',
      summary: { trials: 1, passed: 0, failed: 1, mean_reward: 0, babel_completed: 0 },
      trials: [{ task: 'gpt2-codegolf', passed: false, reward: 0 }],
    }),
    'utf8',
  );

  const report = buildBenchmarkImprovementLoopReport({
    babelRoot: root,
    benchmarksRoot,
    outputDir: join(root, 'reports'),
    runLocalChecks: false,
    now: new Date('2026-04-29T00:00:00.000Z'),
  });

  assert.equal(report.terminal_bench.selected_task, 'llm-inference-batching-scheduler');
  assert.match(
    report.commands.targeted_benchmark ?? '',
    /--tasks llm-inference-batching-scheduler/,
  );
});

test('benchmark loop supports fast readiness profile and persistent loop state', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-loop-'));
  const benchmarksRoot = join(root, 'benchmarks');
  const outputDir = join(root, 'reports');
  mkdirSync(join(benchmarksRoot, 'scripts'), { recursive: true });
  writeFileSync(join(benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs'), '', 'utf8');

  const report = buildBenchmarkImprovementLoopReport({
    babelRoot: root,
    benchmarksRoot,
    outputDir,
    readinessProfile: 'fast',
    runLocalChecks: false,
    now: new Date('2026-04-29T00:00:00.000Z'),
  });

  assert.equal(report.thresholds.readiness_profile, 'fast');
  assert.deepEqual(
    report.local_readiness.checks.map((check) => check.id),
    ['source_typecheck', 'unit_tests', 'build'],
  );
  assert.equal(report.loop_state.iteration, 1);
  assert.match(report.loop_state.state_path, /loop-state\.json$/);
  assert.match(report.loop_state.event_log_path, /loop-events\.jsonl$/);
});

test('benchmark loop refuses new benchmark work when deadline budget is exhausted', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-loop-'));
  const benchmarksRoot = join(root, 'benchmarks');
  mkdirSync(join(benchmarksRoot, 'scripts'), { recursive: true });
  writeFileSync(join(benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs'), '', 'utf8');

  const report = buildBenchmarkImprovementLoopReport({
    babelRoot: root,
    benchmarksRoot,
    outputDir: join(root, 'reports'),
    runLocalChecks: false,
    deadlineAt: '2026-04-29T00:00:10.000Z',
    minRemainingMs: 60_000,
    now: new Date('2026-04-29T00:00:00.000Z'),
  });

  assert.equal(report.next_action.kind, 'wait_for_budget');
  assert.equal(report.readiness_gate.status, 'fail');
});
