import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  openSync,
  closeSync,
  constants as fsConstants,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';

import { renderDryRunSummary } from '../ui/renderers.js';
import { BABEL_ROOT, BABEL_RUNS_DIR, type ValidProject } from './constants.js';

export interface RuntimeFlagsFile {
  schemaVersion?: number;
  dryRun?: boolean;
  updatedAt?: string;
}

export interface DryRunState {
  persisted: boolean | null;
  sessionOverride: boolean | null;
  effective: boolean;
  runtimeFlagsPath: string;
  source: 'default' | 'persisted' | 'session';
}

export interface LatestRunPointer {
  run_dir: string;
  project: string;
  created_at: string;
  status?: string;
  target_root?: string;
  command?: string;
  evidence_complete?: boolean;
}

let stdoutTeeInstalled = false;

// ── Public API ───────────────────────────────────────────────────────────────

export function normalizeModelName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.trim().toLowerCase();
}

export function parseCommaSeparatedFiles(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// ── Project discovery (dynamic, convention-based) ────────────────────────────

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'CLAUDE.md',
  'AGENTS.md',
  'PROJECT_CONTEXT.md',
  'prompt_catalog.yaml',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'project.godot',
];

const FAMILY_DIRECTORIES = ['Project_SaaS', 'example_mobile_suite', 'example_game_suite'];

const PROJECT_NAME_ALIASES: Record<string, string> = {
  simlife: 'SimLife',
  godot_td: 'TowerDefenseGodot',
  aetherlyn: 'AetherlynGameDraft',
  app_test_babel: 'App-test-Babel',
};

function hasProjectMarker(dir: string): boolean {
  try {
    return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
  } catch {
    return false;
  }
}

function resolveCanonicalDirName(name: string): string {
  const lower = name.toLowerCase();
  for (const [alias, canonical] of Object.entries(PROJECT_NAME_ALIASES)) {
    if (alias.toLowerCase() === lower) return canonical;
  }
  return name;
}

/**
 * Scan workspace roots for a directory matching the given project name.
 * Replaces the old switch/case hardcoded map with dynamic filesystem scanning.
 */
