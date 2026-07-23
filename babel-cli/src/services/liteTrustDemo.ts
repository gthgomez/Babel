import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
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

/** Absolute path to the babel-cli package root (contains package.json + dist/). */
export function babelCliPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Resolve the Node entry used by harness/spawn paths.
 *
 * Priority:
 * 1. `BABEL_CLI_ENTRY` absolute/relative path override (e.g. tsx-compiled entry)
 * 2. `babel-cli/dist/index.js` (default — requires build)
 */
export function resolveBabelCliEntry(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['BABEL_CLI_ENTRY']?.trim();
  if (override) {
    return resolve(override);
  }
  return join(babelCliPackageRoot(), 'dist', 'index.js');
}

/** Dist freshness / build-before-bench gate modes (P0.1–P0.2). */
export type BabelCliDistGateMode = 'off' | 'warn' | 'ensure' | 'fail';

export function resolveBabelCliDistGateMode(
  env: NodeJS.ProcessEnv = process.env,
  fallback: BabelCliDistGateMode = 'ensure',
): BabelCliDistGateMode {
  const raw = env['BABEL_CLI_DIST_GATE']?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return 'off';
  if (raw === 'warn') return 'warn';
  if (raw === 'fail' || raw === 'error' || raw === 'strict') return 'fail';
  if (raw === 'ensure' || raw === 'build' || raw === '1' || raw === 'true' || raw === 'yes') {
    return 'ensure';
  }
  return fallback;
}

export interface BabelCliDistFreshnessReport {
  packageRoot: string;
  distPath: string;
  distExists: boolean;
  distMtimeMs: number | null;
  newestSourceMtimeMs: number | null;
  newestSourcePath: string | null;
  isStale: boolean;
  reason: string;
}

const DIST_SOURCE_SCAN_ROOTS = ['src'] as const;
const DIST_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']);

function walkNewestSource(
  dir: string,
  packageRoot: string,
  acc: { mtimeMs: number; path: string } | null,
): { mtimeMs: number; path: string } | null {
  let best = acc;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return best;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) {
      continue;
    }
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      best = walkNewestSource(full, packageRoot, best);
      continue;
    }
    if (!st.isFile()) continue;
    const ext = name.includes('.') ? `.${name.split('.').pop()}` : '';
    if (!DIST_SOURCE_EXTENSIONS.has(ext.toLowerCase())) continue;
    // Skip unit tests — they do not affect dist runtime behavior.
    if (/\.test\.(ts|tsx|js|mjs|cjs)$/i.test(name)) continue;
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { mtimeMs: st.mtimeMs, path: relative(packageRoot, full).replace(/\\/g, '/') };
    }
  }
  return best;
}

/**
 * Compare `dist/index.js` mtime to newest non-test source under babel-cli/src.
 * Used so harness remeasures cannot silently run a stale build after source fixes.
 */
export function inspectBabelCliDistFreshness(
  packageRoot: string = babelCliPackageRoot(),
): BabelCliDistFreshnessReport {
  const distPath = join(packageRoot, 'dist', 'index.js');
  let distExists = false;
  let distMtimeMs: number | null = null;
  try {
    if (existsSync(distPath)) {
      distExists = true;
      distMtimeMs = statSync(distPath).mtimeMs;
    }
  } catch {
    distExists = false;
    distMtimeMs = null;
  }

  let newest: { mtimeMs: number; path: string } | null = null;
  for (const root of DIST_SOURCE_SCAN_ROOTS) {
    const abs = join(packageRoot, root);
    if (existsSync(abs)) {
      newest = walkNewestSource(abs, packageRoot, newest);
    }
  }

  if (!distExists) {
    return {
      packageRoot,
      distPath,
      distExists: false,
      distMtimeMs: null,
      newestSourceMtimeMs: newest?.mtimeMs ?? null,
      newestSourcePath: newest?.path ?? null,
      isStale: true,
      reason: `Missing dist entry at ${distPath}. Run npm run build in babel-cli/.`,
    };
  }

  if (newest && distMtimeMs !== null && newest.mtimeMs > distMtimeMs + 1000) {
    return {
      packageRoot,
      distPath,
      distExists: true,
      distMtimeMs,
      newestSourceMtimeMs: newest.mtimeMs,
      newestSourcePath: newest.path,
      isStale: true,
      reason:
        `Stale dist: source ${newest.path} is newer than dist/index.js. ` +
        `Harness spawns dist — rebuild with npm run build (or set BABEL_CLI_DIST_GATE=ensure).`,
    };
  }

  return {
    packageRoot,
    distPath,
    distExists: true,
    distMtimeMs,
    newestSourceMtimeMs: newest?.mtimeMs ?? null,
    newestSourcePath: newest?.path ?? null,
    isStale: false,
    reason: 'dist/index.js is present and not older than scanned sources',
  };
}

