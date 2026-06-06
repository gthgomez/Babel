import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ToolCallLog } from '../schemas/agentContracts.js';

export type RuntimeVerificationStatus =
  | 'PASS'
  | 'FAIL'
  | 'TOOL_UNAVAILABLE'
  | 'SKIPPED_WITH_REASON';

export type RuntimeVerificationTargetType = 'godot' | 'unknown';

export interface RuntimeVerificationResult {
  stage: 'runtime_verification';
  targetType: RuntimeVerificationTargetType;
  projectPath: string | null;
  command: string | null;
  cwd: string | null;
  exitCode: number | null;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  durationMs: number;
  detectedErrors: string[];
  status: RuntimeVerificationStatus;
  reason: string;
  timestamp: string;
}

export interface RuntimeVerificationRunnerInput {
  rawTask: string;
  projectRoot: string | null;
  toolCallLog: readonly ToolCallLog[];
  babelRoot?: string;
  now?: () => Date;
  commandRunner?: (command: string, args: string[], options: { cwd: string; timeoutMs: number }) => SpawnSyncReturns<string>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_BABEL_ROOT = process.env['BABEL_ROOT'] ?? resolve(__dirname, '../..');
const DEFAULT_GODOT_TIMEOUT_MS = 120_000;
const MAX_EXCERPT_LENGTH = 4_000;

const GODOT_FAILURE_PATTERNS = [
  /\bparse error\b/i,
  /\bError parsing\b/i,
  /\bFailed loading resource\b/i,
  /\bCan'?t open file\b/i,
  /\bresource_format_text\.cpp\b/i,
  /\bproject\.godot\b/i,
  /\bMain\.tscn\b/i,
  /\bInvalid\/corrupt scene\b/i,
  /\bScript error\b/i,
  /\bResource not found\b/i,
  /\bFile might be corrupted\b/i,
  /\bCouldn't load\b/i,
] as const;

function excerpt(text: string): string {
  if (text.length <= MAX_EXCERPT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_EXCERPT_LENGTH)}\n[truncated ${text.length - MAX_EXCERPT_LENGTH} chars]`;
}

function hasGodotTaskSignal(rawTask: string): boolean {
  return /\bgodot\b/i.test(rawTask) &&
    /\b(?:game|mobile|android|prototype|app|gdscript|project\.godot)\b/i.test(rawTask);
}

function hasGodotToolEvidence(toolCallLog: readonly ToolCallLog[]): boolean {
  return toolCallLog.some(entry => {
    const target = String(entry.target ?? '');
    return /(?:^|[\\/])project\.godot$/i.test(target) ||
      /\.(?:tscn|gd)$/i.test(target) ||
      /export_presets\.cfg$/i.test(target);
  });
}

export function detectRuntimeVerificationTargetType(input: Pick<RuntimeVerificationRunnerInput, 'rawTask' | 'projectRoot' | 'toolCallLog'>): RuntimeVerificationTargetType {
  if (hasGodotTaskSignal(input.rawTask)) {
    return 'godot';
  }
  if (input.projectRoot && existsSync(join(input.projectRoot, 'project.godot'))) {
    return 'godot';
  }
  if (hasGodotToolEvidence(input.toolCallLog)) {
    return 'godot';
  }
  return 'unknown';
}

function workspaceRootFromBabelRoot(babelRoot: string): string {
  return resolve(babelRoot, '..');
}

function resolveGodotWrapperPath(babelRoot: string): string | null {
  const configured = process.env['BABEL_GODOT_COMMAND']?.trim();
  if (configured && existsSync(configured)) {
    return configured;
  }

  const workspaceRoot = workspaceRootFromBabelRoot(babelRoot);
  const workspaceWrapper = join(workspaceRoot, 'tools', 'Godot', 'godot.ps1');
  if (existsSync(workspaceWrapper)) {
    return workspaceWrapper;
  }

  return null;
}

function buildGodotCommand(wrapperPath: string, projectPath: string): { command: string; args: string[]; display: string } {
  const command = process.env['BABEL_GODOT_POWERSHELL']?.trim() || 'powershell';
  const args = [
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    wrapperPath,
    '--headless',
    '--path',
    projectPath,
    '--quit',
  ];
  return {
    command,
    args,
    display: `${command} ${args.map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ')}`,
  };
}