export function resolveProjectRoot(projectName: string): string | null {
  if (!projectName || projectName.length === 0) return null;

  // If it's already an absolute path that exists, return it directly
  if (isAbsolute(projectName) && existsSync(projectName)) {
    return projectName;
  }

  const parent = dirname(BABEL_ROOT);
  const canonicalName = resolveCanonicalDirName(projectName);

  // Build scan list: family directories + workspace root
  const scanRoots: string[] = [];
  for (const family of FAMILY_DIRECTORIES) {
    const familyPath = join(parent, family);
    if (existsSync(familyPath)) {
      scanRoots.push(familyPath);
    }
  }
  scanRoots.push(parent);

  // Search for matching directory (case-insensitive)
  for (const scanRoot of scanRoots) {
    try {
      const entries = readdirSync(scanRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        const nameMatch =
          entry.name.toLowerCase() === projectName.toLowerCase() ||
          entry.name.toLowerCase() === canonicalName.toLowerCase();

        if (nameMatch) {
          const entryPath = join(scanRoot, entry.name);
          if (hasProjectMarker(entryPath) || existsSync(entryPath)) {
            return entryPath;
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Special case: app_test_babel has multiple fallback candidates
  if (projectName === 'app_test_babel') {
    for (const candidate of [
      join('example_mobile_suite', 'example_finance_forecast'),
      'App-test-Babel',
      'MonteCarlo-Ledger-app',
    ]) {
      const resolved = resolvePath(parent, candidate);
      if (existsSync(resolved)) return resolved;
    }
  }

  return null;
}

/**
 * Detect which workspace project the current working directory belongs to.
 * Walks up from cwd looking for project markers, then matches against
 * known workspace directories. Falls back to scanning parent directories.
 */
export function detectProjectFromCwd(cwd = process.cwd()): ValidProject | null {
  const resolvedCwd = resolvePath(cwd);

  // Strategy 1: Walk up looking for project markers
  let current = resolvedCwd;
  const st = (() => {
    try {
      return lstatSync(current);
    } catch {
      return null;
    }
  })();
  if (st !== null && !st.isDirectory()) {
    current = dirname(current);
  }

  while (true) {
    if (hasProjectMarker(current)) {
      return basename(current) as ValidProject;
    }

    const parentDir = dirname(current);
    if (parentDir === current) break; // Reached filesystem root

    // Stop at workspace root
    if (resolvePath(parentDir) === resolvePath(dirname(BABEL_ROOT))) {
      if (hasProjectMarker(parentDir)) {
        return basename(parentDir) as ValidProject;
      }
      break;
    }

    current = parentDir;
  }

  // Strategy 2: Scan workspace directories and check containment
  const workspaceRoot = dirname(BABEL_ROOT);
  const scanDirs = [
    workspaceRoot,
    ...FAMILY_DIRECTORIES.map((f) => join(workspaceRoot, f)).filter((d) => existsSync(d)),
  ];

  for (const scanDir of scanDirs) {
    try {
      const entries = readdirSync(scanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules')
          continue;
        const entryPath = join(scanDir, entry.name);
        const rel = relative(entryPath, resolvedCwd);
        if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
          return entry.name as ValidProject;
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function resolveLogFilePath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return resolvePath(value);
}

export function installStdoutTee(logFilePath: string): void {
  if (stdoutTeeInstalled) {
    return;
  }

  const logDir = dirname(logFilePath);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const appendChunk = (chunk: unknown): void => {
    const content = Buffer.isBuffer(chunk) ? chunk : String(chunk);
    appendFileSync(logFilePath, content);
  };

  const teeWrite = (originalWrite: typeof process.stdout.write): typeof process.stdout.write =>
    ((chunk: unknown, ...args: unknown[]) => {
      appendChunk(chunk);
      return originalWrite(chunk as never, ...(args as []));
    }) as typeof process.stdout.write;

  process.stdout.write = teeWrite(originalStdoutWrite);
  process.stderr.write = teeWrite(originalStderrWrite);
  stdoutTeeInstalled = true;
}

export async function withMutedConsole<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

export function readStdinFully(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => chunks.push(Buffer.from(chunk, 'utf8')));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

export function readClipboardPlanText(): string {
  if (process.platform !== 'win32') {
    throw new Error('Clipboard mode is only supported on Windows.');
  }

  const result = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], {
    encoding: 'utf8',
  });

  if (result.error) {
    throw new Error(`Clipboard read failed: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr?.trim() || 'Clipboard read failed.');
  }

  return result.stdout ?? '';
}

export function getRuntimeFlagsPath(): string {
  return join(BABEL_ROOT, 'config', 'runtime-flags.json');
}

export function readPersistedDryRunValue(runtimeFlagsPath: string): boolean | null {
  if (!existsSync(runtimeFlagsPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(runtimeFlagsPath, 'utf-8')) as RuntimeFlagsFile;
    return typeof parsed.dryRun === 'boolean' ? parsed.dryRun : null;
  } catch {
    return null;
  }
}

export function readDryRunState(): DryRunState {
  const runtimeFlagsPath = getRuntimeFlagsPath();
  const persisted = readPersistedDryRunValue(runtimeFlagsPath);
  const sessionOverrideRaw = process.env['BABEL_DRY_RUN'];
  const sessionSource = process.env['BABEL_DRY_RUN_SOURCE']?.trim().toLowerCase();
  const liveOverrideRaw = process.env['BABEL_LIVE']?.trim().toLowerCase();
  const liveOverride =
    liveOverrideRaw !== undefined && ['true', '1', 'yes', 'on'].includes(liveOverrideRaw)
      ? false
      : null;
  const sessionOverride =
    sessionSource === 'session' &&
    sessionOverrideRaw !== undefined &&
    sessionOverrideRaw.trim().length > 0
      ? sessionOverrideRaw.trim().toLowerCase() !== 'false'
      : null;

  return {
    persisted,
    sessionOverride: sessionOverride ?? liveOverride,
    effective: sessionOverride ?? liveOverride ?? persisted ?? true,
    runtimeFlagsPath,
    source:
      sessionOverride !== null || liveOverride !== null
        ? 'session'
        : persisted !== null
          ? 'persisted'
          : 'default',
  };
}

export function writeDryRunState(dryRun: boolean): DryRunState {
  const runtimeFlagsPath = getRuntimeFlagsPath();
  mkdirSync(dirname(runtimeFlagsPath), { recursive: true });
  writeFileSync(
    runtimeFlagsPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        dryRun,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  return readDryRunState();
}

export function printDryRunState(state: DryRunState, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  console.log(renderDryRunSummary(state));
}

export function readLatestRunPointer(project?: string): LatestRunPointer | null {
  const scoped = project ? join(BABEL_RUNS_DIR, `.latest.${project}.json`) : null;
  const fallback = join(BABEL_RUNS_DIR, '.latest.json');
  const candidates = scoped ? [scoped, fallback] : [fallback];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf-8')) as LatestRunPointer;
      if (
        typeof parsed.run_dir === 'string' &&
        parsed.run_dir.length > 0 &&
        existsSync(parsed.run_dir)
      ) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

export function copyFileToClipboard(promptPath: string): { ok: boolean; warning?: string } {
  if (process.platform !== 'win32') {
    return { ok: false, warning: 'Clipboard auto-copy is only supported on Windows.' };
  }

  const psCommand = `Set-Clipboard -Value (Get-Content -Raw '${escapePowerShellSingleQuoted(promptPath)}')`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', psCommand], {
    encoding: 'utf8',
  });
  if (result.error) {
    return { ok: false, warning: `Clipboard copy failed: ${result.error.message}` };
  }
  if ((result.status ?? 1) !== 0) {
    return { ok: false, warning: result.stderr?.trim() || 'Clipboard copy failed.' };
  }
  return { ok: true };
}

export function openPlanEditor(planPath: string): { editor: 'code' | 'notepad' } {
  const codeResult = spawnSync('code', ['--wait', planPath], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (!codeResult.error && (codeResult.status ?? 1) === 0) {
    return { editor: 'code' };
  }

  const notepadResult = spawnSync('notepad', [planPath], { stdio: 'inherit', windowsHide: true });
  if (notepadResult.error || (notepadResult.status ?? 0) !== 0) {
    throw new Error(
      `Editor launch failed. ` +
        `code error: ${codeResult.error?.message ?? codeResult.stderr?.toString() ?? 'unknown'}; ` +
        `notepad error: ${notepadResult.error?.message ?? notepadResult.stderr?.toString() ?? 'unknown'}`,
    );
  }
  return { editor: 'notepad' };
}

function readExecutionReport(runDir: string): Record<string, unknown> | null {
  const reportPath = join(runDir, '04_execution_report.json');
  try {
    return JSON.parse(readFileSync(reportPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractHaltTagFromExecutionReport(runDir: string): string {
  const report = readExecutionReport(runDir);
  if (!report) {
    return 'UNKNOWN';
  }
  if (report['status'] === 'EXECUTION_COMPLETE') {
    return 'NONE';
  }
  if (report['status'] === 'ACTIVATION_REFUSED') {
    return String(report['gate'] ?? 'ACTIVATION_GATE_FAIL');
  }
  const pipelineError = report['pipeline_error'] as Record<string, unknown> | undefined;
  return String(pipelineError?.['halt_tag'] ?? 'UNKNOWN');
}

export function extractStructuredDenialFromExecutionReport(
  runDir: string,
): Record<string, unknown> | null {
  const report = readExecutionReport(runDir);
  if (!report) {
    return null;
  }
  const toolCallLog = Array.isArray(report['tool_call_log'])
    ? (report['tool_call_log'] as Array<Record<string, unknown>>)
    : [];
  const lastToolOutput = toolCallLog.length > 0 ? toolCallLog[toolCallLog.length - 1] : null;
  const denial =
    lastToolOutput && typeof lastToolOutput === 'object' ? lastToolOutput['denial'] : null;
  return denial && typeof denial === 'object' ? (denial as Record<string, unknown>) : null;
}

export function extractMcpLifecycleFromExecutionReport(
  runDir: string,
): Record<string, unknown> | null {
  const report = readExecutionReport(runDir);
  if (!report) {
    return null;
  }
  const toolCallLog = Array.isArray(report['tool_call_log'])
    ? (report['tool_call_log'] as Array<Record<string, unknown>>)
    : [];
  const lastToolOutput = toolCallLog.length > 0 ? toolCallLog[toolCallLog.length - 1] : null;
  const lifecycle =
    lastToolOutput && typeof lastToolOutput === 'object' ? lastToolOutput['mcp_lifecycle'] : null;
  return lifecycle && typeof lifecycle === 'object' ? (lifecycle as Record<string, unknown>) : null;
}
