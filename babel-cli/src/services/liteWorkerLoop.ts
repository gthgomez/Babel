import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentWorkerLoopStep } from '../agent/contracts.js';
import {
  readLiteTrustDemoFixture,
  resolveBabelCliEntry,
  resolveLiteTrustDemoFixturePath,
  runBabelCli,
} from './liteTrustDemo.js';

export interface LiteWorkerLoopStep {
  name: string;
  verb: string;
  status: 'pass' | 'fail';
  detail: string;
  execution_mode?: string;
  run_dir?: string | null;
}

export interface LiteWorkerLoopResult {
  fixture_type: 'babel_lite_worker_loop';
  status: 'pass' | 'fail';
  execution_mode: 'offline_demo' | 'live';
  steps: LiteWorkerLoopStep[];
  worker_steps: AgentWorkerLoopStep[];
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'babel-lite',
    GIT_AUTHOR_EMAIL: 'babel-lite@local',
    GIT_COMMITTER_NAME: 'babel-lite',
    GIT_COMMITTER_EMAIL: 'babel-lite@local',
  };
}

function initGitRepo(root: string): void {
  const init = spawnSync('git', ['init'], { cwd: root, encoding: 'utf-8' });
  if (init.status !== 0) {
    throw new Error(`git init failed: ${init.stderr || init.stdout || 'unknown error'}`);
  }
  const add = spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf-8', env: gitEnv() });
  if (add.status !== 0) {
    throw new Error(`git add failed: ${add.stderr || add.stdout || 'unknown error'}`);
  }
  const commit = spawnSync('git', ['commit', '-m', 'babel-lite-worker-loop'], {
    cwd: root,
    encoding: 'utf-8',
    env: gitEnv(),
  });
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout || 'unknown error'}`);
  }
}

function writeTrustDemoRepo(root: string, implementation: string, targetFile: string): void {
  const targetDir = join(root, targetFile.split('/').slice(0, -1).join('/'));
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node src/math.test.js' },
  }, null, 2), 'utf-8');
  writeFileSync(join(root, targetFile), implementation, 'utf-8');
  writeFileSync(join(root, 'src', 'math.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './math.js';",
    '',
    "test('add sums two numbers', () => {",
    '  assert.equal(add(1, 2), 3);',
    '});',
    '',
  ].join('\n'), 'utf-8');
  initGitRepo(root);
}

const WORKER_CHAIN_VERBS = ['plan', 'propose', 'fix', 'review', 'undo'] as const;

function stepFromCli(
  verb: string,
  exitCode: number,
  payload: Record<string, unknown> | null,
): AgentWorkerLoopStep {
  return {
    verb: verb as AgentWorkerLoopStep['verb'],
    status: typeof payload?.['status'] === 'string' ? payload['status'] : 'UNKNOWN',
    exit_code: exitCode,
    ...(typeof payload?.['execution_mode'] === 'string'
      ? { execution_mode: payload['execution_mode'] }
      : {}),
    run_dir: typeof payload?.['run_dir'] === 'string' ? payload['run_dir'] : null,
  };
}

export async function runLiteWorkerLoop(options: {
  projectRoot: string;
  task: string;
  fixturePath?: string;
  cliEntry?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LiteWorkerLoopResult> {
  const fixture = readLiteTrustDemoFixture(options.fixturePath);
  const steps: LiteWorkerLoopStep[] = [];
  const workerSteps: AgentWorkerLoopStep[] = [];
  let executionMode: 'offline_demo' | 'live' = 'offline_demo';
  const cliBase = {
    projectRoot: options.projectRoot,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
  };

  for (const verb of WORKER_CHAIN_VERBS) {
    const args = [
      'lite',
      verb,
      '--json',
      '--project-root',
      options.projectRoot,
      ...(verb === 'propose' || verb === 'fix' ? ['--provider', 'mock'] : []),
      ...(verb === 'review' || verb === 'undo' ? [] : [options.task]),
    ];
    const cli = runBabelCli(args, cliBase);
    const payload = cli.payload;
    workerSteps.push(stepFromCli(verb, cli.exitCode, payload));

    const status = typeof payload?.['status'] === 'string' ? payload['status'] : null;
    const stepExecutionMode = payload?.['execution_mode'];
    if (stepExecutionMode === 'offline_demo') {
      executionMode = 'offline_demo';
    } else if (stepExecutionMode !== undefined && executionMode !== 'offline_demo') {
      executionMode = 'live';
    }

    let passed = cli.exitCode === 0;
    let detail = `${verb} exit=${cli.exitCode}, status=${String(status)}`;

    if (verb === 'plan') {
      passed = passed && status === 'PLAN_READY';
      detail = passed ? 'Plan artifact ready.' : `Expected PLAN_READY; got ${String(status)}.`;
    } else if (verb === 'propose') {
      passed = passed && status === 'PROPOSAL_READY' && stepExecutionMode === 'offline_demo';
      detail = passed
        ? 'Proposal ready with offline_demo execution_mode.'
        : `Expected PROPOSAL_READY with execution_mode=offline_demo; got status=${String(status)}, execution_mode=${String(stepExecutionMode)}.`;
    } else if (verb === 'fix') {
      const checks = Array.isArray(payload?.['checks'])
        ? payload['checks'].filter((value): value is string => typeof value === 'string')
        : [];
      passed = passed &&
        status === 'FIX_COMPLETE' &&
        stepExecutionMode === 'offline_demo' &&
        checks.some(check => check === `${fixture.verifier_command}: passed`);
      detail = passed
        ? `${fixture.verifier_command} passed after mock-provider fix.`
        : `Expected FIX_COMPLETE with offline_demo and verifier pass; exit=${cli.exitCode}, status=${String(status)}.`;
    } else if (verb === 'review') {
      passed = passed && status === 'REVIEW_READY';
      detail = passed ? 'Review lane completed.' : `Expected REVIEW_READY; got ${String(status)}.`;
    } else if (verb === 'undo') {
      passed = passed && status === 'UNDO_COMPLETE';
      const targetPath = join(options.projectRoot, fixture.target_file);
      const restored = readFileSync(targetPath, 'utf8') === fixture.broken_implementation;
      passed = passed && restored;
      detail = passed
        ? 'Checkpoint restore returned UNDO_COMPLETE and source restored.'
        : `Undo failed or source not restored; exit=${cli.exitCode}, status=${String(status)}.`;
    }

    steps.push({
      name: `bl_${verb}`,
      verb,
      status: passed ? 'pass' : 'fail',
      detail,
      ...(typeof stepExecutionMode === 'string' ? { execution_mode: stepExecutionMode } : {}),
      run_dir: typeof payload?.['run_dir'] === 'string' ? payload['run_dir'] : null,
    });

    if (!passed) {
      return {
        fixture_type: 'babel_lite_worker_loop',
        status: 'fail',
        execution_mode: executionMode,
        steps,
        worker_steps: workerSteps,
      };
    }
  }

  return {
    fixture_type: 'babel_lite_worker_loop',
    status: 'pass',
    execution_mode: executionMode,
    steps,
    worker_steps: workerSteps,
  };
}

export async function runLiteWorkerLoopHarness(options: {
  fixturePath?: string;
  cliEntry?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<LiteWorkerLoopResult> {
  const fixturePath = options.fixturePath ?? resolveLiteTrustDemoFixturePath();
  const fixture = readLiteTrustDemoFixture(fixturePath);
  const root = mkdtempSync(join(tmpdir(), 'babel-lite-worker-loop-'));
  try {
    writeTrustDemoRepo(root, fixture.broken_implementation, fixture.target_file);
    return await runLiteWorkerLoop({
      projectRoot: root,
      task: fixture.task,
      fixturePath,
      ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export { resolveBabelCliEntry };
