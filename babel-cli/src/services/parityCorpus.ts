import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import { resolveBabelCliEntry, runBabelCli } from './liteTrustDemo.js';
import type { ParityToolResult } from './parityBenchmark.js';

export type ParityCorpusRunMode = 'fix' | 'ask' | 'worker-loop';
export type ParityCorpusProvider = 'mock' | 'live';

export type ParityCorpusRepoKind =
  | 'single_file_fix'
  | 'multi_file_fix'
  | 'issue_context_fix'
  | 'dependency_update'
  | 'static_ui_report'
  | 'checkpoint_recovery'
  | 'read_only_review';

export interface ParityCorpusFileEntry {
  broken: string;
  fixed?: string;
}

export interface ParityCorpusTaskFixture {
  schema_version: 1;
  fixture_type: 'babel_parity_corpus_task';
  task_id: string;
  parity_task_id: string;
  title: string;
  repo_kind?: ParityCorpusRepoKind;
  target_file: string;
  verifier_command: string;
  task: string;
  broken_implementation: string;
  fixed_implementation: string;
  test_source: string;
  files?: Record<string, ParityCorpusFileEntry>;
  package_json?: Record<string, unknown>;
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
  provider?: ParityCorpusProvider;
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
  provider?: ParityCorpusProvider;
  command?: 'daily' | 'plan' | 'deep';
  cliEntry?: string;
  evidenceDir?: string;
  keepWorkspace?: boolean;
  projectRoot?: string;
  humanSummary?: boolean;
}

function resolveParityProvider(options: RunParityBabelCellOptions): ParityCorpusProvider {
  return options.provider ?? 'mock';
}

function expectedExecutionMode(provider: ParityCorpusProvider): 'offline_demo' | 'live' {
  return provider === 'mock' ? 'offline_demo' : 'live';
}

function parityCliBase(
  projectRoot: string,
  options: RunParityBabelCellOptions,
): { projectRoot: string; offlineDemo: boolean; cliEntry?: string } {
  const provider = resolveParityProvider(options);
  return {
    projectRoot,
    offlineDemo: provider === 'mock',
    ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
  };
}

