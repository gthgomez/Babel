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
import { WORKER_CHAIN_VERBS } from './liteRecovery.js';

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
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        type: 'module',
        scripts: { test: 'node src/math.test.js' },
      },
      null,
      2,
    ),
    'utf-8',
  );
  writeFileSync(join(root, targetFile), implementation, 'utf-8');
  writeFileSync(
    join(root, 'src', 'math.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from './math.js';",
      '',
      "test('add sums two numbers', () => {",
      '  assert.equal(add(1, 2), 3);',
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );
  initGitRepo(root);
}

function evaluateWorkerStep(
  step: AgentWorkerLoopStep | null,
  fixture: ReturnType<typeof readLiteTrustDemoFixture>,
  projectRoot: string,
): { passed: boolean; detail: string; executionMode?: string } {
  const exitCode = step?.exit_code ?? 1;
  const status = step?.status ?? null;
  const stepExecutionMode = step?.execution_mode;

  if (!step) {
    return {
      passed: false,
      detail: 'Worker loop step missing from CLI payload.',
    };
  }

  if (step.verb === 'plan') {
    const passed = exitCode === 0 && status === 'PLAN_READY';
    return {
      passed,
      detail: passed ? 'Plan artifact ready.' : `Expected PLAN_READY; got ${String(status)}.`,
      ...(stepExecutionMode !== undefined ? { executionMode: stepExecutionMode } : {}),
    };
  }
  if (step.verb === 'propose') {
    const passed =
      exitCode === 0 && status === 'PROPOSAL_READY' && stepExecutionMode === 'offline_demo';
    return {
      passed,
      detail: passed
        ? 'Proposal ready with offline_demo execution_mode.'
        : `Expected PROPOSAL_READY with execution_mode=offline_demo; got status=${String(status)}, execution_mode=${String(stepExecutionMode)}.`,
      ...(stepExecutionMode !== undefined ? { executionMode: stepExecutionMode } : {}),
    };
  }
  if (step.verb === 'fix') {
    const passed =
      exitCode === 0 && status === 'FIX_COMPLETE' && stepExecutionMode === 'offline_demo';
    return {
      passed,
      detail: passed
        ? `${fixture.verifier_command} passed after mock-provider fix.`
        : `Expected FIX_COMPLETE with offline_demo; exit=${exitCode}, status=${String(status)}.`,
      ...(stepExecutionMode !== undefined ? { executionMode: stepExecutionMode } : {}),
    };
  }

  return {
    passed: exitCode === 0,
    detail: `${step.verb} exit=${exitCode}, status=${String(status)}`,
    ...(stepExecutionMode !== undefined ? { executionMode: stepExecutionMode } : {}),
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
  const cliBase = {
    projectRoot: options.projectRoot,
    env: {
      ...options.env,
      BABEL_LITE_OFFLINE: '1',
      BABEL_LITE_WORKER_CHAIN: '1',
    },
    ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
  };

  const cli = runBabelCli(
    ['run', '--json', '--project-root', options.projectRoot, options.task],
    cliBase,
  );
  const payload = cli.payload;
  const executionMode = payload?.['execution_mode'] === 'offline_demo' ? 'offline_demo' : 'live';
  const workerSteps = Array.isArray(payload?.['steps'])
    ? payload['steps'].map((step) => {
        const record = step as Record<string, unknown>;
        return {
          verb:
            typeof record['verb'] === 'string'
              ? (record['verb'] as AgentWorkerLoopStep['verb'])
              : 'plan',
          status: typeof record['status'] === 'string' ? record['status'] : 'UNKNOWN',
          exit_code: typeof record['exit_code'] === 'number' ? record['exit_code'] : 1,
          ...(typeof record['execution_mode'] === 'string'
            ? { execution_mode: record['execution_mode'] }
            : {}),
          run_dir: typeof record['run_dir'] === 'string' ? record['run_dir'] : null,
        } satisfies AgentWorkerLoopStep;
      })
    : [];

  const steps: LiteWorkerLoopStep[] = [];
  for (const verb of WORKER_CHAIN_VERBS) {
    const workerStep = workerSteps.find((step) => step.verb === verb) ?? null;
    const evaluation = evaluateWorkerStep(workerStep, fixture, options.projectRoot);
    steps.push({
      name: `babel_${verb}`,
      verb,
      status: evaluation.passed ? 'pass' : 'fail',
      detail: evaluation.detail,
      ...(evaluation.executionMode !== undefined
        ? { execution_mode: evaluation.executionMode }
        : {}),
      run_dir: workerStep?.run_dir ?? null,
    });
    if (!evaluation.passed) {
      return {
        fixture_type: 'babel_lite_worker_loop',
        status: 'fail',
        execution_mode: executionMode,
        steps,
        worker_steps: workerSteps,
      };
    }
  }

  const chainComplete =
    cli.exitCode === 0 &&
    payload?.['status'] === 'WORKER_LOOP_COMPLETE' &&
    workerSteps.length === WORKER_CHAIN_VERBS.length;
  if (!chainComplete) {
    return {
      fixture_type: 'babel_lite_worker_loop',
      status: 'fail',
      execution_mode: executionMode,
      steps,
      worker_steps: workerSteps,
    };
  }

  return {
    fixture_type: 'babel_lite_worker_loop',
    status: 'pass',
    execution_mode: executionMode,
    steps,
    worker_steps: workerSteps,
  };
}

export async function runLiteWorkerLoopHarness(
  options: {
    fixturePath?: string;
    cliEntry?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<LiteWorkerLoopResult> {
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

export function resolveLiteWorkerLoopCliEntry(): string {
  return resolveBabelCliEntry();
}
