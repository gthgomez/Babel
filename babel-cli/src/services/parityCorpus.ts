import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import {
  resolveBabelCliEntry,
  runBabelCli,
} from './liteTrustDemo.js';
import type { ParityToolResult } from './parityBenchmark.js';

export type ParityCorpusRunMode = 'fix' | 'worker-loop';

export interface ParityCorpusTaskFixture {
  schema_version: 1;
  fixture_type: 'babel_parity_corpus_task';
  task_id: string;
  parity_task_id: string;
  title: string;
  target_file: string;
  verifier_command: string;
  task: string;
  broken_implementation: string;
  fixed_implementation: string;
  test_source: string;
}

export interface ParityCorpusManifest {
  schema_version: 1;
  fixture_type: 'babel_parity_corpus';
  tasks: string[];
}

export interface ParityBabelCellEvidence {
  schema_version: 1;
  fixture_type: 'babel_parity_babel_cell';
  task_id: string;
  mode: ParityCorpusRunMode;
  execution_mode: 'offline_demo' | 'live';
  status: 'success' | 'failure';
  verifier: 'pass' | 'fail';
  false_complete: boolean;
  latency_ms: number;
  cli_exit_code: number;
  cli_payload: Record<string, unknown> | null;
  changed_files: string[];
  notes: string[];
}

export interface RunParityBabelCellOptions {
  mode?: ParityCorpusRunMode;
  cliEntry?: string;
  evidenceDir?: string;
  keepWorkspace?: boolean;
  projectRoot?: string;
}

function corpusDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'fixtures', 'parity-corpus');
}

export function resolveParityCorpusDir(): string {
  return corpusDir();
}

export function readParityCorpusManifest(manifestPath?: string): ParityCorpusManifest {
  const path = resolve(manifestPath ?? join(corpusDir(), 'manifest.json'));
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ParityCorpusManifest;
  if (parsed.fixture_type !== 'babel_parity_corpus' || !Array.isArray(parsed.tasks)) {
    throw new Error('Parity corpus manifest is invalid.');
  }
  return parsed;
}

export function resolveParityCorpusTaskPath(taskId: string): string {
  const path = join(corpusDir(), `${taskId}.json`);
  if (!existsSync(path)) {
    throw new Error(`Parity corpus task fixture not found: ${taskId}`);
  }
  return path;
}

