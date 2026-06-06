import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BABEL_ROOT } from '../cli/constants.js';

export interface LiteTrustDemoFixture {
  schema_version: 1;
  fixture_type: 'babel_lite_trust_demo';
  scenario_id?: string;
  visibility: 'private';
  description: string;
  target_file: string;
  verifier_command: string;
  task: string;
  broken_implementation: string;
  fixed_implementation: string;
  mock_provider_answer?: string;
}

export interface LiteTrustDemoStep {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
}

export interface LiteTrustDemoScenarioResult {
  scenario_id: string;
  status: 'pass' | 'fail';
  steps: LiteTrustDemoStep[];
  run_dir: string | null;
  execution_mode?: 'offline_demo';
}

export interface LiteTrustDemoResult {
  fixture_type: 'babel_lite_trust_demo';
  status: 'pass' | 'fail';
  steps: LiteTrustDemoStep[];
  scenarios: LiteTrustDemoScenarioResult[];
  run_dir: string | null;
  execution_mode?: 'offline_demo';
}

interface CliInvocationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: Record<string, unknown> | null;
}

function defaultFixturePath(): string {
  return join(BABEL_ROOT, 'babel-cli', 'src', 'fixtures', 'lite-trust-demo', 'scenario.json');
}

function fixtureDir(): string {
  return join(BABEL_ROOT, 'babel-cli', 'src', 'fixtures', 'lite-trust-demo');
}

export function resolveBabelCliEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'dist', 'index.js');
}

export function listLiteTrustDemoFixturePaths(): string[] {
  const paths = [defaultFixturePath()];
  const scenariosDir = join(fixtureDir(), 'scenarios');
  if (existsSync(scenariosDir)) {
    for (const name of readdirSync(scenariosDir)) {
      if (name.endsWith('.json')) {
        paths.push(join(scenariosDir, name));
      }
    }
  }
  return paths.filter(path => existsSync(path));
}

export function readLiteTrustDemoFixture(fixturePath?: string): LiteTrustDemoFixture {
  const raw = readFileSync(resolve(fixturePath ?? defaultFixturePath()), 'utf8');
  const parsed = JSON.parse(raw) as LiteTrustDemoFixture;
  if (parsed.fixture_type !== 'babel_lite_trust_demo') {
    throw new Error('Lite trust demo fixture has an unexpected fixture_type.');
  }
  return parsed;
}

function scenarioId(fixture: LiteTrustDemoFixture, fixturePath: string): string {
  if (fixture.scenario_id) {
    return fixture.scenario_id;
  }
  const base = fixturePath.split(/[\\/]/).pop() ?? 'scenario';
  return base.replace(/\.json$/, '');
}

function parseCliJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function runBabelCli(
  args: string[],
  options: {
    projectRoot: string;
    env?: NodeJS.ProcessEnv;
    cliEntry?: string;
  },
): CliInvocationResult {
  const cliEntry = options.cliEntry ?? resolveBabelCliEntry();
  const env = {
    ...process.env,
    ...options.env,
    BABEL_PROJECT_ROOT: options.projectRoot,
    BABEL_LITE_OFFLINE: '1',
    BABEL_SMALL_FIX_PROVIDER: 'mock',
  };
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: options.projectRoot,
    env,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    exitCode: result.status ?? 1,
    stdout,
    stderr,
    payload: parseCliJson(stdout),
  };
}