function runBabelCliPackageBuild(packageRoot: string): { ok: boolean; detail: string } {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: packageRoot,
    encoding: 'utf-8',
    shell: true,
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = String(result.stdout ?? '').trim();
  const stderr = String(result.stderr ?? '').trim();
  const detail = [stdout, stderr].filter(Boolean).join('\n').slice(0, 4000);
  if (result.status !== 0) {
    return {
      ok: false,
      detail: `npm run build failed (exit ${result.status}). ${detail || '(no output)'}`,
    };
  }
  if (!existsSync(join(packageRoot, 'dist', 'index.js'))) {
    return {
      ok: false,
      detail: `npm run build exited 0 but dist/index.js is still missing under ${packageRoot}`,
    };
  }
  return { ok: true, detail: detail || 'build ok' };
}

/**
 * Enforce build-before-bench for paths that spawn `dist/index.js`.
 *
 * Modes (`BABEL_CLI_DIST_GATE` or explicit option):
 * - `off` — no check
 * - `warn` — log stale/missing to stderr, continue
 * - `ensure` — auto `npm run build` when missing/stale (default for harness)
 * - `fail` — throw when missing/stale
 */
export function ensureBabelCliDistReady(options?: {
  packageRoot?: string;
  mode?: BabelCliDistGateMode;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}): BabelCliDistFreshnessReport {
  const env = options?.env ?? process.env;
  const packageRoot = options?.packageRoot ?? babelCliPackageRoot();
  const mode = options?.mode ?? resolveBabelCliDistGateMode(env, 'ensure');
  const log = options?.log ?? ((message: string) => process.stderr.write(`${message}\n`));

  // Entry override (e.g. direct tsx path) skips dist gate — caller owns freshness.
  if (env['BABEL_CLI_ENTRY']?.trim()) {
    const distPath = resolve(env['BABEL_CLI_ENTRY']!.trim());
    return {
      packageRoot,
      distPath,
      distExists: existsSync(distPath),
      distMtimeMs: null,
      newestSourceMtimeMs: null,
      newestSourcePath: null,
      isStale: false,
      reason: `BABEL_CLI_ENTRY override active (${distPath}); dist gate skipped`,
    };
  }

  if (mode === 'off') {
    return inspectBabelCliDistFreshness(packageRoot);
  }

  let report = inspectBabelCliDistFreshness(packageRoot);
  if (!report.isStale) {
    return report;
  }

  if (mode === 'warn') {
    log(`[babel] dist gate warn: ${report.reason}`);
    return report;
  }

  if (mode === 'fail') {
    throw new Error(`[babel] dist gate fail: ${report.reason}`);
  }

  // ensure
  log(`[babel] dist gate: ${report.reason} — running npm run build…`);
  const build = runBabelCliPackageBuild(packageRoot);
  if (!build.ok) {
    throw new Error(`[babel] dist gate ensure failed: ${build.detail}`);
  }
  report = inspectBabelCliDistFreshness(packageRoot);
  if (report.isStale) {
    throw new Error(
      `[babel] dist gate ensure: build finished but dist still stale/missing: ${report.reason}`,
    );
  }
  log('[babel] dist gate: build complete; dist is current');
  return report;
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
  return paths.filter((path) => existsSync(path));
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

/**
 * Parse CLI JSON stdout. Tries full-document parse, then last balanced `{…}`
 * object (P1.2: noisy logs / multi-line prefixes used to null whole payloads).
 */
export function parseCliJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to brace scan
  }

  // Find the last top-level JSON object in the stream (stdout may include banners).
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  let lastObject: string | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        lastObject = trimmed.slice(start, i + 1);
        start = -1;
      }
    }
  }
  if (lastObject) {
    try {
      const parsed = JSON.parse(lastObject) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export type ExtractedCriticReceipt = {
  verdict: string;
  reasons?: string[];
  confidence?: number;
  model?: string;
  tier?: string;
  skipped_reason?: string;
  source: 'payload' | 'stdout_json' | 'stream_regex';
};

/**
 * P1.2: recover critic_receipt when full CLI payload is null or partial.
 * Prefer structured payload; fall back to resilient JSON scan; then light regex.
 */
export function extractCriticReceiptFromCli(
  payload: Record<string, unknown> | null | undefined,
  stdout: string,
  stderr = '',
): ExtractedCriticReceipt | null {
  const fromObj = (obj: Record<string, unknown> | null | undefined, source: ExtractedCriticReceipt['source']) => {
    if (!obj) return null;
    const receipt = obj['critic_receipt'];
    if (receipt === null || typeof receipt !== 'object') return null;
    const r = receipt as Record<string, unknown>;
    const verdict = typeof r['verdict'] === 'string' ? r['verdict'] : null;
    if (!verdict) return null;
    return {
      verdict,
      ...(Array.isArray(r['reasons'])
        ? { reasons: r['reasons'].filter((x): x is string => typeof x === 'string') }
        : {}),
      ...(typeof r['confidence'] === 'number' ? { confidence: r['confidence'] } : {}),
      ...(typeof r['model'] === 'string' ? { model: r['model'] } : {}),
      ...(typeof r['tier'] === 'string' ? { tier: r['tier'] } : {}),
      ...(typeof r['skipped_reason'] === 'string'
        ? { skipped_reason: r['skipped_reason'] }
        : {}),
      source,
    } satisfies ExtractedCriticReceipt;
  };

  const fromPayload = fromObj(payload ?? null, 'payload');
  if (fromPayload) return fromPayload;

  const recovered = parseCliJson(stdout);
  const fromStdout = fromObj(recovered, 'stdout_json');
  if (fromStdout) return fromStdout;

  const blob = `${stdout}\n${stderr}`;
  const m =
    /"critic_receipt"\s*:\s*\{[^}]*"verdict"\s*:\s*"(pass|reject|skip)"/i.exec(blob) ||
    /critic[_\s]?verdict[=:][\s"]*(pass|reject|skip)/i.exec(blob);
  if (m?.[1]) {
    return { verdict: m[1].toLowerCase(), source: 'stream_regex' };
  }
  return null;
}

export function runBabelCli(
  args: string[],
  options: {
    projectRoot: string;
    env?: NodeJS.ProcessEnv;
    cliEntry?: string;
    offlineDemo?: boolean;
    cwd?: string;
    timeoutMs?: number;
    /**
     * When set, enforce P0 dist freshness before spawn.
     * Prefer harness paths set this to true/`ensure` so dirty source is not measured via stale dist.
     */
    ensureDist?: boolean | BabelCliDistGateMode;
  },
): CliInvocationResult {
  if (options.ensureDist !== undefined && options.ensureDist !== false) {
    const mode: BabelCliDistGateMode =
      options.ensureDist === true
        ? resolveBabelCliDistGateMode(process.env, 'ensure')
        : options.ensureDist;
    ensureBabelCliDistReady({ mode });
  }
  const cliEntry = options.cliEntry ?? resolveBabelCliEntry();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    BABEL_ROOT: process.env['BABEL_ROOT'] || BABEL_ROOT,
    BABEL_PROJECT_ROOT: options.projectRoot,
  };
  if (options.offlineDemo !== false) {
    env['BABEL_LITE_OFFLINE'] = '1';
    env['BABEL_SMALL_FIX_PROVIDER'] = 'mock';
  }
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: options.cwd ?? options.projectRoot,
    env,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    ...(typeof options.timeoutMs === 'number' ? { timeout: options.timeoutMs } : {}),
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const timedOut = result.error?.name === 'ETIMEDOUT';
  // Prefer stdout; if empty/noise, try stderr (some paths leak JSON there).
  const payload = parseCliJson(stdout) ?? parseCliJson(stderr);
  return {
    exitCode: timedOut ? 124 : (result.status ?? 1),
    stdout,
    stderr: timedOut
      ? `${stderr}\n[babel-cli] Process timed out after ${options.timeoutMs}ms`.trim()
      : stderr,
    payload,
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

  const fixCli = runBabelCli(
    [
      'daily',
      '--json',
      '--provider',
      'mock',
      '--project-root',
      options.projectRoot,
      options.fixture.task,
    ],
    cliBase,
  );

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
  const fixPassed =
    fixCli.exitCode === 0 &&
    fixStatus === 'FIX_COMPLETE' &&
    fixExecutionMode === 'offline_demo' &&
    fixChecks.some((check) => check === `${options.fixture.verifier_command}: passed`);
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

  const undoCli = runBabelCli(['undo', '--json', '--project-root', options.projectRoot], cliBase);
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
    status: steps.every((step) => step.status === 'pass') ? 'pass' : 'fail',
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

  const failFixCli = runBabelCli(
    [
      'daily',
      '--json',
      '--provider',
      'mock',
      '--project-root',
      options.projectRoot,
      options.fixture.task,
    ],
    cliBase,
  );
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
  const verifierFailed =
    failFixCli.exitCode !== 0 &&
    failStatus !== 'FIX_COMPLETE' &&
    failChecks.some((check) => check === `${options.fixture.verifier_command}: failed`);
  const mutationKept = readFileSync(targetPath, 'utf8') === wrongAnswer;
  steps.push({
    name: 'bl_fix_verifier_fail_keeps_mutation',
    status: verifierFailed && mutationKept ? 'pass' : 'fail',
    detail:
      verifierFailed && mutationKept
        ? 'Verifier failed and mutation was preserved (default behavior).'
        : `Expected verifier fail with preserved wrong answer; exit=${failFixCli.exitCode}, status=${String(failStatus)}.`,
  });

  writeFileSync(targetPath, options.fixture.broken_implementation, 'utf8');

  const rollbackCli = runBabelCli(
    [
      'daily',
      '--json',
      '--provider',
      'mock',
      '--rollback-on-fail',
      '--project-root',
      options.projectRoot,
      options.fixture.task,
    ],
    cliBase,
  );
  const rollbackPayload = rollbackCli.payload;
  const rollbackStatus =
    typeof rollbackPayload?.['status'] === 'string' ? rollbackPayload['status'] : null;
  const rollbackChecks = Array.isArray(rollbackPayload?.['checks'])
    ? rollbackPayload['checks'].filter((value): value is string => typeof value === 'string')
    : [];
  const rollbackRestored =
    readFileSync(targetPath, 'utf8') === options.fixture.broken_implementation;
  const rollbackPassed =
    rollbackCli.exitCode !== 0 &&
    rollbackStatus !== 'FIX_COMPLETE' &&
    rollbackChecks.some((check) => check === 'rollback_on_fail: restored checkpoint') &&
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
    status: steps.every((step) => step.status === 'pass') ? 'pass' : 'fail',
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
  const successFixture = readLiteTrustDemoFixture(
    options.fixturePath ?? resolveLiteTrustDemoFixturePath(),
  );
  const verifierFailPath = join(fixtureDir(), 'scenarios', 'verifier-fail.json');
  const scenarios: LiteTrustDemoScenarioResult[] = [];

  scenarios.push(
    await runSuccessScenario({
      projectRoot: options.projectRoot,
      fixture: successFixture,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
    }),
  );

  if (existsSync(verifierFailPath)) {
    const verifierFixture = readLiteTrustDemoFixture(verifierFailPath);
    const verifierRoot = join(options.projectRoot, 'verifier-fail');
    mkdirSync(join(verifierRoot, 'src'), { recursive: true });
    writeFileSync(
      join(verifierRoot, 'package.json'),
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
    writeFileSync(
      join(verifierRoot, verifierFixture.target_file),
      verifierFixture.broken_implementation,
      'utf-8',
    );
    writeFileSync(
      join(verifierRoot, 'src', 'math.test.js'),
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
    scenarios.push(
      await runVerifierFailScenario({
        projectRoot: verifierRoot,
        fixture: verifierFixture,
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.cliEntry !== undefined ? { cliEntry: options.cliEntry } : {}),
      }),
    );
  }

  const steps = scenarios.flatMap((scenario) =>
    scenario.steps.map((step) => ({
      ...step,
      name: `${scenario.scenario_id}:${step.name}`,
    })),
  );
  const primary = scenarios[0];

  return {
    fixture_type: 'babel_lite_trust_demo',
    status: scenarios.every((scenario) => scenario.status === 'pass') ? 'pass' : 'fail',
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