export function readParityCorpusTask(taskId: string): ParityCorpusTaskFixture {
  const parsed = JSON.parse(readFileSync(resolveParityCorpusTaskPath(taskId), 'utf8')) as ParityCorpusTaskFixture;
  if (parsed.fixture_type !== 'babel_parity_corpus_task') {
    throw new Error(`Parity corpus task ${taskId} has an unexpected fixture_type.`);
  }
  return parsed;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'babel-parity',
    GIT_AUTHOR_EMAIL: 'babel-parity@local',
    GIT_COMMITTER_NAME: 'babel-parity',
    GIT_COMMITTER_EMAIL: 'babel-parity@local',
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
  const commit = spawnSync('git', ['commit', '-m', 'babel-parity-corpus'], {
    cwd: root,
    encoding: 'utf-8',
    env: gitEnv(),
  });
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout || 'unknown error'}`);
  }
}

export function writeParityCorpusRepo(root: string, task: ParityCorpusTaskFixture): void {
  const targetDir = join(root, task.target_file.split('/').slice(0, -1).join('/'));
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node src/math.test.js' },
  }, null, 2), 'utf-8');
  writeFileSync(join(root, task.target_file), task.broken_implementation, 'utf-8');
  writeFileSync(join(root, 'src', 'math.test.js'), `${task.test_source}\n`, 'utf-8');
  initGitRepo(root);
}

function verifierPassed(payload: Record<string, unknown> | null, verifierCommand: string): boolean {
  const checks = Array.isArray(payload?.['checks'])
    ? payload['checks'].filter((value): value is string => typeof value === 'string')
    : [];
  return checks.some(check => check === `${verifierCommand}: passed`);
}

function writeEvidence(
  evidenceDir: string,
  taskId: string,
  evidence: ParityBabelCellEvidence,
): string {
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, `${taskId}-babel.json`);
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return path;
}

function toParityToolResult(
  task: ParityCorpusTaskFixture,
  evidence: ParityBabelCellEvidence,
  evidencePath: string,
): ParityToolResult {
  return {
    task_id: task.parity_task_id,
    tool: 'babel',
    status: evidence.status,
    verifier: evidence.verifier,
    false_complete: evidence.false_complete,
    latency_ms: evidence.latency_ms,
    cost_usd: null,
    token_count: null,
    changed_files: evidence.changed_files,
    user_interventions: 0,
    evidence_path: evidencePath,
    notes: evidence.notes,
  };
}

async function runFixCell(
  task: ParityCorpusTaskFixture,
  projectRoot: string,
  options: RunParityBabelCellOptions,
): Promise<ParityBabelCellEvidence> {
  const started = performance.now();
  const cliBase = {
    projectRoot,
    ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
  };
  const cli = runBabelCli([
    'fix',
    '--json',
    '--provider',
    'mock',
    '--project-root',
    projectRoot,
    task.task,
  ], cliBase);
  const payload = cli.payload;
  const statusText = typeof payload?.['status'] === 'string' ? payload['status'] : null;
  const executionMode = payload?.['execution_mode'] === 'offline_demo' ? 'offline_demo' : 'live';
  const verifierOk = verifierPassed(payload, task.verifier_command);
  const targetPath = join(projectRoot, task.target_file);
  const fixedContent = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
  const mutationOk = fixedContent === task.fixed_implementation;
  const success = cli.exitCode === 0 &&
    statusText === 'FIX_COMPLETE' &&
    executionMode === 'offline_demo' &&
    verifierOk &&
    mutationOk;
  const falseComplete = cli.exitCode === 0 && statusText === 'FIX_COMPLETE' && !verifierOk;

  return {
    schema_version: 1,
    fixture_type: 'babel_parity_babel_cell',
    task_id: task.task_id,
    mode: 'fix',
    execution_mode: executionMode,
    status: success ? 'success' : 'failure',
    verifier: verifierOk ? 'pass' : 'fail',
    false_complete: falseComplete,
    latency_ms: Math.round(performance.now() - started),
    cli_exit_code: cli.exitCode,
    cli_payload: payload,
    changed_files: mutationOk ? [task.target_file] : [],
    notes: [
      'offline_demo fixture-scoped Babel cell via bl fix --provider mock',
      `exit=${cli.exitCode}, status=${String(statusText)}, verifier=${verifierOk ? 'pass' : 'fail'}`,
    ],
  };
}

const WORKER_CHAIN_VERBS = ['plan', 'propose', 'fix', 'review', 'undo'] as const;

async function runWorkerLoopCell(
  task: ParityCorpusTaskFixture,
  projectRoot: string,
  options: RunParityBabelCellOptions,
): Promise<ParityBabelCellEvidence> {
  const started = performance.now();
  const cliBase = {
    projectRoot,
    ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
  };
  const steps: Array<{ verb: string; status: 'pass' | 'fail'; detail: string }> = [];
  let executionMode: 'offline_demo' | 'live' = 'offline_demo';

  for (const verb of WORKER_CHAIN_VERBS) {
    const args = [
      'lite',
      verb,
      '--json',
      '--project-root',
      projectRoot,
      ...(verb === 'propose' || verb === 'fix' ? ['--provider', 'mock'] : []),
      ...(verb === 'review' || verb === 'undo' ? [] : [task.task]),
    ];
    const cli = runBabelCli(args, cliBase);
    const payload = cli.payload;
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
        : `Expected PROPOSAL_READY with execution_mode=offline_demo; got status=${String(status)}.`;
    } else if (verb === 'fix') {
      const verifierOk = verifierPassed(payload, task.verifier_command);
      passed = passed &&
        status === 'FIX_COMPLETE' &&
        stepExecutionMode === 'offline_demo' &&
        verifierOk;
      detail = passed
        ? `${task.verifier_command} passed after mock-provider fix.`
        : `Expected FIX_COMPLETE with offline_demo and verifier pass; exit=${cli.exitCode}, status=${String(status)}.`;
    } else if (verb === 'review') {
      passed = passed && status === 'REVIEW_READY';
      detail = passed ? 'Review lane completed.' : `Expected REVIEW_READY; got ${String(status)}.`;
    } else if (verb === 'undo') {
      passed = passed && status === 'UNDO_COMPLETE';
      const targetPath = join(projectRoot, task.target_file);
      const restored = readFileSync(targetPath, 'utf8') === task.broken_implementation;
      passed = passed && restored;
      detail = passed
        ? 'Checkpoint restore returned UNDO_COMPLETE and source restored.'
        : `Undo failed or source not restored; exit=${cli.exitCode}, status=${String(status)}.`;
    }

    steps.push({ verb, status: passed ? 'pass' : 'fail', detail });
    if (!passed) {
      return {
        schema_version: 1,
        fixture_type: 'babel_parity_babel_cell',
        task_id: task.task_id,
        mode: 'worker-loop',
        execution_mode: executionMode,
        status: 'failure',
        verifier: 'fail',
        false_complete: false,
        latency_ms: Math.round(performance.now() - started),
        cli_exit_code: 1,
        cli_payload: { worker_loop_status: 'fail', steps },
        changed_files: [],
        notes: [
          'offline_demo fixture-scoped Babel cell via linked worker loop (plan→propose→fix→review→undo)',
          `failed at ${verb}`,
        ],
      };
    }
  }

  return {
    schema_version: 1,
    fixture_type: 'babel_parity_babel_cell',
    task_id: task.task_id,
    mode: 'worker-loop',
    execution_mode: executionMode,
    status: 'success',
    verifier: 'pass',
    false_complete: false,
    latency_ms: Math.round(performance.now() - started),
    cli_exit_code: 0,
    cli_payload: { worker_loop_status: 'pass', steps },
    changed_files: [task.target_file],
    notes: [
      'offline_demo fixture-scoped Babel cell via linked worker loop (plan→propose→fix→review→undo)',
      'worker_loop=pass',
    ],
  };
}

export async function runParityBabelCell(
  taskId: string,
  options: RunParityBabelCellOptions = {},
): Promise<ParityToolResult> {
  const task = readParityCorpusTask(taskId);
  const mode = options.mode ?? 'fix';
  const ownsWorkspace = options.projectRoot === undefined;
  const projectRoot = options.projectRoot ?? mkdtempSync(join(tmpdir(), 'babel-parity-corpus-'));
  const evidenceDir = resolve(options.evidenceDir ?? join(BABEL_RUNS_DIR, 'parity-corpus'));

  try {
    if (ownsWorkspace) {
      writeParityCorpusRepo(projectRoot, task);
    }
    const evidence = mode === 'worker-loop'
      ? await runWorkerLoopCell(task, projectRoot, options)
      : await runFixCell(task, projectRoot, options);
    const evidencePath = writeEvidence(evidenceDir, task.task_id, evidence);
    return toParityToolResult(task, evidence, evidencePath);
  } finally {
    if (ownsWorkspace && options.keepWorkspace !== true) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }
}

export async function runParityBabelCorpus(options: {
  taskIds?: string[];
  mode?: ParityCorpusRunMode;
  cliEntry?: string;
  evidenceDir?: string;
} = {}): Promise<{ results: ParityToolResult[]; evidence_dir: string }> {
  const manifest = readParityCorpusManifest();
  const taskIds = options.taskIds ?? manifest.tasks;
  const evidenceDir = resolve(options.evidenceDir ?? join(BABEL_RUNS_DIR, 'parity-corpus'));
  const results: ParityToolResult[] = [];

  for (const taskId of taskIds) {
    results.push(await runParityBabelCell(taskId, {
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
      evidenceDir,
    }));
  }

  return { results, evidence_dir: evidenceDir };
}

export function buildParityFixtureFromResults(results: ParityToolResult[]): { results: ParityToolResult[] } {
  return { results };
}

export { resolveBabelCliEntry };