async function runSuccessScenario(options: {
  projectRoot: string;
  fixture: LiteTrustDemoFixture;
  env?: NodeJS.ProcessEnv;
  cliEntry?: string;
}): Promise<LiteTrustDemoScenarioResult> {
  const steps: LiteTrustDemoStep[] = [];
  let runDir: string | null = null;
  let executionMode: 'offline_demo' | undefined;
  const cliBase = {
    projectRoot: options.projectRoot,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
  };

  const fixCli = runBabelCli([
    'fix',
    '--json',
    '--provider',
    'mock',
    '--project-root',
    options.projectRoot,
    options.fixture.task,
  ], cliBase);

  const fixPayload = fixCli.payload;
  const fixStatus = typeof fixPayload?.['status'] === 'string' ? fixPayload['status'] : null;
  const fixExecutionMode = fixPayload?.['execution_mode'];
  if (fixExecutionMode === 'offline_demo') {
    executionMode = 'offline_demo';
  }
  runDir = typeof fixPayload?.['run_dir'] === 'string' ? fixPayload['run_dir'] : null;
  const fixChecks = Array.isArray(fixPayload?.['checks'])
    ? fixPayload['checks'].filter((value): value is string => typeof value === 'string')
    : [];
  const fixPassed = fixCli.exitCode === 0 &&
    fixStatus === 'FIX_COMPLETE' &&
    fixExecutionMode === 'offline_demo' &&
    fixChecks.some(check => check === `${options.fixture.verifier_command}: passed`);
  steps.push({
    name: 'bl_fix_verifier',
    status: fixPassed ? 'pass' : 'fail',
    detail: fixPassed
      ? `${options.fixture.verifier_command} passed after CLI mock-provider fix.`
      : `Expected FIX_COMPLETE with execution_mode=offline_demo and verifier pass; exit=${fixCli.exitCode}, status=${String(fixStatus)}, execution_mode=${String(fixExecutionMode)}.`,
  });

  const targetPath = join(options.projectRoot, options.fixture.target_file);
  const fixedContent = readFileSync(targetPath, 'utf8');
  const fixApplied = fixedContent === options.fixture.fixed_implementation;
  steps.push({
    name: 'workspace_mutation',
    status: fixApplied ? 'pass' : 'fail',
    detail: fixApplied
      ? `${options.fixture.target_file} contains the repaired implementation.`
      : `${options.fixture.target_file} did not match the expected fixed implementation.`,
  });

  const undoCli = runBabelCli([
    'undo',
    '--json',
    '--project-root',
    options.projectRoot,
  ], cliBase);
  const undoPayload = undoCli.payload;
  const undoStatus = typeof undoPayload?.['status'] === 'string' ? undoPayload['status'] : null;
  const undoPassed = undoCli.exitCode === 0 && undoStatus === 'UNDO_COMPLETE';
  steps.push({
    name: 'bl_undo_restore',
    status: undoPassed ? 'pass' : 'fail',
    detail: undoPassed
      ? 'Checkpoint restore returned UNDO_COMPLETE.'
      : `Undo failed with exit=${undoCli.exitCode}, status=${String(undoStatus)}.`,
  });

  const restoredContent = readFileSync(targetPath, 'utf8');
  const restored = restoredContent === options.fixture.broken_implementation;
  steps.push({
    name: 'source_restored',
    status: restored ? 'pass' : 'fail',
    detail: restored
      ? `${options.fixture.target_file} matches the pre-fix implementation.`
      : `${options.fixture.target_file} was not restored to the broken baseline.`,
  });

  return {
    scenario_id: 'success',
    status: steps.every(step => step.status === 'pass') ? 'pass' : 'fail',
    steps,
    run_dir: runDir,
    ...(executionMode !== undefined ? { execution_mode: executionMode } : {}),
  };
}

