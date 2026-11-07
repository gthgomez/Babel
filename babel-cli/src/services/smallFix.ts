import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertPlannerPathsAllowed, loadPlanHandoff, scopedHandoffPath, type PlanHandoff } from '../agent/planHandoff.js';
import { extractExplicitFilePaths } from './liteFullRouter.js';
import { BABEL_ROOT } from '../cli/constants.js';
import { writeLatestRunPointers } from '../pipeline/runPointers.js';
import {
  beginLiteEvidenceSession,
  writeLiteManifest,
  writeLiteRequest,
} from '../agent/liteArtifacts.js';
import { findCheckpoint, restoreCheckpoint } from './checkpoints.js';
import { type ResolvedModelPolicy } from '../modelPolicy.js';
import {
  runFixDiscoveryPhase,
  shouldAttemptFixDiscovery,
  type FixDiscoveryBundle,
} from '../agent/lanes/fixDiscoveryLoop.js';
import { runCoordinatedSmallFixMutationLoop, runSmallFixMutationLoop, type CoordinatedSmallFixMutationResult } from '../agent/lanes/smallFixLoop.js';
import {
  detectMultiFileSmallFix,
  extractOnlyEditFile,
  isAmbiguousBroadRefactor,
  listSequentialFixTargets,
  resolveFixScopeFromDiscovery,
  type SmallFixScope,
} from './fixScopeResolver.js';
import { globalCostTracker, type SessionUsageSummary } from './costTracker.js';
import { buildCostLedger, usageSummaryFromCostLedger } from './costLedger.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';
import { buildVerifierContractArtifacts } from './requiredVerifierContract.js';
import { isHostIsolationEscalationAllowed } from '../config/benchmarkContainer.js';
import {
  classifySmallFixProviderFailure,
  liveProviderEnvKey,
  resolveSmallFixProvider,
  runSmallFixModel,
  type SmallFixAnswer,
  type SmallFixExecutionMode,
  type SmallFixOptions,
} from './smallFixProvider.js';
export type { SmallFixProvider } from './smallFixProvider.js';
export type { SmallFixExecutionMode } from './smallFixProvider.js';
export type { SmallFixOptions } from './smallFixProvider.js';
export { resolveSmallFixProvider } from './smallFixProvider.js';
export { classifySmallFixProviderFailure } from './smallFixProvider.js';

export class SmallFixRecoverableError extends Error {
  readonly runDir: string;
  readonly supportPath: string;
  readonly recoverable: boolean;
  readonly next: string[];
  readonly failureCode: string;
  readonly nextCommand: string;

  constructor(input: {
    message: string;
    runDir: string;
    failureCode: string;
    recoverable?: boolean;
    next?: string[];
  }) {
    super(input.message);
    this.name = 'SmallFixRecoverableError';
    this.runDir = input.runDir;
    this.supportPath = input.runDir;
    this.failureCode = input.failureCode;
    this.recoverable = input.recoverable ?? true;
    this.next = input.next ?? ['babel continue latest'];
    this.nextCommand = this.next[0] ?? 'babel continue latest';
  }
}

export const DEFAULT_SMALL_FIX_MAX_REPAIR_ATTEMPTS = 3;

export function resolveSmallFixMaxRepairAttempts(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env['BABEL_SMALL_FIX_MAX_REPAIR_ATTEMPTS'];
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 5) {
      return parsed;
    }
  }
  return DEFAULT_SMALL_FIX_MAX_REPAIR_ATTEMPTS;
}

export interface SmallFixRepairAttemptRecord {
  attempt: number;
  status: 'passed' | 'failed' | 'blocked' | 'write_failed' | 'cancelled';
  verifier_exit_code: number | null;
  verifier_stdout_summary: string | null;
  verifier_stderr_summary: string | null;
  changed_files: string[];
  write_outcome?: 'unknown';
}

export interface SmallFixDeclined {
  status: 'SMALL_FIX_NOT_APPLICABLE';
  reason: string;
}

export interface SmallFixCompleted {
  status: 'SMALL_FIX_COMPLETE' | 'SMALL_FIX_FAILED';
  task: string;
  project: string | null;
  projectRoot: string;
  targetFile: string;
  verifierCommand: string;
  runDir: string;
  scopePath: string;
  changedFiles: string[];
  writeOutcome?: 'unknown';
  cancelled?: true;
  retryable?: boolean;
  checks: string[];
  summary: string;
  usageSummary: SessionUsageSummary;
  modelPolicy?: ResolvedModelPolicy;
  executionMode?: SmallFixExecutionMode;
  sessionLoopSteps?: Array<{
    phase: string;
    status: 'pass' | 'fail' | 'blocked';
    policy_decision: string;
  }>;
}

export type SmallFixResult = SmallFixDeclined | SmallFixCompleted;

const LOCAL_VERIFIER_COMMANDS = [
  /^npm\s+test$/i,
  /^npm\s+run\s+test$/i,
  /^node\s+--test$/i,
  /^npx\s+tsx\s+[\w./\\-]+$/i,
];

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function hashText(value: string): string {
  return createHash('sha256')
    .update(normalizeText(value), 'utf-8')
    .digest('hex');
}

function byteLengthUtf8(value: string): number {
  return Buffer.byteLength(value, 'utf-8');
}