export function detectGodotFailureLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => GODOT_FAILURE_PATTERNS.some(pattern => pattern.test(line)))
    .slice(0, 16);
}

function skippedResult(reason: string, timestamp: string): RuntimeVerificationResult {
  return {
    stage: 'runtime_verification',
    targetType: 'unknown',
    projectPath: null,
    command: null,
    cwd: null,
    exitCode: null,
    stdoutExcerpt: '',
    stderrExcerpt: '',
    durationMs: 0,
    detectedErrors: [],
    status: 'SKIPPED_WITH_REASON',
    reason,
    timestamp,
  };
}

function toolUnavailableResult(
  targetType: RuntimeVerificationTargetType,
  projectPath: string | null,
  reason: string,
  timestamp: string,
): RuntimeVerificationResult {
  return {
    stage: 'runtime_verification',
    targetType,
    projectPath,
    command: null,
    cwd: projectPath,
    exitCode: null,
    stdoutExcerpt: '',
    stderrExcerpt: '',
    durationMs: 0,
    detectedErrors: [],
    status: 'TOOL_UNAVAILABLE',
    reason,
    timestamp,
  };
}

export function runRuntimeVerification(input: RuntimeVerificationRunnerInput): RuntimeVerificationResult {
  const timestamp = (input.now ?? (() => new Date()))().toISOString();
  const targetType = detectRuntimeVerificationTargetType(input);
  if (targetType === 'unknown') {
    return skippedResult('No known runtime verification target type was detected.', timestamp);
  }

  if (!input.projectRoot) {
    return toolUnavailableResult(
      targetType,
      null,
      'Runtime verification for known Godot targets requires a resolved project root.',
      timestamp,
    );
  }

  const projectPath = resolve(input.projectRoot);
  const babelRoot = input.babelRoot ?? DEFAULT_BABEL_ROOT;
  const wrapperPath = resolveGodotWrapperPath(babelRoot);
  if (!wrapperPath) {
    return toolUnavailableResult(
      targetType,
      projectPath,
      `Godot wrapper unavailable. Expected ${join(workspaceRootFromBabelRoot(babelRoot), 'tools', 'Godot', 'godot.ps1')} or BABEL_GODOT_COMMAND.`,
      timestamp,
    );
  }

  const command = buildGodotCommand(wrapperPath, projectPath);
  const started = Date.now();
  const runner = input.commandRunner ?? ((cmd, args, options) => spawnSync(cmd, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    encoding: 'utf-8',
    windowsHide: true,
  }));

  const result = runner(command.command, command.args, {
    cwd: projectPath,
    timeoutMs: DEFAULT_GODOT_TIMEOUT_MS,
  });
  const durationMs = Date.now() - started;
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const combined = `${stdout}\n${stderr}`;
  const detectedErrors = detectGodotFailureLines(combined);
  const exitCode = typeof result.status === 'number' ? result.status : null;
  const spawnError = result.error ? String(result.error.message ?? result.error) : '';
  const status: RuntimeVerificationStatus = spawnError
    ? 'TOOL_UNAVAILABLE'
    : exitCode === 0 && detectedErrors.length === 0
      ? 'PASS'
      : 'FAIL';

  return {
    stage: 'runtime_verification',
    targetType,
    projectPath,
    command: command.display,
    cwd: projectPath,
    exitCode,
    stdoutExcerpt: excerpt(stdout),
    stderrExcerpt: excerpt(spawnError ? `${stderr}\n${spawnError}`.trim() : stderr),
    durationMs,
    detectedErrors,
    status,
    reason: status === 'PASS'
      ? 'Godot headless verification passed.'
      : status === 'TOOL_UNAVAILABLE'
        ? `Godot verification tool failed to launch: ${spawnError || 'unknown launch error'}`
        : detectedErrors.length > 0
          ? 'Godot headless verification output contained failure indicators.'
          : `Godot headless verification exited with code ${exitCode ?? 'unknown'}.`,
    timestamp,
  };
}