async function runVerifierFailScenario(options: {
  projectRoot: string;
  fixture: LiteTrustDemoFixture;
  env?: NodeJS.ProcessEnv;
  cliEntry?: string;
}): Promise<LiteTrustDemoScenarioResult> {
  const steps: LiteTrustDemoStep[] = [];
  let runDir: string | null = null;
  let executionMode: 'offline_demo' | undefined;
  const cliBase = {
    projectRoot: options.projectRoot,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
  };
  const targetPath = join(options.projectRoot, options.fixture.target_file);
  const wrongAnswer = options.fixture.mock_provider_answer ?? options.fixture.fixed_implementation;

  writeFileSync(targetPath, options.fixture.broken_implementation, 'utf8');

  const failFixCli = runBabelCli([
    'fix',
    '--json',
    '--provider',
    'mock',
    '--project-root',
    options.projectRoot,
    options.fixture.task,
  ], cliBase);
  const failPayload = failFixCli.payload;
  const failStatus = typeof failPayload?.['status'] === 'string' ? failPayload['status'] : null;
  const failExecutionMode = failPayload?.['execution_mode'];
  if (failExecutionMode === 'offline_demo') {
    executionMode = 'offline_demo';
  }
  runDir = typeof failPayload?.['run_dir'] === 'string' ? failPayload['run_dir'] : null;
  const failChecks = Array.isArray(failPayload?.['checks'])
    ? failPayload['checks'].filter((value): value is string => typeof value === 'string')
    : [];
  const verifierFailed = failFixCli.exitCode !== 0 &&
    failStatus !== 'FIX_COMPLETE' &&
    failChecks.some(check => check === `${options.fixture.verifier_command}: failed`);
  const mutationKept = readFileSync(targetPath, 'utf8') === wrongAnswer;
  steps.push({
    name: 'bl_fix_verifier_fail_keeps_mutation',
    status: verifierFailed && mutationKept ? 'pass' : 'fail',
    detail: verifierFailed && mutationKept
      ? 'Verifier failed and mutation was preserved (default behavior).'
      : `Expected verifier fail with preserved wrong answer; exit=${failFixCli.exitCode}, status=${String(failStatus)}.`,
  });

  writeFileSync(targetPath, options.fixture.broken_implementation, 'utf8');

  const rollbackCli = runBabelCli([
    'fix',
    '--json',
    '--provider',
    'mock',
    '--rollback-on-fail',
    '--project-root',
    options.projectRoot,
    options.fixture.task,
  ], cliBase);
  const rollbackPayload = rollbackCli.payload;
  const rollbackStatus = typeof rollbackPayload?.['status'] === 'string' ? rollbackPayload['status'] : null;
  const rollbackChecks = Array.isArray(rollbackPayload?.['checks'])
    ? rollbackPayload['checks'].filter((value): value is string => typeof value === 'string')
    : [];
  const rollbackRestored = readFileSync(targetPath, 'utf8') === options.fixture.broken_implementation;
  const rollbackPassed = rollbackCli.exitCode !== 0 &&
    rollbackStatus !== 'FIX_COMPLETE' &&
    rollbackChecks.some(check => check === 'rollback_on_fail: restored checkpoint') &&
    rollbackRestored;
  steps.push({
    name: 'bl_fix_rollback_on_fail',
    status: rollbackPassed ? 'pass' : 'fail',
    detail: rollbackPassed
      ? 'Verifier failed and --rollback-on-fail restored the pre-mutation checkpoint.'
      : `Expected rollback_on_fail restore; exit=${rollbackCli.exitCode}, status=${String(rollbackStatus)}, restored=${rollbackRestored}.`,
  });

  return {
    scenario_id: 'verifier_fail',
    status: steps.every(step => step.status === 'pass') ? 'pass' : 'fail',
    steps,
    run_dir: runDir,
    ...(executionMode !== undefined ? { execution_mode: executionMode } : {}),
  };
}

export async function runLiteTrustDemo(options: {
  projectRoot: string;
  fixturePath?: string;
  env?: NodeJS.ProcessEnv;
  cliEntry?: string;
}): Promise<LiteTrustDemoResult> {
  const successFixture = readLiteTrustDemoFixture(options.fixturePath ?? resolveLiteTrustDemoFixturePath());
  const verifierFailPath = join(fixtureDir(), 'scenarios', 'verifier-fail.json');
  const scenarios: LiteTrustDemoScenarioResult[] = [];

  scenarios.push(await runSuccessScenario({
    projectRoot: options.projectRoot,
    fixture: successFixture,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
  }));

  if (existsSync(verifierFailPath)) {
    const verifierFixture = readLiteTrustDemoFixture(verifierFailPath);
    const verifierRoot = join(options.projectRoot, 'verifier-fail');
    mkdirSync(join(verifierRoot, 'src'), { recursive: true });
    writeFileSync(join(verifierRoot, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: { test: 'node src/math.test.js' },
    }, null, 2), 'utf-8');
    writeFileSync(join(verifierRoot, verifierFixture.target_file), verifierFixture.broken_implementation, 'utf-8');
    writeFileSync(join(verifierRoot, 'src', 'math.test.js'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from './math.js';",
      '',
      "test('add sums two numbers', () => {",
      '  assert.equal(add(1, 2), 3);',
      '});',
      '',
    ].join('\n'), 'utf-8');
    scenarios.push(await runVerifierFailScenario({
      projectRoot: verifierRoot,
      fixture: verifierFixture,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
    }));
  }

  const steps = scenarios.flatMap(scenario => scenario.steps.map(step => ({
    ...step,
    name: `${scenario.scenario_id}:${step.name}`,
  })));
  const primary = scenarios[0];

  return {
    fixture_type: 'babel_lite_trust_demo',
    status: scenarios.every(scenario => scenario.status === 'pass') ? 'pass' : 'fail',
    steps,
    scenarios,
    run_dir: primary?.run_dir ?? null,
    ...(primary?.execution_mode !== undefined ? { execution_mode: primary.execution_mode } : {}),
  };
}

export function resolveLiteTrustDemoFixturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'fixtures', 'lite-trust-demo', 'scenario.json');
}