function buildChangesDiff(
  targetFile: string,
  before: string,
  after: string,
): string {
  const beforeLines = normalizeText(before).split('\n');
  const afterLines = normalizeText(after).split('\n');
  if (
    beforeLines.length === 1 &&
    beforeLines[0] === '' &&
    afterLines.length === 1 &&
    afterLines[0] === ''
  ) {
    return `diff --git a/${targetFile} b/${targetFile}\nNo changes in ${targetFile}\n`;
  }

  const lines = [
    `diff --git a/${targetFile} b/${targetFile}`,
    `--- a/${targetFile}`,
    `+++ b/${targetFile}`,
  ];
  const maxLines = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < maxLines; i += 1) {
    const beforeLine = beforeLines[i];
    const afterLine = afterLines[i];
    if (beforeLine === undefined) {
      lines.push(`+${afterLine}`);
    } else if (afterLine === undefined) {
      lines.push(`-${beforeLine}`);
    } else if (beforeLine === afterLine) {
      lines.push(` ${beforeLine}`);
    } else {
      lines.push(`-${beforeLine}`);
      lines.push(`+${afterLine}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function writeJsonArtifact(
  path: string,
  payload: Record<string, unknown>,
): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function safeSmallFixFile(root: string, path: string): string | null {
  try {
    const physicalRoot = realpathSync(root);
    const expected = resolve(physicalRoot, path);
    const physical = scopedHandoffPath(physicalRoot, path);
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!physical || normalize(physical) !== normalize(expected)) return null;
    const stat = lstatSync(expected);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) return null;
    return expected;
  } catch { return null; }
}

function extractVerifierCommand(task: string): string | null {
  const explicit = task.match(
    /\brun\s+([A-Za-z0-9_.\-\\/]+(?:\s+[A-Za-z0-9_.\-\\/]+){0,3})\s+before\s+(?:completing|completion|finishing)/i,
  );
  const candidate = explicit?.[1]?.trim().replace(/[.。]+$/, '');
  if (
    candidate &&
    LOCAL_VERIFIER_COMMANDS.some((pattern) => pattern.test(candidate))
  ) {
    return candidate;
  }
  if (
    /\bfailing\s+(?:node\s+)?test\b/i.test(task) &&
    /\bnpm\s+test\b/i.test(task)
  ) {
    return 'npm test';
  }
  return null;
}

function readPackageTestCommand(projectRoot: string): string | null {
  return readPackageScript(projectRoot, 'test') !== null ? 'npm test' : null;
}

function readPackageScript(projectRoot: string, name: string): string | null {
  const packageJsonPath = safeSmallFixFile(projectRoot, 'package.json');
  if (!packageJsonPath) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    return typeof parsed.scripts?.[name] === 'string' ? parsed.scripts[name] : null;
  } catch {
    return null;
  }
}

/**
 * Recognized read-only verification runners. A Plan-bound fix may execute
 * these; arbitrary scripts (which can write outside the selected scope) are
 * refused before provider dispatch.
 */
const PLAN_BOUND_VERIFIER_RE = [
  /^node\s+--test(?:\s|$)/,
  /^(?:npx\s+)?(?:vitest|jest)\b/,
  /^(?:python\d?\s+-m\s+)?pytest\b/,
  /^cargo\s+test\b/,
  /^go\s+test\b/,
  /^dotnet\s+test\b/,
  /^(?:mvn|gradlew?|gradle)\b.*\btest\b/,
  /^tsc\b.*--noEmit\b/,
  /^(?:npx\s+)?(?:eslint|ruff)\b/,
];

function planBoundVerifierQualified(projectRoot: string, command: string, depth = 0): boolean {
  if (depth > 4) return false;
  const trimmed = command.trim();
  const npm = /^npm\s+(?:run\s+)?([A-Za-z0-9:_-]+)(?:\s+--\s+.*)?$/.exec(trimmed);
  if (npm) {
    const script = readPackageScript(projectRoot, npm[1]!);
    return script !== null && planBoundVerifierQualified(projectRoot, script, depth + 1);
  }
  return PLAN_BOUND_VERIFIER_RE.some((pattern) => pattern.test(trimmed));
}

function collectCandidateFiles(
  projectRoot: string,
  dir = projectRoot,
  depth = 0,
): string[] {
  if (depth > 4 || !existsSync(dir)) {
    return [];
  }
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === 'dist' ||
      entry.name === 'coverage'
    ) {
      continue;
    }
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectCandidateFiles(projectRoot, abs, depth + 1));
      continue;
    }
    if (entry.isFile() && /\.(?:m?[jt]s|cjs|tsx|jsx)$/i.test(entry.name)) {
      results.push(normalizeRelativePath(relative(projectRoot, abs)));
    }
  }
  return results;
}

function taskDescriptor(task: string): string | null {
  const normalized = task.toLowerCase();
  const match =
    normalized.match(/\bfailing\s+([a-z0-9_-]+)\s+test\b/) ??
    normalized.match(/\bfix\s+the\s+([a-z0-9_-]+)\s+test\b/);
  return match?.[1] ?? null;
}

function sourceForTestFile(
  projectRoot: string,
  testFile: string,
): string | null {
  const candidates = [
    testFile.replace(/(?:\.test|\.spec)(\.[^.]+)$/i, '$1'),
    testFile
      .replace(/__tests__\//i, '')
      .replace(/(?:\.test|\.spec)(\.[^.]+)$/i, '$1'),
  ].filter((candidate) => candidate !== testFile);
  for (const candidate of candidates) {
    if (existsSync(resolve(projectRoot, candidate))) {
      return normalizeRelativePath(candidate);
    }
  }
  return null;
}

function inferTargetFile(task: string, projectRoot: string): string | null {
  const explicit = extractOnlyEditFile(task);
  if (explicit) {
    return explicit;
  }

  const normalized = task.toLowerCase();
  if (
    !/\b(fix|repair)\b/.test(normalized) ||
    !/\b(failing|failed|broken)\b/.test(normalized) ||
    !/\btests?\b/.test(normalized)
  ) {
    return null;
  }

  const descriptor = taskDescriptor(task);
  const files = collectCandidateFiles(projectRoot);
  const testFiles = files.filter((file) =>
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file),
  );
  const candidates = new Set<string>();

  if (descriptor) {
    for (const file of files) {
      const base = basename(file)
        .replace(/\.[^.]+$/, '')
        .toLowerCase();
      if (
        base === descriptor.toLowerCase() &&
        !/\.(?:test|spec)$/i.test(base)
      ) {
        candidates.add(file);
      }
    }
  }

  for (const testFile of testFiles) {
    const base = basename(testFile).toLowerCase();
    if (descriptor && !base.includes(descriptor.toLowerCase())) {
      continue;
    }
    const source = sourceForTestFile(projectRoot, testFile);
    if (source) {
      candidates.add(source);
    }
  }

  return candidates.size === 1 ? [...candidates][0]! : null;
}

export type { SmallFixScope } from './fixScopeResolver.js';

function isTestLikePath(path: string): boolean {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path) ||
    /(?:^|\/)tests?\//i.test(path)
  );
}

function detectDualFileSmallFix(
  task: string,
  projectRoot: string,
): SmallFixScope | null {
  const explicitPaths = extractExplicitFilePaths(task)
    .map((path) => normalizeRelativePath(path))
    .filter((path) => {
      const absolutePath = resolve(projectRoot, path);
      return (
        isInsideRoot(projectRoot, absolutePath) && existsSync(absolutePath)
      );
    });

  if (explicitPaths.length < 2) {
    return null;
  }

  const testFiles = explicitPaths.filter(isTestLikePath);
  const sourceFiles = explicitPaths.filter((path) => !isTestLikePath(path));
  if (testFiles.length !== 1 || sourceFiles.length !== 1) {
    return null;
  }

  const verifierCommand =
    extractVerifierCommand(task) ?? 'npm --prefix ./babel-cli run typecheck';
  return {
    mode: 'dual',
    sourceFile: sourceFiles[0]!,
    testFile: testFiles[0]!,
    verifierCommand,
    projectRoot,
  };
}

export function detectSmallFix(
  options: Pick<SmallFixOptions, 'task' | 'projectRoot' | 'forcedTargetFile'>,
): SmallFixScope | null {
  if (!options.projectRoot) {
    return null;
  }
  const projectRoot = resolve(options.projectRoot);
  if (!options.forcedTargetFile) {
    const multi = detectMultiFileSmallFix(options.task, projectRoot);
    if (multi) {
      return multi;
    }
  }
  if (options.forcedTargetFile) {
    const targetFile = normalizeRelativePath(options.forcedTargetFile);
    const verifierCommand =
      extractVerifierCommand(options.task) ??
      readPackageTestCommand(projectRoot);
    if (!verifierCommand) {
      return null;
    }
    const absoluteTarget = resolve(projectRoot, targetFile);
    if (
      !isInsideRoot(projectRoot, absoluteTarget) ||
      !existsSync(absoluteTarget)
    ) {
      return null;
    }
    return { mode: 'single', targetFile, verifierCommand, projectRoot };
  }
  const dual = detectDualFileSmallFix(options.task, projectRoot);
  if (dual) {
    return dual;
  }

  const targetFile = inferTargetFile(options.task, projectRoot);
  const verifierCommand =
    extractVerifierCommand(options.task) ?? readPackageTestCommand(projectRoot);
  if (!targetFile || !verifierCommand) {
    return null;
  }
  const absoluteTarget = resolve(projectRoot, targetFile);
  if (
    !isInsideRoot(projectRoot, absoluteTarget) ||
    !existsSync(absoluteTarget)
  ) {
    return null;
  }
  return { mode: 'single', targetFile, verifierCommand, projectRoot };
}

function trimForPrompt(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n...[truncated]`;
}

function readNearbyTests(projectRoot: string, targetFile: string): string {
  const absTarget = resolve(projectRoot, targetFile);
  const dir = dirname(absTarget);
  const base = basename(targetFile).replace(/\.[^.]+$/, '');
  const snippets: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    if (
      !/\.(test|spec)\.[cm]?[jt]s$/i.test(entry.name) &&
      !entry.name.includes(`${base}.test`)
    ) {
      continue;
    }
    const abs = join(dir, entry.name);
    const rel = normalizeRelativePath(relative(projectRoot, abs));
    const safe = safeSmallFixFile(projectRoot, rel);
    if (!safe) continue;
    snippets.push(
      `## ${rel}\n${trimForPrompt(readFileSync(safe, 'utf-8'), 4000)}`,
    );
  }
  return snippets.length > 0
    ? snippets.join('\n\n')
    : 'No nearby test files were found.';
}

function buildPrompt(input: {
  task: string;
  projectRoot: string;
  targetFile: string;
  verifierCommand: string;
  planHandoff?: PlanHandoff | null;
  discoveryObservations?: string;
}): string {
  const absTarget = safeSmallFixFile(input.projectRoot, input.targetFile);
  if (!absTarget) throw new Error('Small-fix target is unsafe or unavailable.');
  const packageJson = safeSmallFixFile(input.projectRoot, 'package.json');
  return [
    '# Babel Small Fix',
    '',
    'You are applying a bounded one-file code fix. Return JSON only.',
    'Rules:',
    `- Only change ${input.targetFile}.`,
    `- The verifier command is: ${input.verifierCommand}.`,
    '- Preserve public APIs unless the task explicitly requires otherwise.',
    '- Do not include markdown fences.',
    '- Use only file paths grounded in the approved plan handoff or target file context.',
    '',
    'Return exactly:',
    '{"schema_version":1,"summary":"what changed","replacement_content":"entire new file content","confidence":"high"}',
    '',
    `Task: ${input.task}`,
    '',
    ...(input.discoveryObservations
      ? ['# Runtime Discovery Observations', input.discoveryObservations, '']
      : []),
    ...(input.planHandoff ? [input.planHandoff.contextText, ''] : []),
    `# Target file: ${input.targetFile}`,
    trimForPrompt(readFileSync(absTarget, 'utf-8'), 7000),
    '',
    '# Nearby tests',
    input.planHandoff ? 'Supplemental reads are limited to the Plan handoff.' : readNearbyTests(input.projectRoot, input.targetFile),
    '',
    '# package.json',
    input.planHandoff ? 'Supplemental reads are limited to the Plan handoff.' : packageJson
      ? trimForPrompt(readFileSync(packageJson, 'utf-8'), 2000)
      : 'No package.json found.',
  ].join('\n');
}

function buildRepairPrompt(input: {
  task: string;
  projectRoot: string;
  targetFile: string;
  verifierCommand: string;
  attempt: number;
  maxAttempts: number;
  verifierExitCode: number;
  verifierStdout: string;
  verifierStderr: string;
  currentFileContent: string;
  planHandoff?: PlanHandoff | null;
  discoveryObservations?: string;
}): string {
  const verifierOutput =
    [input.verifierStdout.trim(), input.verifierStderr.trim()]
      .filter(Boolean)
      .join('\n')
      .trim() || '(no verifier output captured)';
  return [
    '# Babel Small Fix — Repair Attempt',
    '',
    'The previous patch failed verification. Return JSON only with a corrected full-file replacement.',
    'Rules:',
    `- Only change ${input.targetFile}.`,
    `- The verifier command is: ${input.verifierCommand}.`,
    `- Repair attempt ${input.attempt} of ${input.maxAttempts}.`,
    '- Fix the failure shown below; do not include markdown fences.',
    '',
    'Return exactly:',
    '{"schema_version":1,"summary":"what changed","replacement_content":"entire new file content","confidence":"high"}',
    '',
    `Task: ${input.task}`,
    '',
    ...(input.discoveryObservations
      ? ['# Runtime Discovery Observations', input.discoveryObservations, '']
      : []),
    ...(input.planHandoff ? [input.planHandoff.contextText, ''] : []),
    `# Verifier failure (exit ${input.verifierExitCode})`,
    trimForPrompt(verifierOutput, 5000),
    '',
    `# Current file: ${input.targetFile}`,
    trimForPrompt(input.currentFileContent, 7000),
    '',
    '# Nearby tests',
    input.planHandoff ? 'Supplemental reads are limited to the Plan handoff.' : readNearbyTests(input.projectRoot, input.targetFile),
  ].join('\n');
}

function makeRecoverableRunError(
  message: string,
  runDir: string,
  failureCode: string,
  next?: string[],
): SmallFixRecoverableError {
  return new SmallFixRecoverableError({
    message,
    runDir,
    failureCode,
    ...(next !== undefined ? { next } : {}),
  });
}

export async function runSmallFixPath(
  options: SmallFixOptions,
): Promise<SmallFixResult> {
  if (options.signal?.aborted) throw new DOMException('Small-fix cancelled before start.', 'AbortError');
  if (isAmbiguousBroadRefactor(options.task)) {
    return {
      status: 'SMALL_FIX_NOT_APPLICABLE',
      reason:
        "Broad refactor tasks are not supported in the fix lane. Please specify the target files you wish to edit, or use the 'deep' lane for governed planning.",
    };
  }

  if (options.planHandoff) throw new Error('A supplied plan handoff is unsafe; use an explicit Plan ID resolved for this project.');
  const planHandoff =
    (options.projectRoot && options.planRunId
      ? loadPlanHandoff({
          repoPath: options.projectRoot,
          task: options.task,
          planRunId: options.planRunId,
        })
      : null);
  if (options.planRunId && (!planHandoff || planHandoff.planRunId !== options.planRunId)) {
    throw new Error('The saved plan source is unavailable or unsafe; inspect the retained plan before applying.');
  }
  if (options.planRunId && !planHandoff?.contract) throw new Error('The saved plan contract is missing or unavailable; inspect the retained artifact and create a fresh plan.');
  if (planHandoff && !extractVerifierCommand(options.task)) throw new Error('The Plan-bound fix requires an explicit verifier before resolving its scope.');
  let detected = detectSmallFix(options);
  let discoveryBundle: FixDiscoveryBundle | null = null;

  if (planHandoff && !detected) throw new Error('The target is outside a deterministically resolved Plan scope; inspect the retained Plan and specify an in-scope target and verifier.');
  if (planHandoff && detected && assertPlannerPathsAllowed(listSequentialFixTargets(detected), planHandoff.allowedPaths).length > 0) {
    throw new Error('The target is outside the selected Plan scope; inspect the retained Plan before continuing.');
  }
  if (planHandoff && detected) {
    const root = realpathSync(detected.projectRoot);
    const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
    for (const target of listSequentialFixTargets(detected)) {
      const expected = resolve(root, target);
      const stat = lstatSync(expected);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || normalize(realpathSync(expected)) !== normalize(expected)) {
        throw new Error('The Plan target is unsafe; inspect the retained Plan and target before continuing.');
      }
    }
    if (!planBoundVerifierQualified(root, detected.verifierCommand)) {
      throw new Error('Plan-bound small-fix mutation is temporarily unavailable until verifier effects are scoped; the Plan is retained.');
    }
  }

  if (!detected && shouldAttemptFixDiscovery(options)) {
    options.progress?.report('scoped', 'Discovering fix scope…');
    discoveryBundle = await runFixDiscoveryPhase(options, (discovery) =>
      resolveFixScopeFromDiscovery({
        task: options.task,
        projectRoot: resolve(options.projectRoot!),
        observations: discovery.observations,
        toolCallLog: discovery.toolCallLog,
      }),
    );
    detected = discoveryBundle?.scope ?? null;
    if (detected) {
      const scopedLabel = listSequentialFixTargets(detected).join(', ');
      options.progress?.report('scoped', `${scopedLabel} (discovery)`);
    }
  }

  if (!detected) {
    return {
      status: 'SMALL_FIX_NOT_APPLICABLE',
      reason: discoveryBundle
        ? 'Fix discovery could not resolve a scoped target file and verifier command.'
        : 'Task is not an explicit one-file or multi-file scoped fix with a local verifier command.',
    };
  }

  const checkedProjectRoot = detected.projectRoot;
  if (listSequentialFixTargets(detected).some(target => !safeSmallFixFile(checkedProjectRoot, target))) {
    throw new Error('Small-fix target is unsafe or unavailable; inspect its physical path before continuing.');
  }

  if (
    (detected.mode === 'dual' || detected.mode === 'multi') &&
    !options.forcedTargetFile
  ) {
    const targets = listSequentialFixTargets(detected);
    const verifierCommand = detected.verifierCommand;

    const { run: liteRun, evidence } = beginLiteEvidenceSession({
      command: 'fix',
      repoPath: detected.projectRoot,
    });
    options.progress?.bindRunDir(evidence.runDir);
    options.progress?.report(
      'scoped',
      `Coordinated fix for: ${targets.join(', ')} (${verifierCommand})`,
    );

    // Write request log
    writeLiteRequest(liteRun, {
      schema_version: 1,
      command: 'fix',
      task: options.task,
      project: options.project ?? null,
      project_root: detected.projectRoot,
      target_files: targets,
      verifier_command: verifierCommand,
      ...(planHandoff ? { plan_handoff_run_id: planHandoff.planRunId } : {}),
    });

    globalCostTracker.resetSession();

    // Capture preimages for comparison; this does not itself create a restorable checkpoint.
    const originalContents = new Map<string, string>();
    const originalHashes = new Map<string, string>();

    for (const file of targets) {
      const filePath = resolve(detected.projectRoot, file);
      const content = existsSync(filePath)
        ? readFileSync(filePath, 'utf-8')
        : '';
      originalContents.set(file, content);
      originalHashes.set(file, hashText(content));
    }

    const scopePath = join(evidence.runDir, 'small_fix_scope.json');
    evidence.writeDebugFile(
      'small_fix_scope.json',
      `${JSON.stringify(
        {
          schema_version: 1,
          selected_lane: 'small_fix',
          task: options.task,
          files_to_edit: targets,
          checks_to_run: [verifierCommand],
          inference: 'multi_file_coordinated_scope',
        },
        null,
        2,
      )}\n`,
    );

    const scopeBeforePath = join(
      evidence.runDir,
      'small_fix_scope_before.json',
    );
    writeJsonArtifact(scopeBeforePath, {
      schema_version: 1,
      scope_artifact_type: 'small_fix_scope_before_mutation',
      target_files: targets,
      project_root: detected.projectRoot,
      inferred_scope: 'multi_file_coordinated_scope',
      normalized: true,
      next_step_hint:
        'inspect retained changes and evidence after verification',
    });

    // 1. Initial Mutation Loop: edit each file sequentially (without running verifier between edits)
    const currentContents = new Map<string, string>(originalContents);
    let modelPolicy: ResolvedModelPolicy | undefined;
    let executionMode: SmallFixExecutionMode = 'live';
    let lastSummary = 'Multi-file fix applied';

    try {
      for (const targetFile of targets) {
        if (options.signal?.aborted) throw new DOMException('Small-fix cancelled.', 'AbortError');
        options.progress?.report('model', `Calling model for ${targetFile}…`);
        const prompt = buildPrompt({
          task: options.task,
          projectRoot: detected.projectRoot,
          targetFile,
          verifierCommand,
          planHandoff,
          ...(discoveryBundle?.discovery.observations
            ? { discoveryObservations: discoveryBundle.discovery.observations }
            : {}),
        });

        const modelResult = await runSmallFixModel(prompt, evidence, options, {
          targetFile,
        });
        if (options.signal?.aborted) throw new DOMException('Small-fix cancelled.', 'AbortError');
        currentContents.set(targetFile, modelResult.answer.replacement_content);
        if (modelResult.modelPolicy) {
          modelPolicy = modelResult.modelPolicy;
        }
        if (modelResult.executionMode) {
          executionMode = modelResult.executionMode;
        }
        lastSummary = modelResult.answer.summary;

        // Gather all proposals before admitting any mutation.
      }
    } catch (error: unknown) {
      options.progress?.finish('fail', 'Model call failed');
      const classified = classifySmallFixProviderFailure(
        error,
        resolveSmallFixProvider(options) === 'live' ? 'openrouter' : undefined,
      );
      const message = classified.message;
      const failureCode = classified.failureCode;
      const failureCapsulePath = join(
        evidence.runDir,
        'small_fix_failure_capsule.json',
      );
      evidence.writeDebugFile(
        'small_fix_failure_capsule.json',
        `${JSON.stringify(
          {
            schema_version: 1,
            failure_capsule_id: `small_fix_${evidence.runId}`,
            category: failureCode,
            failure_code: failureCode,
            retryable: options.signal?.aborted !== true && failureCode !== 'provider_authentication_failed',
            recoverable: true,
            next: classified.next,
            condition: message,
            task: options.task,
            project_root: detected.projectRoot,
            target_file: targets[0],
            verifier_command: verifierCommand,
            credential_env_key:
              failureCode === 'credential_missing'
                ? liveProviderEnvKey(
                    /OPENROUTER_API_KEY/i.test(message)
                      ? 'openrouter'
                      : undefined,
                  )
                : null,
            next_recommended_operator_action: classified.next.join('; '),
          },
          null,
          2,
        )}\n`,
      );
      evidence.writeExecutionLog({
        status: 'EXECUTION_HALTED',
        stage_status: 'SMALL_FIX_PROVIDER_FAILED',
        steps_executed: 0,
        tool_call_log: [],
        pipeline_error: {
          halt_tag: 'TOOL_CALL_ERROR',
          halted_at_step: 1,
          condition: message,
        },
      });
      evidence.writeDebugFile(
        'terminal_status_summary.json',
        `${JSON.stringify(
          {
            schema_version: 1,
            artifact_type: 'babel_terminal_status_summary',
            status: 'SMALL_FIX_FAILED',
            reason_category: failureCode,
            failed_command: 'small_fix_model',
            changed_files: [],
            change_disposition: 'none',
            rollback_mode: 'none',
            failure_capsule_path: failureCapsulePath,
            next_recommended_operator_action: classified.next.join('; '),
            parseable_json_stdout_required: true,
            attempt_safety_summary_path: null,
            repair_attempt_timeline_path: null,
            condition_summary: message,
            verifier_contract: null,
          },
          null,
          2,
        )}\n`,
      );
      evidence.writeWaterfallTelemetry();
      evidence.writeCostLedger(
        buildCostLedger({
          runId: evidence.runId,
          task: options.task,
          lane: 'small_fix',
          waterfallEntries: evidence.getWaterfallLogSnapshot(),
        }),
      );
      writeLatestRunPointers(evidence.runDir, options.project ?? 'global');
      throw makeRecoverableRunError(
        message,
        evidence.runDir,
        failureCode,
        classified.next,
      );
    }

    // 2. Shared Verifier Run & Coordinated Repair Loop
    const maxRepairAttempts =
      options.maxRepairAttempts ??
      (resolveSmallFixProvider(options) === 'mock'
        ? 1
        : resolveSmallFixMaxRepairAttempts());
    const repairTimeline: SmallFixRepairAttemptRecord[] = [];

    const coordinatedContext = {
      agentId: 'small-fix', runId: evidence.runId, runDir: evidence.runDir, babelRoot: BABEL_ROOT,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    const coordinatedRuns: CoordinatedSmallFixMutationResult[] = [];
    const executeCoordinated = async () => {
      const batch = await runCoordinatedSmallFixMutationLoop({
        projectRoot: detected.projectRoot, verifierCommand, toolContext: coordinatedContext,
        writes: targets.map(path => ({ path, content: currentContents.get(path)! })),
        hostFallbackAllowed: isHostIsolationEscalationAllowed(),
        onVerifyStart: () => options.progress?.report('verify', `Dispatching ${verifierCommand}…`),
      });
      coordinatedRuns.push(batch);
      return batch;
    };
    let repairModelFailure: unknown;
    let hasRepairModelFailure = false;
    let coordinated = await executeCoordinated();
    let stopped = coordinated.policyBlocked || coordinated.failure !== undefined ||
      coordinated.unknownWritePath !== undefined || !coordinated.testResult;
    let verifierExit = coordinated.testResult?.exit_code ?? 1;
    let verifierStdout = coordinated.testResult?.stdout ?? '';
    let verifierStderr = coordinated.testResult?.stderr ?? '';

    for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
      const verifyPassed = verifierExit === 0;
      const attemptStatus: SmallFixRepairAttemptRecord['status'] = coordinated.cancelled ? 'cancelled' : coordinated.policyBlocked ? 'blocked' : verifyPassed ? 'passed' : 'failed';
      repairTimeline.push({
        attempt,
        status: attemptStatus,
        verifier_exit_code: coordinated.testResult?.exit_code ?? null,
        verifier_stdout_summary: coordinated.testResult ? verifierStdout.slice(0, 500) : null,
        verifier_stderr_summary: coordinated.testResult ? verifierStderr.slice(0, 500) : null,
        changed_files: coordinated.completedWrites.map(write => write.path),
        ...(coordinated.unknownWritePath ? { write_outcome: 'unknown' as const } : {}),
      });

      if (verifyPassed || stopped) {
        break;
      }
      if (attempt >= maxRepairAttempts) {
        break;
      }

      options.progress?.report(
        'verify',
        `Verifier failed — coordinated repair attempt ${attempt + 1}/${maxRepairAttempts}`,
      );

      try {
        // Collect the next proposals before performing any additional writes.
        for (const targetFile of targets) {
          if (options.signal?.aborted) throw new DOMException('Small-fix cancelled.', 'AbortError');
          options.progress?.report('model', `Repairing ${targetFile}…`);
          const repairPrompt = buildRepairPrompt({
            task: options.task, projectRoot: detected.projectRoot, targetFile, verifierCommand,
            attempt: attempt + 1, maxAttempts: maxRepairAttempts,
            verifierExitCode: verifierExit, verifierStdout, verifierStderr,
            currentFileContent: currentContents.get(targetFile)!, planHandoff,
            ...(discoveryBundle?.discovery.observations
              ? { discoveryObservations: discoveryBundle.discovery.observations } : {}),
          });
          const repairModel = await runSmallFixModel(repairPrompt, evidence, options, { targetFile }, attempt + 1);
          if (options.signal?.aborted) throw new DOMException('Small-fix cancelled.', 'AbortError');
          currentContents.set(targetFile, repairModel.answer.replacement_content);
        }
      } catch (failure) {
        repairModelFailure = failure;
        hasRepairModelFailure = true;
        repairTimeline.push({
          attempt: attempt + 1, status: options.signal?.aborted ? 'cancelled' : 'failed',
          verifier_exit_code: null, verifier_stdout_summary: null, verifier_stderr_summary: null,
          changed_files: coordinated.completedWrites.map(write => write.path),
        });
        coordinated = { ...coordinated, failure, ...(options.signal?.aborted ? { cancelled: true as const } : {}) };
        stopped = true;
        break;
      }
      coordinated = await executeCoordinated();
      stopped = coordinated.policyBlocked || coordinated.failure !== undefined ||
        coordinated.unknownWritePath !== undefined || !coordinated.testResult;
      verifierExit = coordinated.testResult?.exit_code ?? 1;
      verifierStdout = coordinated.testResult?.stdout ?? '';
      verifierStderr = coordinated.testResult?.stderr ?? '';
    }

    const repairTimelinePath = join(
      evidence.runDir,
      'repair_attempt_timeline.json',
    );
    writeJsonArtifact(repairTimelinePath, {
      schema_version: 1,
      artifact_type: 'babel_small_fix_repair_timeline',
      max_attempts: maxRepairAttempts,
      attempts: repairTimeline,
    });

    const changedFiles: string[] = [];
    const unknownFiles: string[] = coordinated.unknownWritePath ? [coordinated.unknownWritePath] : [];
    for (const file of targets) {
      const safePath = safeSmallFixFile(detected.projectRoot, file);
      if (!safePath) {
        if (!unknownFiles.includes(file)) unknownFiles.push(file);
        continue;
      }
      try {
        if (hashText(readFileSync(safePath, 'utf-8')) !== originalHashes.get(file)) changedFiles.push(file);
      } catch {
        if (!unknownFiles.includes(file)) unknownFiles.push(file);
      }
    }
    const verifierLog = coordinated.testResult ? [{
      step: 1, tool: 'test_run', target: verifierCommand,
      exit_code: coordinated.testResult.exit_code, stdout: coordinated.testResult.stdout,
      stderr: coordinated.testResult.stderr, verified: coordinated.testResult.exit_code === 0,
      policy_blocked: coordinated.policyBlocked,
    }] : [];
    const verifierContract = buildVerifierContractArtifacts({
      task: options.task, toolCallLog: verifierLog as ToolCallLog[], runDir: evidence.runDir,
      additionalRequiredVerifiers: [verifierCommand],
    });
    writeJsonArtifact(join(evidence.runDir, 'verifier_plan.json'), verifierContract.plan);
    writeJsonArtifact(join(evidence.runDir, 'verifier_execution_summary.json'), { ...verifierContract.summary });
    const verifierOk = !stopped && verifierExit === 0 && unknownFiles.length === 0 &&
      verifierContract.summary.verifierCompletionSatisfied;
    const status: 'SMALL_FIX_COMPLETE' | 'SMALL_FIX_FAILED' = verifierOk
      ? 'SMALL_FIX_COMPLETE' : 'SMALL_FIX_FAILED';
    const failureCode = coordinated.cancelled ? 'cancelled'
      : hasRepairModelFailure ? classifySmallFixProviderFailure(repairModelFailure, resolveSmallFixProvider(options) === 'live' ? 'openrouter' : undefined).failureCode
      : coordinated.policyBlocked ? 'policy_blocked'
      : unknownFiles.length ? 'write_outcome_unknown'
      : coordinated.failure !== undefined ? 'tool_execution_failed'
      : verifierExit === 0 && !verifierContract.summary.verifierCompletionSatisfied ? 'verifier_contract'
      : 'verifier_failed';
    const failureCapsulePath = verifierOk ? null : join(evidence.runDir, 'small_fix_failure_capsule.json');
    if (failureCapsulePath) {
      evidence.writeDebugFile('small_fix_failure_capsule.json', `${JSON.stringify({
        schema_version: 1, failure_capsule_id: `small_fix_${evidence.runId}`,
        category: failureCode,
        failure_code: failureCode,
        retryable: false, changed_files: changedFiles, unknown_write_paths: unknownFiles,
        ...(coordinated.failure !== undefined ? { physical_settlement: 'unknown' } : {}),
        verifier_command: verifierCommand,
        next_recommended_operator_action: 'Inspect the workspace and retained evidence before continuing.',
      }, null, 2)}\n`);
    }

    const toolCallLog: Array<Record<string, unknown>> = [];
    for (const batch of coordinatedRuns) {
      for (const write of batch.completedWrites) {
        toolCallLog.push({ step: toolCallLog.length + 1, tool: 'file_write', target: write.path,
          exit_code: write.result.exit_code, stdout: write.result.stdout, stderr: write.result.stderr,
          verified: write.result.exit_code === 0 });
      }
      if (batch.failedWrite?.result) {
        const failed = batch.failedWrite;
        toolCallLog.push({ step: toolCallLog.length + 1, tool: 'file_write', target: failed.path,
          exit_code: failed.result!.exit_code, stdout: failed.result!.stdout, stderr: failed.result!.stderr,
          verified: false, policy_blocked: batch.policyBlocked });
      }      if (batch.testResult) {
        toolCallLog.push({ step: toolCallLog.length + 1, tool: 'test_run', target: verifierCommand,
          exit_code: batch.testResult.exit_code, stdout: batch.testResult.stdout, stderr: batch.testResult.stderr,
          verified: batch.testResult.exit_code === 0 && !batch.policyBlocked, policy_blocked: batch.policyBlocked });
      }
    }
    evidence.writeExecutionLog({
      status: verifierOk ? 'EXECUTION_COMPLETE' : 'EXECUTION_HALTED', stage_status: status,
      steps_executed: toolCallLog.filter(entry => entry['policy_blocked'] !== true).length, tool_call_log: toolCallLog,
      small_fix: { target_files: targets, verifier_command: verifierCommand,
        unknown_write_paths: unknownFiles, ...(coordinated.failure !== undefined ? { physical_settlement: 'unknown' } : {}) },
    });
    const summaryPath = join(evidence.runDir, 'terminal_status_summary.json');
    writeJsonArtifact(summaryPath, {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status,
      reason_category: verifierOk ? 'none' : failureCode,
      failed_command: verifierOk || stopped || failureCode === 'verifier_contract' ? null : verifierCommand,
      changed_files: changedFiles,
      unknown_write_paths: unknownFiles,
      ...(coordinated.failure !== undefined ? { physical_settlement: 'unknown' } : {}),
      change_disposition: unknownFiles.length ? 'unknown' : changedFiles.length ? 'preserved_for_inspection' : 'none',
      rollback_mode: 'none',
      failure_capsule_path: failureCapsulePath,
      next_recommended_operator_action: verifierOk
        ? []
        : ['inspect the workspace and retained evidence'],
      attempt_safety_summary_path: null,
      repair_attempt_timeline_path: repairTimelinePath,
      condition_summary: verifierOk ? null : 'Coordinated fix did not complete; inspect the retained evidence.',
      verifier_contract: verifierContract.summary,
    });

    evidence.writeWaterfallTelemetry();
    const costLedger = buildCostLedger({
      runId: evidence.runId,
      task: options.task,
      lane: 'small_fix',
      waterfallEntries: evidence.getWaterfallLogSnapshot(),
    });
    evidence.writeCostLedger(costLedger);
    writeLiteManifest(liteRun, {
      schema_version: 1,
      command: 'fix',
      status,
      run_id: liteRun.runId,
      task: options.task,
      mutation_policy: 'verified_write',
      changed_files: changedFiles,
      unknown_write_paths: unknownFiles,
    });
    writeLatestRunPointers(evidence.runDir, options.project ?? 'global');

    const usageSummary =
      costLedger.entries.length > 0
        ? usageSummaryFromCostLedger(costLedger)
        : globalCostTracker.getSessionSummary();

    options.progress?.finish(
      verifierOk ? 'pass' : 'fail',
      verifierOk ? 'Fix run complete' : 'Fix run failed',
    );

    return {
      status,
      task: options.task,
      project: options.project ?? null,
      projectRoot: detected.projectRoot,
      targetFile: targets[0]!,
      verifierCommand,
      runDir: evidence.runDir,
      scopePath,
      changedFiles,
      ...(unknownFiles.length ? { writeOutcome: 'unknown' as const } : {}),
      ...(coordinated.cancelled ? { cancelled: true as const } : {}),
      ...(verifierOk ? {} : { retryable: false }),
      checks: verifierOk ? [`${verifierCommand}: passed`] : ['Coordinated fix did not complete; inspect the workspace and retained evidence.'],
      summary: lastSummary,
      usageSummary,
      ...(modelPolicy !== undefined ? { modelPolicy } : {}),
      executionMode,
      sessionLoopSteps: [
        ...(discoveryBundle?.discovery.sessionLoopSteps ?? []),
      ],
    };
  }
  let targetFile: string;
  let verifierCommand: string;
  if (detected.mode === 'single') {
    targetFile = detected.targetFile;
    verifierCommand = detected.verifierCommand;
  } else if (options.forcedTargetFile) {
    targetFile = normalizeRelativePath(options.forcedTargetFile);
    verifierCommand = detected.verifierCommand;
  } else {
    return {
      status: 'SMALL_FIX_NOT_APPLICABLE',
      reason:
        'Multi-file small fix must run through sequential or coordinated passes.',
    };
  }

  const { run: liteRun, evidence } = beginLiteEvidenceSession({
    command: 'fix',
    repoPath: detected.projectRoot,
  });
  options.progress?.bindRunDir(evidence.runDir);
  options.progress?.report('scoped', `${targetFile} (${verifierCommand})`);
  writeLiteRequest(liteRun, {
    schema_version: 1,
    command: 'fix',
    task: options.task,
    project: options.project ?? null,
    project_root: detected.projectRoot,
    target_file: targetFile,
    verifier_command: verifierCommand,
    ...(planHandoff ? { plan_handoff_run_id: planHandoff.planRunId } : {}),
    ...(options.sparkSynthesis
      ? { spark_synthesis: options.sparkSynthesis }
      : {}),
  });
  if (options.sparkSynthesis) {
    evidence.writeDebugFile(
      'spark_synthesis.json',
      `${JSON.stringify(options.sparkSynthesis, null, 2)}\n`,
    );
  }
  globalCostTracker.resetSession();
  const prompt = buildPrompt({
    task: options.task,
    projectRoot: detected.projectRoot,
    targetFile,
    verifierCommand,
    planHandoff,
    ...(discoveryBundle?.discovery.observations
      ? { discoveryObservations: discoveryBundle.discovery.observations }
      : {}),
  });
  evidence.writeCompiledContext('small_fix', prompt);
  const targetFilePath = resolve(detected.projectRoot, targetFile);
  const scopePath = join(evidence.runDir, 'small_fix_scope.json');
  evidence.writeDebugFile(
    'small_fix_scope.json',
    `${JSON.stringify(
      {
        schema_version: 1,
        selected_lane: 'small_fix',
        task: options.task,
        files_to_edit: [targetFile],
        checks_to_run: [verifierCommand],
        inference: extractOnlyEditFile(options.task)
          ? 'explicit_one_file_scope'
          : 'local_test_context',
      },
      null,
      2,
    )}\n`,
  );
  const originalContent = readFileSync(targetFilePath, 'utf-8');
  const originalHash = hashText(originalContent);
  const originalByteLength = byteLengthUtf8(originalContent);
  const scopeBeforePath = join(evidence.runDir, 'small_fix_scope_before.json');
  writeJsonArtifact(scopeBeforePath, {
    schema_version: 1,
    scope_artifact_type: 'small_fix_scope_before_mutation',
    target_file: targetFile,
    project_root: detected.projectRoot,
    inferred_scope: extractOnlyEditFile(options.task)
      ? 'explicit_one_file_scope'
      : 'local_test_context',
    bytes_before: originalByteLength,
    sha256_before: originalHash,
    normalized: true,
    next_step_hint:
      'run small-fix checkpoint restore after verification if needed',
  });

  let answer: SmallFixAnswer;
  let modelPolicy: ResolvedModelPolicy | undefined;
  let executionMode: SmallFixExecutionMode = 'live';
  try {
    if (options.signal?.aborted) throw new Error('Small-fix cancelled before model dispatch.');
    options.progress?.report('model', 'Calling model…');
    const modelResult = await runSmallFixModel(prompt, evidence, options, {
      targetFile,
    });
    if (options.signal?.aborted) throw new Error('Small-fix cancelled before mutation.');
    answer = modelResult.answer;
    modelPolicy = modelResult.modelPolicy;
    executionMode = modelResult.executionMode ?? 'live';
    options.progress?.report('model', 'Model patch ready');
  } catch (error: unknown) {
    const cancelled = options.signal?.aborted === true;
    options.progress?.finish('fail', cancelled ? 'Fix cancelled' : 'Model call failed');
    const classified = cancelled
      ? { failureCode: 'cancelled', message: 'Small-fix cancelled before mutation.', next: ['Inspect the retained run before continuing'] }
      : classifySmallFixProviderFailure(error, resolveSmallFixProvider(options) === 'live' ? 'openrouter' : undefined);
    const message = classified.message;
    const failureCode = classified.failureCode;
    const failureCapsulePath = join(
      evidence.runDir,
      'small_fix_failure_capsule.json',
    );
    evidence.writeDebugFile(
      'small_fix_failure_capsule.json',
      `${JSON.stringify(
        {
          schema_version: 1,
          failure_capsule_id: `small_fix_${evidence.runId}`,
          category: failureCode,
          failure_code: failureCode,
          retryable: !cancelled && failureCode !== 'provider_authentication_failed',
          recoverable: true,
          next: classified.next,
          condition: message,
          task: options.task,
          project_root: detected.projectRoot,
          target_file: targetFile,
          verifier_command: verifierCommand,
          credential_env_key:
            failureCode === 'credential_missing'
              ? liveProviderEnvKey(
                  /OPENROUTER_API_KEY/i.test(message)
                    ? 'openrouter'
                    : undefined,
                )
              : null,
          next_recommended_operator_action: classified.next.join('; '),
        },
        null,
        2,
      )}\n`,
    );
    evidence.writeExecutionLog({
      status: 'EXECUTION_HALTED',
      stage_status: cancelled ? 'SMALL_FIX_CANCELLED' : 'SMALL_FIX_PROVIDER_FAILED',
      steps_executed: 0,
      tool_call_log: [],
      pipeline_error: {
        halt_tag: 'TOOL_CALL_ERROR',
        halted_at_step: 1,
        condition: message,
      },
    });
    evidence.writeDebugFile(
      'terminal_status_summary.json',
      `${JSON.stringify(
        {
          schema_version: 1,
          artifact_type: 'babel_terminal_status_summary',
          status: 'SMALL_FIX_FAILED',
          reason_category: failureCode,
          failed_command: 'small_fix_model',
          changed_files: [],
          change_disposition: 'none',
          rollback_mode: 'none',
          failure_capsule_path: failureCapsulePath,
          next_recommended_operator_action: classified.next.join('; '),
          parseable_json_stdout_required: true,
          attempt_safety_summary_path: null,
          repair_attempt_timeline_path: null,
          condition_summary: message,
          verifier_contract: null,
        },
        null,
        2,
      )}\n`,
    );
    evidence.writeWaterfallTelemetry();
    evidence.writeCostLedger(
      buildCostLedger({
        runId: evidence.runId,
        task: options.task,
        lane: 'small_fix',
        waterfallEntries: evidence.getWaterfallLogSnapshot(),
      }),
    );
    writeLatestRunPointers(evidence.runDir, options.project ?? 'global');
    throw makeRecoverableRunError(
      message,
      evidence.runDir,
      failureCode,
      classified.next,
    );
  }
  evidence.writeDebugFile(
    'small_fix_answer.json',
    `${JSON.stringify(answer, null, 2)}\n`,
  );

  options.progress?.report('patch', `Applying patch to ${targetFile}`);
  const toolContext = {
    agentId: 'small-fix',
    runId: evidence.runId,
    runDir: evidence.runDir,
    babelRoot: BABEL_ROOT,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  const maxRepairAttempts =
    options.maxRepairAttempts ??
    (resolveSmallFixProvider(options) === 'mock'
      ? 1
      : resolveSmallFixMaxRepairAttempts());
  const repairTimeline: SmallFixRepairAttemptRecord[] = [];
  let currentAnswer = answer;
  let mutationLoop = await runSmallFixMutationLoop({
    targetFile,
    projectRoot: detected.projectRoot,
    verifierCommand,
    replacementContent: currentAnswer.replacement_content,
    toolContext,
    onVerifyStart: () => options.progress?.report('verify', `Dispatching ${verifierCommand}…`),
    hostFallbackAllowed: isHostIsolationEscalationAllowed(),
  });

  for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
    const writeResultAttempt = mutationLoop.writeResult;
    const testResultAttempt = mutationLoop.testResult;
    const verifyPassed = Boolean(
      testResultAttempt &&
      testResultAttempt.exit_code === 0 &&
      !mutationLoop.policyBlocked &&
      writeResultAttempt &&
      writeResultAttempt.exit_code === 0,
    );
    const attemptStatus: SmallFixRepairAttemptRecord['status'] =
      mutationLoop.cancelled
        ? 'cancelled'
        : mutationLoop.policyBlocked
        ? 'blocked'
        : !writeResultAttempt || writeResultAttempt.exit_code !== 0
          ? 'write_failed'
          : verifyPassed
            ? 'passed'
            : 'failed';
    repairTimeline.push({
      attempt,
      status: attemptStatus,
      verifier_exit_code: testResultAttempt?.exit_code ?? null,
      verifier_stdout_summary: testResultAttempt?.stdout?.slice(0, 500) ?? null,
      verifier_stderr_summary: testResultAttempt?.stderr?.slice(0, 500) ?? null,
      ...(mutationLoop.writeOutcome === 'unknown' ? { write_outcome: 'unknown' as const } : {}),
      changed_files:
        writeResultAttempt && writeResultAttempt.exit_code === 0
          ? [targetFile]
          : [],
    });

    if (
      verifyPassed ||
      mutationLoop.cancelled ||
      mutationLoop.policyBlocked ||
      !writeResultAttempt ||
      writeResultAttempt.exit_code !== 0
    ) {
      break;
    }
    if (attempt >= maxRepairAttempts) {
      break;
    }

    options.progress?.report(
      'verify',
      `Verifier failed — repair attempt ${attempt + 1}/${maxRepairAttempts}`,
    );
    const repairPrompt = buildRepairPrompt({
      task: options.task,
      projectRoot: detected.projectRoot,
      targetFile,
      verifierCommand,
      attempt: attempt + 1,
      maxAttempts: maxRepairAttempts,
      verifierExitCode: testResultAttempt?.exit_code ?? 1,
      verifierStdout: testResultAttempt?.stdout ?? '',
      verifierStderr: testResultAttempt?.stderr ?? '',
      currentFileContent: readFileSync(targetFilePath, 'utf-8'),
      planHandoff,
      ...(discoveryBundle?.discovery.observations
        ? { discoveryObservations: discoveryBundle.discovery.observations }
        : {}),
    });
    const repairModel = await runSmallFixModel(
      repairPrompt,
      evidence,
      options,
      { targetFile },
      attempt + 1,
    );
    currentAnswer = repairModel.answer;
    evidence.writeDebugFile(
      `small_fix_answer_attempt_${attempt + 1}.json`,
      `${JSON.stringify(currentAnswer, null, 2)}\n`,
    );
    options.progress?.report('patch', `Applying repair patch to ${targetFile}`);
    mutationLoop = await runSmallFixMutationLoop({
      targetFile,
      projectRoot: detected.projectRoot,
      verifierCommand,
      replacementContent: currentAnswer.replacement_content,
      toolContext,
      onVerifyStart: () => options.progress?.report('verify', `Dispatching ${verifierCommand}…`),
      hostFallbackAllowed: isHostIsolationEscalationAllowed(),
    });
  }

  const repairTimelinePath = join(
    evidence.runDir,
    'repair_attempt_timeline.json',
  );
  writeJsonArtifact(repairTimelinePath, {
    schema_version: 1,
    artifact_type: 'babel_small_fix_repair_timeline',
    max_attempts: maxRepairAttempts,
    attempts: repairTimeline,
  });
  if (discoveryBundle) {
    evidence.writeDebugFile(
      'fix_discovery.json',
      `${JSON.stringify(
        {
          schema_version: 1,
          discovery_run_dir: discoveryBundle.discoveryRunDir,
          resolved_scope: {
            target_file: targetFile,
            verifier_command: verifierCommand,
          },
          tool_call_log: discoveryBundle.discovery.toolCallLog,
          observations: discoveryBundle.discovery.observations,
        },
        null,
        2,
      )}\n`,
    );
  }
  evidence.writeDebugFile(
    'small_fix_loop.json',
    `${JSON.stringify(
      {
        schema_version: 1,
        policy_blocked: mutationLoop.policyBlocked,
        blocked_reason: mutationLoop.blockedReason,
        steps: mutationLoop.steps.map((step) => ({
          phase: step.phase,
          action_type: step.action.type,
          policy_decision: step.policyDecision,
          policy_blocked: step.policyBlocked,
          exit_codes: step.toolResults.map((result) => result.exit_code),
        })),
        repair_attempts: repairTimeline.length,
        ...(discoveryBundle
          ? { discovery_steps: discoveryBundle.discovery.sessionLoopSteps }
          : {}),
      },
      null,
      2,
    )}\n`,
  );

  const writeResult = mutationLoop.writeResult;
  const testResult = mutationLoop.testResult;
  if (writeResult && writeResult.exit_code === 0) {
    options.progress?.report('patch', `Updated ${targetFile}`);
  }

  const checks: string[] = [];
  let status: SmallFixCompleted['status'] = 'SMALL_FIX_COMPLETE';
  const preMutationCheckpointId =
    writeResult &&
    Array.isArray(writeResult.checkpoint_ids) &&
    writeResult.checkpoint_ids.length > 0
      ? typeof writeResult.checkpoint_ids[
          writeResult.checkpoint_ids.length - 1
        ] === 'string'
        ? (writeResult.checkpoint_ids[
            writeResult.checkpoint_ids.length - 1
          ] as string)
        : null
      : null;
  let afterContent = originalContent;
  let afterHash = originalHash;
  let afterByteLength = originalByteLength;
  let changedFiles: string[] = [];
  const checkpointRecord: {
    schema_version: number;
    scope_artifact_type: string;
    checkpoint_id: string | null;
    tool: 'file_write';
    target_file: string;
    project_root: string;
    target_path: string;
    pre_mutation: {
      checksum_sha256: string;
      bytes_before: number;
    };
    changed_files: string[];
    changed: boolean;
    write_outcome?: 'unknown';
    post_mutation?: {
      checksum_sha256: string;
      bytes_after: number;
    };
  } = {
    schema_version: 1,
    scope_artifact_type: 'small_fix_checkpoint',
    checkpoint_id: preMutationCheckpointId,
    tool: 'file_write',
    target_file: targetFile,
    project_root: detected.projectRoot,
    target_path: targetFilePath,
    pre_mutation: {
      checksum_sha256: originalHash,
      bytes_before: originalByteLength,
    },
    changed_files: changedFiles,
    changed: false,
  };

  if (mutationLoop.policyBlocked) {
    status = 'SMALL_FIX_FAILED';
    checks.push(mutationLoop.blockedReason ?? 'policy blocked mutation');
  }
  if (mutationLoop.cancelled) {
    status = 'SMALL_FIX_FAILED';
    checks.push(mutationLoop.writeOutcome === 'unknown'
      ? 'Cancelled during write; the write outcome is unknown and requires inspection.'
      : 'Cancelled before verification completed; inspect the retained change.');
  }
  if (mutationLoop.writeOutcome === 'unknown' && !mutationLoop.cancelled) {
    checks.push('The write outcome is unknown; inspect the workspace before continuing.');
  }
  if (!writeResult || writeResult.exit_code !== 0) {
    status = 'SMALL_FIX_FAILED';
    if (!mutationLoop.policyBlocked) {
      checks.push(`file_write failed: ${writeResult?.stderr || writeResult?.stdout || 'unknown error'}`);
    }
    if (mutationLoop.writeOutcome === 'unknown') {
      checkpointRecord.write_outcome = 'unknown';
      const safeTarget = safeSmallFixFile(detected.projectRoot, targetFile);
      if (safeTarget) {
        try {
          afterContent = readFileSync(safeTarget, 'utf-8');
          afterHash = hashText(afterContent);
          afterByteLength = byteLengthUtf8(afterContent);
          if (afterHash !== originalHash) {
            changedFiles.push(targetFile);
            checkpointRecord.changed = true;
          }
          checkpointRecord.post_mutation = { checksum_sha256: afterHash, bytes_after: afterByteLength };
        } catch { checks.push('Could not inspect the target after cancellation.'); }
      } else { checks.push('Target could not be safely inspected after cancellation.'); }
    } else {
      checkpointRecord.post_mutation = { checksum_sha256: afterHash, bytes_after: afterByteLength };
    }
  } else {
    afterContent = readFileSync(targetFilePath, 'utf-8');
    afterHash = hashText(afterContent);
    afterByteLength = byteLengthUtf8(afterContent);
    if (afterHash !== originalHash) {
      changedFiles.push(targetFile);
      checkpointRecord.changed_files = changedFiles;
      checkpointRecord.changed = true;
    }
    checks.push(
      changedFiles.length > 0
        ? `updated ${targetFile}`
        : `no changes to ${targetFile}`,
    );
    evidence.writeDebugFile(
      'changes.diff',
      buildChangesDiff(targetFile, originalContent, afterContent),
    );
    checkpointRecord.post_mutation = {
      checksum_sha256: afterHash,
      bytes_after: afterByteLength,
    };
  }
  if (mutationLoop.writeOutcome !== 'unknown') {
    checkpointRecord.post_mutation = checkpointRecord.post_mutation ?? {
      checksum_sha256: afterHash, bytes_after: afterByteLength,
    };
  }
  writeJsonArtifact(join(evidence.runDir, 'small_fix_checkpoint.json'), {
    ...checkpointRecord,
  });
  if (preMutationCheckpointId) {
    options.progress?.report('checkpoint', 'Checkpoint saved');
  }

  let rollbackMode: 'none' | 'auto_restored' | 'preserved_for_inspection' =
    changedFiles.length > 0 ? 'preserved_for_inspection' : 'none';
  if (testResult) {
    evidence.writeDebugFile('small_fix_verifier_stdout.log', testResult.stdout);
    evidence.writeDebugFile('small_fix_verifier_stderr.log', testResult.stderr);
    if (!mutationLoop.policyBlocked) {
      checks.push(`${verifierCommand}: ${testResult.exit_code === 0 ? 'passed' : 'failed'}`);
      options.progress?.report('verify', `${verifierCommand}: ${testResult.exit_code === 0 ? 'passed' : 'failed'}`);
    }
    if (testResult.exit_code !== 0) {
      status = 'SMALL_FIX_FAILED';
      if (!mutationLoop.policyBlocked && repairTimeline.length >= maxRepairAttempts) {
        checks.push(
          `repair budget exhausted (${maxRepairAttempts} attempt(s))`,
        );
      }
      if (options.rollbackOnFail === true && preMutationCheckpointId) {
        try {
          const { record } = findCheckpoint(preMutationCheckpointId, {
            runDir: evidence.runDir,
          });
          const restore = restoreCheckpoint(record);
          if (restore.status === 'restored') {
            changedFiles = [];
            checkpointRecord.changed_files = [];
            checkpointRecord.changed = false;
            afterContent = originalContent;
            afterHash = originalHash;
            afterByteLength = originalByteLength;
            rollbackMode = 'auto_restored';
            checks.push('rollback_on_fail: restored checkpoint');
          }
        } catch {
          // keep preserved mutation when rollback fails
        }
      }
    }
  }

  const failureCapsulePath =
    status === 'SMALL_FIX_COMPLETE'
      ? null
      : join(evidence.runDir, 'small_fix_failure_capsule.json');
  if (failureCapsulePath) {
    const failureCode = mutationLoop.cancelled
      ? 'cancelled'
      : mutationLoop.policyBlocked
      ? 'policy_blocked'
      : !writeResult || writeResult.exit_code !== 0
        ? 'small_fix_write_failed'
        : 'verifier_failed';
    evidence.writeDebugFile(
      'small_fix_failure_capsule.json',
      `${JSON.stringify(
        {
          schema_version: 1,
          failure_capsule_id: `small_fix_${evidence.runId}`,
          category: failureCode,
          failure_code: failureCode,
          retryable: !mutationLoop.policyBlocked && !mutationLoop.cancelled && mutationLoop.writeOutcome !== 'unknown',
          target_file: targetFile,
          verifier_command: verifierCommand,
          project_root: detected.projectRoot,
          changed_files: changedFiles,
          ...(mutationLoop.writeOutcome === 'unknown' ? { write_outcome: 'unknown' } : {}),
          checks,
          condition: checks.join('; '),
          verifier_stdout_path: testResult
            ? join(evidence.runDir, 'small_fix_verifier_stdout.log')
            : null,
          verifier_stderr_path: testResult
            ? join(evidence.runDir, 'small_fix_verifier_stderr.log')
            : null,
          next_recommended_operator_action:
            mutationLoop.cancelled || mutationLoop.writeOutcome === 'unknown'
              ? 'Inspect the workspace and retained evidence before continuing.'
              : mutationLoop.policyBlocked
              ? rollbackMode === 'auto_restored'
                ? 'Checkpoint restored. Inspect the policy denial and resolve it before retrying.'
                : 'Inspect the policy denial and resolve it before retrying.'
              : options.rollbackOnFail === true && rollbackMode === 'auto_restored'
                ? 'Verifier failed; checkpoint was auto-restored via --rollback-on-fail.'
                : 'Inspect verifier output and rerun with the verified pipeline if needed.',
          rollback_on_fail: options.rollbackOnFail === true,
          rollback_mode: rollbackMode,
        },
        null,
        2,
      )}\n`,
    );
  }

  const discoveryToolLog =
    discoveryBundle?.discovery.toolCallLog.map((entry, index) => ({
      step: index + 1,
      tool: entry.tool,
      target: entry.target,
      exit_code: entry.exit_code,
      stdout: entry.stdout,
      stderr: entry.stderr,
      verified: entry.exit_code === 0,
    })) ?? [];
  const mutationStepOffset = discoveryToolLog.length;
  const executionReport = {
    status:
      status === 'SMALL_FIX_COMPLETE'
        ? 'EXECUTION_COMPLETE'
        : 'EXECUTION_HALTED',
    stage_status: status,
    steps_executed:
      discoveryToolLog.length + (testResult ? 2 : writeResult ? 1 : 0),
    tool_call_log: [
      ...discoveryToolLog,
      ...(writeResult
        ? [
            {
              step: mutationStepOffset + 1,
              tool: 'file_write',
              target: targetFile,
              exit_code: writeResult.exit_code,
              stdout: writeResult.stdout,
              stderr: writeResult.stderr,
              verified: writeResult.exit_code === 0,
              policy_blocked: mutationLoop.policyBlocked,
            },
          ]
        : []),
      ...(testResult
        ? [
            {
              step: mutationStepOffset + 2,
              tool: 'test_run',
              target: verifierCommand,
              exit_code: testResult.exit_code,
              stdout: testResult.stdout,
              stderr: testResult.stderr,
              verified: testResult.exit_code === 0,
              policy_blocked: mutationLoop.steps.some(
                (step) => step.phase === 'verify' && step.policyBlocked,
              ),
            },
          ]
        : []),
    ],
    small_fix: {
      target_file: targetFile,
      verifier_command: verifierCommand,
      project_root: detected.projectRoot,
      summary: currentAnswer.summary,
      ...(mutationLoop.writeOutcome === 'unknown' ? { write_outcome: 'unknown' } : {}),
    },
  };
  evidence.writeExecutionLog(executionReport);

  const verifierContract = buildVerifierContractArtifacts({
    task: options.task,
    toolCallLog: executionReport.tool_call_log as ToolCallLog[],
    runDir: evidence.runDir,
    additionalRequiredVerifiers: [verifierCommand],
  });
  evidence.writeDebugFile(
    'verifier_plan.json',
    `${JSON.stringify(verifierContract.plan, null, 2)}\n`,
  );
  evidence.writeDebugFile(
    'verifier_execution_summary.json',
    `${JSON.stringify(verifierContract.summary, null, 2)}\n`,
  );

  let reasonCategory = mutationLoop.cancelled
    ? 'cancelled'
    : status === 'SMALL_FIX_COMPLETE' ? 'small_fix_complete' : 'small_fix_failed';
  if (
    status === 'SMALL_FIX_COMPLETE' &&
    !verifierContract.summary.verifierCompletionSatisfied
  ) {
    status = 'SMALL_FIX_FAILED';
    reasonCategory = 'verifier_contract';
    if (verifierContract.summary.missingRequiredVerifiers.length > 0) {
      checks.push(
        `missing required verifier(s): ${verifierContract.summary.missingRequiredVerifiers.join(', ')}`,
      );
    }
    if (verifierContract.summary.failedRequiredVerifiers.length > 0) {
      checks.push(
        `failed required verifier(s): ${verifierContract.summary.failedRequiredVerifiers.join(', ')}`,
      );
    }
    if (verifierContract.summary.skippedRequiredVerifiers.length > 0) {
      checks.push(
        `skipped required verifier(s): ${verifierContract.summary.skippedRequiredVerifiers.join(', ')}`,
      );
    }
  }

  const terminal = {
    schema_version: 1,
    artifact_type: 'babel_terminal_status_summary',
    status,
    reason_category: reasonCategory,
    failed_command:
      status === 'SMALL_FIX_COMPLETE'
        ? null
        : mutationLoop.cancelled
          ? null
          : mutationLoop.policyBlocked
          ? 'policy_gate'
          : !writeResult || writeResult.exit_code !== 0
            ? 'file_write'
            : verifierCommand,
    changed_files: changedFiles,
    ...(mutationLoop.writeOutcome === 'unknown' ? { write_outcome: 'unknown' } : {}),
    change_disposition:
      mutationLoop.writeOutcome === 'unknown' ? 'unknown' :
      rollbackMode === 'auto_restored'
        ? 'auto_restored'
        : changedFiles.length > 0
          ? 'preserved_for_inspection'
          : 'none',
    rollback_mode: rollbackMode,
    failure_capsule_path: failureCapsulePath,
    next_recommended_operator_action:
      status === 'SMALL_FIX_COMPLETE'
        ? 'Review the changed file and commit when ready.'
        : mutationLoop.cancelled || mutationLoop.writeOutcome === 'unknown'
          ? 'Inspect the workspace and retained evidence before continuing.'
          : mutationLoop.policyBlocked
          ? rollbackMode === 'auto_restored'
            ? 'Checkpoint restored. Inspect the policy denial and resolve it before retrying.'
            : 'Inspect the policy denial and resolve it before retrying.'
          : rollbackMode === 'auto_restored'
            ? 'Verifier failed; workspace was restored. Adjust the fix and retry.'
            : 'Inspect verifier output and rerun with the verified pipeline if needed.',
    parseable_json_stdout_required: true,
    attempt_safety_summary_path: null,
    repair_attempt_timeline_path:
      repairTimeline.length > 0 ? repairTimelinePath : null,
    condition_summary:
      status === 'SMALL_FIX_COMPLETE' ? null : checks.join('; '),
    verifier_contract: verifierContract.summary,
  };
  evidence.writeDebugFile(
    'terminal_status_summary.json',
    `${JSON.stringify(terminal, null, 2)}\n`,
  );
  evidence.writeWaterfallTelemetry();
  const costLedger = buildCostLedger({
    runId: evidence.runId,
    task: options.task,
    lane: 'small_fix',
    waterfallEntries: evidence.getWaterfallLogSnapshot(),
  });
  evidence.writeCostLedger(costLedger);
  writeLiteManifest(liteRun, {
    schema_version: 1,
    command: 'fix',
    status,
    run_id: liteRun.runId,
    task: options.task,
    mutation_policy: 'verified_write',
    changed_files: changedFiles,
    ...(mutationLoop.writeOutcome === 'unknown' ? { write_outcome: 'unknown' } : {}),
  });
  writeLatestRunPointers(evidence.runDir, options.project ?? 'global');
  const usageSummary =
    costLedger.entries.length > 0
      ? usageSummaryFromCostLedger(costLedger)
      : globalCostTracker.getSessionSummary();

  options.progress?.finish(
    status === 'SMALL_FIX_COMPLETE' ? 'pass' : 'fail',
    status === 'SMALL_FIX_COMPLETE' ? 'Fix run complete' : 'Fix run failed',
  );

  return {
    status,
    task: options.task,
    project: options.project ?? null,
    projectRoot: detected.projectRoot,
    targetFile,
    verifierCommand,
    runDir: evidence.runDir,
    scopePath,
    changedFiles,
    ...(mutationLoop.writeOutcome === 'unknown' ? { writeOutcome: 'unknown' as const } : {}),
    ...(mutationLoop.cancelled ? { cancelled: true as const } : {}),
    checks,
    summary: currentAnswer.summary,
    usageSummary,
    ...(modelPolicy !== undefined ? { modelPolicy } : {}),
    executionMode,
    sessionLoopSteps: [
      ...(discoveryBundle?.discovery.sessionLoopSteps ?? []),
      ...mutationLoop.sessionLoopSteps,
    ],
  };
}