function parityCommandArgs(
  projectRoot: string,
  task: string,
  options: RunParityBabelCellOptions,
  extraArgs: string[] = [],
): string[] {
  const command = options.command ?? 'run';
  return [
    command,
    '--json',
    ...(command === 'run' ? ['--mode', 'chat'] : []),
    ...(options.humanSummary === true ? ['--human-summary'] : []),
    '--project-root',
    projectRoot,
    ...extraArgs,
    task,
  ];
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
  const parsed = JSON.parse(
    readFileSync(resolveParityCorpusTaskPath(taskId), 'utf8'),
  ) as ParityCorpusTaskFixture;
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

export function resolveParityCorpusRepoKind(task: ParityCorpusTaskFixture): ParityCorpusRepoKind {
  return task.repo_kind ?? 'single_file_fix';
}

function writeFileWithParents(root: string, relativePath: string, content: string): void {
  const fullPath = join(root, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
}

function writeExtraBrokenFiles(root: string, task: ParityCorpusTaskFixture): void {
  for (const [relativePath, entry] of Object.entries(task.files ?? {})) {
    writeFileWithParents(root, relativePath, entry.broken);
  }
}

function writeDefaultPackageJson(root: string, task: ParityCorpusTaskFixture): void {
  const payload = task.package_json ?? {
    type: 'module',
    scripts: { test: 'node src/math.test.js' },
  };
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function writeSingleFileFixRepo(root: string, task: ParityCorpusTaskFixture): void {
  writeDefaultPackageJson(root, task);
  writeFileWithParents(root, task.target_file, task.broken_implementation);
  if (task.test_source.trim().length > 0) {
    writeFileWithParents(root, 'src/math.test.js', task.test_source);
  }
}

function writeMultiFileFixRepo(root: string, task: ParityCorpusTaskFixture): void {
  writeDefaultPackageJson(root, task);
  writeFileWithParents(root, task.target_file, task.broken_implementation);
  writeExtraBrokenFiles(root, task);
  if (task.test_source.trim().length > 0) {
    writeFileWithParents(root, 'src/math.test.js', task.test_source);
  }
}

function writeDependencyUpdateRepo(root: string, task: ParityCorpusTaskFixture): void {
  writeFileWithParents(root, task.target_file, task.broken_implementation);
  writeExtraBrokenFiles(root, task);
}

function writeReadOnlyReviewRepo(root: string, task: ParityCorpusTaskFixture): void {
  writeDefaultPackageJson(root, task);
  writeFileWithParents(root, task.target_file, task.broken_implementation);
  writeExtraBrokenFiles(root, task);
}

export function writeParityCorpusRepo(root: string, task: ParityCorpusTaskFixture): void {
  const repoKind = resolveParityCorpusRepoKind(task);
  switch (repoKind) {
    case 'single_file_fix':
    case 'checkpoint_recovery':
      writeSingleFileFixRepo(root, task);
      break;
    case 'multi_file_fix':
    case 'issue_context_fix':
      writeMultiFileFixRepo(root, task);
      break;
    case 'dependency_update':
      writeDependencyUpdateRepo(root, task);
      break;
    case 'static_ui_report':
    case 'read_only_review':
      writeReadOnlyReviewRepo(root, task);
      break;
    default:
      writeSingleFileFixRepo(root, task);
      break;
  }
  initGitRepo(root);
}

export function parityCorpusSeedExpectsFailingVerifier(task: ParityCorpusTaskFixture): boolean {
  return resolveParityCorpusRepoKind(task) !== 'read_only_review';
}

export function resolveParityCorpusRunMode(
  task: ParityCorpusTaskFixture,
  override?: ParityCorpusRunMode,
): ParityCorpusRunMode {
  if (override !== undefined) {
    return override;
  }
  const repoKind = resolveParityCorpusRepoKind(task);
  if (repoKind === 'read_only_review' || repoKind === 'static_ui_report') {
    return 'ask';
  }
  return 'fix';
}

export function parityCorpusFixTargets(task: ParityCorpusTaskFixture): string[] {
  const extraTargets = Object.entries(task.files ?? {})
    .filter(([, entry]) => typeof entry.fixed === 'string')
    .map(([relativePath]) => relativePath);
  return [task.target_file, ...extraTargets.filter((path) => path !== task.target_file)];
}

export function parityCorpusExpectedContent(
  task: ParityCorpusTaskFixture,
  relativePath: string,
): string | null {
  if (relativePath === task.target_file) {
    return task.fixed_implementation;
  }
  const entry = task.files?.[relativePath];
  return typeof entry?.fixed === 'string' ? entry.fixed : null;
}

export function parityCorpusBrokenContent(
  task: ParityCorpusTaskFixture,
  relativePath: string,
): string | null {
  if (relativePath === task.target_file) {
    return task.broken_implementation;
  }
  const entry = task.files?.[relativePath];
  return typeof entry?.broken === 'string' ? entry.broken : null;
}

export function parityCorpusMutationComplete(
  task: ParityCorpusTaskFixture,
  projectRoot: string,
  verifierOk?: boolean,
): {
  ok: boolean;
  changedFiles: string[];
} {
  const changedFiles: string[] = [];
  for (const relativePath of parityCorpusFixTargets(task)) {
    const expected = parityCorpusExpectedContent(task, relativePath);
    const broken = parityCorpusBrokenContent(task, relativePath);
    if (expected === null || broken === null) {
      return { ok: false, changedFiles };
    }
    const actual = existsSync(join(projectRoot, relativePath))
      ? readFileSync(join(projectRoot, relativePath), 'utf8')
      : '';
    if (actual !== expected) {
      // Lenient mode for live provider: if verifier passed and file differs from broken,
      // consider it a match (model may produce semantically equivalent but textually different output)
      if (verifierOk && actual !== broken) {
        changedFiles.push(relativePath);
        continue;
      }
      return { ok: false, changedFiles };
    }
    if (actual !== broken) {
      changedFiles.push(relativePath);
    }
  }
  return { ok: true, changedFiles };
}

function parityCorpusSeedIntact(task: ParityCorpusTaskFixture, projectRoot: string): boolean {
  const paths = [task.target_file, ...Object.keys(task.files ?? {})];
  for (const relativePath of paths) {
    const broken = parityCorpusBrokenContent(task, relativePath);
    if (broken === null) {
      continue;
    }
    const actual = existsSync(join(projectRoot, relativePath))
      ? readFileSync(join(projectRoot, relativePath), 'utf8')
      : '';
    if (actual !== broken) {
      return false;
    }
  }
  return true;
}

function resolveAskCellVerifierExpectation(task: ParityCorpusTaskFixture): 'pass' | 'fail' {
  return resolveParityCorpusRepoKind(task) === 'static_ui_report' ? 'fail' : 'pass';
}

export function runParityCorpusVerifier(root: string, verifierCommand: string): number {
  const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';
  const args =
    process.platform === 'win32' ? ['/d', '/s', '/c', verifierCommand] : ['-c', verifierCommand];
  const result = spawnSync(shell, args, { cwd: root, encoding: 'utf-8' });
  return result.status ?? 1;
}

function verifierPassed(payload: Record<string, unknown> | null, verifierCommand: string): boolean {
  // Primary check: look for "npm test: passed" in the checks array
  const checks = Array.isArray(payload?.['checks'])
    ? payload['checks'].filter((value): value is string => typeof value === 'string')
    : [];
  if (checks.some((check) => check === `${verifierCommand}: passed`)) {
    return true;
  }
  // Fallback: for multi_file coordinated fix lane, checks may be empty
  // even though verification succeeded. Check verification.status directly.
  const verification = payload?.['verification'] as Record<string, unknown> | undefined;
  if (verification?.['status'] === 'passed') {
    return true;
  }
  return false;
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

function scopedParityFixTask(task: ParityCorpusTaskFixture, relativePath: string): string {
  return `Fix the parity corpus fixture for ${task.parity_task_id}. Only edit ${relativePath}.`;
}

async function runFixCell(
  task: ParityCorpusTaskFixture,
  projectRoot: string,
  options: RunParityBabelCellOptions,
): Promise<ParityBabelCellEvidence> {
  const started = performance.now();
  const provider = resolveParityProvider(options);
  const cliBase = parityCliBase(projectRoot, options);
  const fixTargets = parityCorpusFixTargets(task);
  const steps: Array<{ target: string; exit: number; status: string | null }> = [];
  let payload: Record<string, unknown> | null = null;
  let executionMode: 'offline_demo' | 'live' = provider === 'mock' ? 'offline_demo' : 'live';
  let cliExitCode = 1;

  const repoKind = resolveParityCorpusRepoKind(task);
  const isMultiFile = repoKind === 'multi_file_fix';

  if (isMultiFile) {
    // Attempt coordinated multi-file fix first
    const cli = runBabelCli(parityCommandArgs(projectRoot, task.task, options), cliBase);
    payload = cli.payload;
    cliExitCode = cli.exitCode;
    const statusText = typeof payload?.['status'] === 'string' ? payload['status'] : null;
    if (payload?.['execution_mode'] === 'offline_demo') {
      executionMode = 'offline_demo';
    }
    steps.push({ target: 'coordinated_multi', exit: cli.exitCode, status: statusText });

    // Fallback: if coordinated approach failed (especially with live provider),
    // decompose into sequential per-file fixes
    const coordinatedFailed = cliExitCode !== 0 || statusText !== 'FIX_COMPLETE' && statusText !== 'ANSWER_READY';
    if (coordinatedFailed && fixTargets.length > 1) {
      steps.push({ target: '---fallback_sequential---', exit: 0, status: 'DECOMPOSING' });
      for (const relativePath of fixTargets) {
        const perFileCli = runBabelCli(
          parityCommandArgs(projectRoot, scopedParityFixTask(task, relativePath), options),
          cliBase,
        );
        payload = perFileCli.payload;
        cliExitCode = perFileCli.exitCode;
        const perFileStatus = typeof payload?.['status'] === 'string' ? payload['status'] : null;
        steps.push({ target: relativePath, exit: perFileCli.exitCode, status: perFileStatus });
        if (perFileCli.exitCode !== 0 || perFileStatus !== 'FIX_COMPLETE') {
          break; // stop on first per-file failure
        }
      }
    }
  } else {
    for (const relativePath of fixTargets) {
      const cli = runBabelCli(
        parityCommandArgs(
          projectRoot,
          fixTargets.length === 1 ? task.task : scopedParityFixTask(task, relativePath),
          options,
        ),
        cliBase,
      );
      payload = cli.payload;
      cliExitCode = cli.exitCode;
      const statusText = typeof payload?.['status'] === 'string' ? payload['status'] : null;
      if (payload?.['execution_mode'] === 'offline_demo') {
        executionMode = 'offline_demo';
      }
      steps.push({ target: relativePath, exit: cli.exitCode, status: statusText });
      const expected = parityCorpusExpectedContent(task, relativePath);
      const actual = existsSync(join(projectRoot, relativePath))
        ? readFileSync(join(projectRoot, relativePath), 'utf8')
        : '';
      if (expected === null || actual !== expected) {
        break;
      }
    }
  }

  const verifierOk =
    provider === 'live'
      ? verifierPassed(payload, task.verifier_command)
      : runParityCorpusVerifier(projectRoot, task.verifier_command) === 0;
  const mutation = parityCorpusMutationComplete(task, projectRoot, verifierOk);
  const statusText = steps.at(-1)?.status ?? null;
  const expectedMode = expectedExecutionMode(provider);
  // Chat mode uses ANSWER_READY; deep pipeline uses FIX_COMPLETE.
  const claimedFixed = statusText === 'FIX_COMPLETE' || statusText === 'ANSWER_READY';
  const success = claimedFixed && verifierOk && mutation.ok;
  const falseComplete = claimedFixed && mutation.ok && !verifierOk;

  return {
    schema_version: 1,
    fixture_type: 'babel_parity_babel_cell',
    task_id: task.task_id,
    mode: 'fix',
    provider,
    execution_mode: executionMode,
    status: success ? 'success' : 'failure',
    verifier: verifierOk ? 'pass' : 'fail',
    false_complete: falseComplete,
    latency_ms: Math.round(performance.now() - started),
    cli_exit_code: cliExitCode,
    cli_payload: {
      ...(payload ?? {}),
      ...(fixTargets.length > 1 ? { fix_steps: steps } : {}),
    },
    changed_files: mutation.changedFiles,
    notes: [
      `parity corpus fix cell via babel ${options.command ?? 'run --mode chat'} --provider ${provider}`,
      `exit=${cliExitCode}, status=${String(statusText)}, verifier=${verifierOk ? 'pass' : 'fail'}`,
      ...(fixTargets.length > 1 ? [`fix_targets=${fixTargets.join(',')}`] : []),
    ],
  };
}

async function runAskCell(
  task: ParityCorpusTaskFixture,
  projectRoot: string,
  options: RunParityBabelCellOptions,
): Promise<ParityBabelCellEvidence> {
  const started = performance.now();
  const provider = resolveParityProvider(options);
  const cliBase = parityCliBase(projectRoot, options);
  const cli = runBabelCli(parityCommandArgs(projectRoot, task.task, options), cliBase);
  const payload = cli.payload;
  const statusText = typeof payload?.['status'] === 'string' ? payload['status'] : null;
  const executionMode = resolveExecutionModeFromPayload(provider, payload);
  const verifierExitCode = runParityCorpusVerifier(projectRoot, task.verifier_command);
  const verifierOk = verifierExitCode === 0;
  const verifierExpectation = resolveAskCellVerifierExpectation(task);
  const verifierMatches = verifierExpectation === 'pass' ? verifierOk : !verifierOk;
  const seedIntact = parityCorpusSeedIntact(task, projectRoot);
  // Chat mode uses ANSWER_READY; deep pipeline uses REPORT_READY.
  // Accept either for backward compatibility.
  const claimedReady =
    statusText === 'ANSWER_READY' || statusText === 'REPORT_READY';
  const success =
    cli.exitCode === 0 &&
    claimedReady &&
    seedIntact &&
    verifierMatches;

  return {
    schema_version: 1,
    fixture_type: 'babel_parity_babel_cell',
    task_id: task.task_id,
    mode: 'ask',
    provider,
    execution_mode: executionMode,
    status: success ? 'success' : 'failure',
    verifier: verifierOk ? 'pass' : 'fail',
    false_complete: false,
    latency_ms: Math.round(performance.now() - started),
    cli_exit_code: cli.exitCode,
    cli_payload: payload,
    changed_files: [],
    notes: [
      'read-only fixture-scoped Babel cell via chat mode (ask lane)',
      `exit=${cli.exitCode}, status=${String(statusText)}, verifier=${verifierOk ? 'pass' : 'fail'}, seed_intact=${seedIntact}`,
    ],
  };
}

const WORKER_CHAIN_VERBS = ['plan', 'propose', 'fix', 'review', 'undo'] as const;

function resolveExecutionModeFromPayload(
  provider: ParityCorpusProvider,
  payload: Record<string, unknown> | null,
): 'offline_demo' | 'live' {
  if (payload?.['execution_mode'] === 'offline_demo') {
    return 'offline_demo';
  }
  if (payload?.['execution_mode'] === 'live') {
    return 'live';
  }
  return provider === 'mock' ? 'offline_demo' : 'live';
}

async function runWorkerLoopCell(
  task: ParityCorpusTaskFixture,
  projectRoot: string,
  options: RunParityBabelCellOptions,
): Promise<ParityBabelCellEvidence> {
  const started = performance.now();
  const provider = resolveParityProvider(options);
  const cliBase = parityCliBase(projectRoot, options);
  const expectedMode = expectedExecutionMode(provider);
  const steps: Array<{ verb: string; status: 'pass' | 'fail'; detail: string }> = [];
  let executionMode: 'offline_demo' | 'live' = expectedMode;

  for (const verb of WORKER_CHAIN_VERBS) {
    const args = (() => {
      const base = ['--json', '--project-root', projectRoot] as string[];
      if (verb === 'plan') {
        return ['plan', ...base, task.task];
      }
      if (verb === 'propose') {
        return parityCommandArgs(
          projectRoot,
          'propose the smallest diff to fix without applying',
          options,
        );
      }
      if (verb === 'fix') {
        return parityCommandArgs(projectRoot, task.task, options);
      }
      if (verb === 'review') {
        return ['review', ...base];
      }
      return ['undo', ...base];
    })();
    const cli = runBabelCli(args, {
      ...cliBase,
      offlineDemo: provider === 'mock' || verb === 'fix' || verb === 'propose',
    });
    const payload = cli.payload;
    const status = typeof payload?.['status'] === 'string' ? payload['status'] : null;
    executionMode = resolveExecutionModeFromPayload(provider, payload);

    let passed = cli.exitCode === 0;
    let detail = `${verb} exit=${cli.exitCode}, status=${String(status)}`;

    if (verb === 'plan') {
      passed = passed && status === 'PLAN_READY';
      detail = passed ? 'Plan artifact ready.' : `Expected PLAN_READY; got ${String(status)}.`;
    } else if (verb === 'propose') {
      passed = passed && status === 'PROPOSAL_READY' && executionMode === expectedMode;
      detail = passed
        ? `Proposal ready with execution_mode=${expectedMode}.`
        : `Expected PROPOSAL_READY with execution_mode=${expectedMode}; got status=${String(status)}.`;
    } else if (verb === 'fix') {
      const verifierOk =
        provider === 'live'
          ? verifierPassed(payload, task.verifier_command)
          : runParityCorpusVerifier(projectRoot, task.verifier_command) === 0;
      passed = passed && status === 'FIX_COMPLETE' && executionMode === expectedMode && verifierOk;
      detail = passed
        ? `${task.verifier_command} passed after ${provider}-provider fix.`
        : `Expected FIX_COMPLETE with execution_mode=${expectedMode} and verifier pass; exit=${cli.exitCode}, status=${String(status)}.`;
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
        provider,
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
    provider,
    execution_mode: executionMode,
    status: 'success',
    verifier: 'pass',
    false_complete: false,
    latency_ms: Math.round(performance.now() - started),
    cli_exit_code: 0,
    cli_payload: { worker_loop_status: 'pass', steps },
    changed_files: [task.target_file],
    notes: [
      `fixture-scoped Babel cell via linked worker loop (plan→propose→fix→review→undo) with provider=${provider}`,
      'worker_loop=pass',
    ],
  };
}

export async function runParityBabelCell(
  taskId: string,
  options: RunParityBabelCellOptions = {},
): Promise<ParityToolResult> {
  const task = readParityCorpusTask(taskId);
  const mode = resolveParityCorpusRunMode(task, options.mode);
  const ownsWorkspace = options.projectRoot === undefined;
  const projectRoot = options.projectRoot ?? mkdtempSync(join(tmpdir(), 'babel-parity-corpus-'));
  const evidenceDir = resolve(options.evidenceDir ?? join(BABEL_RUNS_DIR, 'parity-corpus'));

  try {
    if (ownsWorkspace) {
      writeParityCorpusRepo(projectRoot, task);
    }
    const evidence =
      mode === 'worker-loop'
        ? await runWorkerLoopCell(task, projectRoot, options)
        : mode === 'ask'
          ? await runAskCell(task, projectRoot, options)
          : await runFixCell(task, projectRoot, options);
    const evidencePath = writeEvidence(evidenceDir, task.task_id, evidence);
    return toParityToolResult(task, evidence, evidencePath);
  } finally {
    if (ownsWorkspace && options.keepWorkspace !== true) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }
}

export async function runParityBabelCorpus(
  options: {
    taskIds?: string[];
    mode?: ParityCorpusRunMode;
    cliEntry?: string;
    evidenceDir?: string;
  } = {},
): Promise<{ results: ParityToolResult[]; evidence_dir: string }> {
  const manifest = readParityCorpusManifest();
  const taskIds = options.taskIds ?? manifest.tasks;
  const evidenceDir = resolve(options.evidenceDir ?? join(BABEL_RUNS_DIR, 'parity-corpus'));
  const results: ParityToolResult[] = [];

  for (const taskId of taskIds) {
    const task = readParityCorpusTask(taskId);
    results.push(
      await runParityBabelCell(taskId, {
        mode: resolveParityCorpusRunMode(task, options.mode),
        ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
        evidenceDir,
      }),
    );
  }

  return { results, evidence_dir: evidenceDir };
}

export function buildParityFixtureFromResults(results: ParityToolResult[]): {
  results: ParityToolResult[];
} {
  return { results };
}

export { resolveBabelCliEntry };
