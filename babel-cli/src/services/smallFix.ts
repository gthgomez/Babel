import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { z } from 'zod';

import { loadPlanHandoff, type PlanHandoff } from '../agent/planHandoff.js';
import { extractExplicitFilePaths } from './liteFullRouter.js';
import { BABEL_ROOT } from '../cli/constants.js';
import { writeLatestRunPointers } from '../pipeline/runPointers.js';
import type { EvidenceBundle } from '../evidence.js';
import {
  beginLiteEvidenceSession,
  writeLiteManifest,
  writeLiteRequest,
} from '../agent/liteArtifacts.js';
import { findCheckpoint, restoreCheckpoint } from './checkpoints.js';
import { runWithPrimaryOnlyFallback } from '../execute.js';
import { resolveFamilyModelPolicy, type ResolvedModelPolicy } from '../modelPolicy.js';
import {
  runFixDiscoveryPhase,
  shouldAttemptFixDiscovery,
  type FixDiscoveryBundle,
} from '../agent/lanes/fixDiscoveryLoop.js';
import { runSmallFixMutationLoop } from '../agent/lanes/smallFixLoop.js';
import {
  detectMultiFileSmallFix,
  extractOnlyEditFile,
  isAmbiguousBroadRefactor,
  listSequentialFixTargets,
  resolveFixScopeFromDiscovery,
  type SmallFixScope,
} from './fixScopeResolver.js';
import type { RunnerInvocationMetadata } from '../runners/base.js';
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js';
import { globalCostTracker, type SessionUsageSummary } from './costTracker.js';
import { buildCostLedger, usageSummaryFromCostLedger } from './costLedger.js';
import type { SparkSynthesis } from './babelFull.js';
import type { LiteFixProgressReporter } from '../ui/liteFixProgress.js';
import type { LiteToolStreamSink } from '../ui/liteToolStream.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';
import { buildVerifierContractArtifacts } from './requiredVerifierContract.js';

const SmallFixAnswerSchema = z.object({
  schema_version: z.literal(1).catch(1),
  summary: z.string().min(1),
  replacement_content: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});

type SmallFixAnswer = z.infer<typeof SmallFixAnswerSchema>;

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

export type SmallFixProvider = 'live' | 'mock';
export type SmallFixExecutionMode = 'live' | 'offline_demo';

export const DEFAULT_SMALL_FIX_MAX_REPAIR_ATTEMPTS = 3;

export function resolveSmallFixMaxRepairAttempts(env: NodeJS.ProcessEnv = process.env): number {
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
  status: 'passed' | 'failed' | 'blocked' | 'write_failed';
  verifier_exit_code: number | null;
  verifier_stdout_summary: string | null;
  verifier_stderr_summary: string | null;
  changed_files: string[];
}

export interface SmallFixOptions {
  task: string;
  projectRoot?: string;
  /**
   * VCS: Write anchor path (absolute). Used to resolve relative tool paths
   * inside the fix session without mutating process.cwd().
   */
  anchorPath?: string;
  project?: string;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  showModelPolicy?: boolean;
  /** `mock` enables offline demo fix (lite-trust-demo fixture scope only). */
  provider?: SmallFixProvider;
  /** When true, verifier failure auto-restores the pre-mutation checkpoint. */
  rollbackOnFail?: boolean;
  /** Read-only Spark synthesis metadata from parallel review (no reviewer mutations). */
  sparkSynthesis?: SparkSynthesis;
  /** Optional live progress reporter for human terminal output. */
  progress?: LiteFixProgressReporter;
  /** Optional live tool stream sink for discovery/read-only tool cards. */
  toolStream?: LiteToolStreamSink;
  /** Override bounded verify→repair attempts (default from env or 3). */
  maxRepairAttempts?: number;
  /** Optional approved plan run id or handoff loaded from task text. */
  planRunId?: string;
  planHandoff?: PlanHandoff | null;
  /** Internal: force a single-file scope for dual-file sequential fixes. */
  forcedTargetFile?: string;
}

export function resolveSmallFixProvider(
  options: Pick<SmallFixOptions, 'provider'>,
  env: NodeJS.ProcessEnv = process.env,
): SmallFixProvider {
  if (options.provider === 'live') {
    return 'live';
  }
  if (options.provider === 'mock') {
    return 'mock';
  }
  if (env['BABEL_LITE_OFFLINE'] === '1' || env['BABEL_SMALL_FIX_PROVIDER'] === 'mock') {
    return 'mock';
  }
  return 'live';
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
  return createHash('sha256').update(normalizeText(value), 'utf-8').digest('hex');
}

function byteLengthUtf8(value: string): number {
  return Buffer.byteLength(value, 'utf-8');
}

function buildChangesDiff(targetFile: string, before: string, after: string): string {
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

function writeJsonArtifact(path: string, payload: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function extractVerifierCommand(task: string): string | null {
  const explicit = task.match(
    /\brun\s+([A-Za-z0-9_.\-\\/]+(?:\s+[A-Za-z0-9_.\-\\/]+){0,3})\s+before\s+(?:completing|completion|finishing)/i,
  );
  const candidate = explicit?.[1]?.trim().replace(/[.。]+$/, '');
  if (candidate && LOCAL_VERIFIER_COMMANDS.some((pattern) => pattern.test(candidate))) {
    return candidate;
  }
  if (/\bfailing\s+(?:node\s+)?test\b/i.test(task) && /\bnpm\s+test\b/i.test(task)) {
    return 'npm test';
  }
  return null;
}

function readPackageTestCommand(projectRoot: string): string | null {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, unknown>;
    };
    return typeof parsed.scripts?.['test'] === 'string' ? 'npm test' : null;
  } catch {
    return null;
  }
}

function collectCandidateFiles(projectRoot: string, dir = projectRoot, depth = 0): string[] {
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

function sourceForTestFile(projectRoot: string, testFile: string): string | null {
  const candidates = [
    testFile.replace(/(?:\.test|\.spec)(\.[^.]+)$/i, '$1'),
    testFile.replace(/__tests__\//i, '').replace(/(?:\.test|\.spec)(\.[^.]+)$/i, '$1'),
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
  const testFiles = files.filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file));
  const candidates = new Set<string>();

  if (descriptor) {
    for (const file of files) {
      const base = basename(file)
        .replace(/\.[^.]+$/, '')
        .toLowerCase();
      if (base === descriptor.toLowerCase() && !/\.(?:test|spec)$/i.test(base)) {
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
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path) || /(?:^|\/)tests?\//i.test(path);
}

function detectDualFileSmallFix(task: string, projectRoot: string): SmallFixScope | null {
  const explicitPaths = extractExplicitFilePaths(task)
    .map((path) => normalizeRelativePath(path))
    .filter((path) => {
      const absolutePath = resolve(projectRoot, path);
      return isInsideRoot(projectRoot, absolutePath) && existsSync(absolutePath);
    });

  if (explicitPaths.length < 2) {
    return null;
  }

  const testFiles = explicitPaths.filter(isTestLikePath);
  const sourceFiles = explicitPaths.filter((path) => !isTestLikePath(path));
  if (testFiles.length !== 1 || sourceFiles.length !== 1) {
    return null;
  }

  const verifierCommand = extractVerifierCommand(task) ?? 'npm --prefix ./babel-cli run typecheck';
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
      extractVerifierCommand(options.task) ?? readPackageTestCommand(projectRoot);
    if (!verifierCommand) {
      return null;
    }
    const absoluteTarget = resolve(projectRoot, targetFile);
    if (!isInsideRoot(projectRoot, absoluteTarget) || !existsSync(absoluteTarget)) {
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
  if (!isInsideRoot(projectRoot, absoluteTarget) || !existsSync(absoluteTarget)) {
    return null;
  }
  return { mode: 'single', targetFile, verifierCommand, projectRoot };
}

function trimForPrompt(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated]`;
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
    if (!/\.(test|spec)\.[cm]?[jt]s$/i.test(entry.name) && !entry.name.includes(`${base}.test`)) {
      continue;
    }
    const abs = join(dir, entry.name);
    const rel = normalizeRelativePath(relative(projectRoot, abs));
    snippets.push(`## ${rel}\n${trimForPrompt(readFileSync(abs, 'utf-8'), 4000)}`);
  }
  return snippets.length > 0 ? snippets.join('\n\n') : 'No nearby test files were found.';
}

function buildPrompt(input: {
  task: string;
  projectRoot: string;
  targetFile: string;
  verifierCommand: string;
  planHandoff?: PlanHandoff | null;
  discoveryObservations?: string;
}): string {
  const absTarget = resolve(input.projectRoot, input.targetFile);
  const packageJson = join(input.projectRoot, 'package.json');
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
    readNearbyTests(input.projectRoot, input.targetFile),
    '',
    '# package.json',
    existsSync(packageJson)
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
    [input.verifierStdout.trim(), input.verifierStderr.trim()].filter(Boolean).join('\n').trim() ||
    '(no verifier output captured)';
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
    readNearbyTests(input.projectRoot, input.targetFile),
  ].join('\n');
}

function liveProviderEnvKey(): 'DEEPINFRA_API_KEY' {
  return 'DEEPINFRA_API_KEY';
}

function assertLiveProviderCredential(
  provider?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (provider === 'deepseek') {
    if (!env['DEEPSEEK_API_KEY']?.trim()) {
      throw new Error(
        `[smallFix] DEEPSEEK_API_KEY is not set. Add it to your .env file or environment for live bl fix.`,
      );
    }
  } else {
    const key = liveProviderEnvKey();
    if (!env[key]?.trim()) {
      throw new Error(
        `[smallFix] ${key} is not set. Add it to your .env file or environment for live bl fix.`,
      );
    }
  }
}

export function classifySmallFixProviderFailure(error: unknown): {
  failureCode: string;
  message: string;
  next: string[];
} {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /DEEPSEEK_API_KEY is not set/i.test(message) ||
    (/deepseek/i.test(message) && /API_KEY is not set/i.test(message))
  ) {
    return {
      failureCode: 'credential_missing',
      message:
        'DEEPSEEK_API_KEY is not set. Direct DeepSeek requires DEEPSEEK_API_KEY in environment or .env. Adjust key or run Full Babel (governed mode) to allow backup cascading.',
      next: ['check DEEPSEEK_API_KEY', 'babel undo'],
    };
  }
  if (
    /DEEPINFRA_API_KEY is not set/i.test(message) ||
    /API_KEY is not set/i.test(message) ||
    /\bcredential\b/i.test(message)
  ) {
    return {
      failureCode: 'credential_missing',
      message: 'DEEPINFRA_API_KEY is not set. Live bl fix requires a DeepInfra API key.',
      next: ['check DEEPINFRA_API_KEY', 'babel undo'],
    };
  }
  if (
    /network error/i.test(message) ||
    /request timeout/i.test(message) ||
    /ECONNREFUSED|ENOTFOUND|fetch failed|ETIMEDOUT|socket hang up/i.test(message)
  ) {
    const isDeepSeek = /\[deepSeekApi\]/i.test(message) || /DEEPSEEK_API_KEY/i.test(message);
    return {
      failureCode: 'provider_network_failed',
      message,
      next: [isDeepSeek ? 'check DEEPSEEK_API_KEY' : 'check DEEPINFRA_API_KEY', 'babel undo'],
    };
  }
  if (/timeout/i.test(message)) {
    const isDeepSeek = /\[deepSeekApi\]/i.test(message) || /DEEPSEEK_API_KEY/i.test(message);
    return {
      failureCode: 'provider_timeout',
      message,
      next: [isDeepSeek ? 'check DEEPSEEK_API_KEY' : 'check DEEPINFRA_API_KEY', 'babel undo'],
    };
  }
  if (/zod|schema|invalid json|parse/i.test(message)) {
    return {
      failureCode: 'provider_schema_invalid',
      message,
      next: ['Retry the fix with the same task', 'babel undo'],
    };
  }
  if (/waterfall failed/i.test(message) || /all \d+ runner/i.test(message)) {
    return {
      failureCode: 'provider_request_failed',
      message: `${message}. [Recovery Hint] Stage execution failed under 'primary_only' policy. Please ensure the primary provider API key is set, or run in Full Babel mode (governed mode) to allow backup cascades.`,
      next: ['check DEEPSEEK_API_KEY', 'check DEEPINFRA_API_KEY', 'babel undo'],
    };
  }
  const isDeepSeek = /\[deepSeekApi\]/i.test(message) || /DEEPSEEK_API_KEY/i.test(message);
  return {
    failureCode: 'provider_request_failed',
    message,
    next: [isDeepSeek ? 'check DEEPSEEK_API_KEY' : 'check DEEPINFRA_API_KEY', 'babel undo'],
  };
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

const LITE_TRUST_DEMO_FIXTURE_DIR = join(
  BABEL_ROOT,
  'babel-cli',
  'src',
  'fixtures',
  'lite-trust-demo',
);
const PARITY_CORPUS_FIXTURE_DIR = join(BABEL_ROOT, 'babel-cli', 'src', 'fixtures', 'parity-corpus');

function listLiteTrustDemoFixturePaths(): string[] {
  const paths = [join(LITE_TRUST_DEMO_FIXTURE_DIR, 'scenario.json')];
  const scenariosDir = join(LITE_TRUST_DEMO_FIXTURE_DIR, 'scenarios');
  if (existsSync(scenariosDir)) {
    for (const name of readdirSync(scenariosDir)) {
      if (name.endsWith('.json')) {
        paths.push(join(scenariosDir, name));
      }
    }
  }
  return paths.filter((path) => existsSync(path));
}

function listParityCorpusFixturePaths(): string[] {
  const manifestPath = join(PARITY_CORPUS_FIXTURE_DIR, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return [];
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { tasks?: string[] };
    if (!Array.isArray(manifest.tasks)) {
      return [];
    }
    return manifest.tasks
      .map((taskId) => join(PARITY_CORPUS_FIXTURE_DIR, `${taskId}.json`))
      .filter((path) => existsSync(path));
  } catch {
    return [];
  }
}

/**
 * Extract exported function/const names from a JavaScript/TypeScript source string.
 * Matches `export const NAME` and `export function NAME` patterns.
 * Used by the mock-provider fixture guard to verify that a fixture's
 * fixed_implementation covers all exports from the on-disk broken file.
 */
function extractExportedFunctionNames(source: string): string[] {
  const names: string[] = [];
  const re = /export\s+(?:const|function)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

function offlineDemoAnswerFromFixture(
  options: SmallFixOptions,
  detected: { targetFile: string },
  fixturePath: string,
  expectedFixtureType: 'babel_lite_trust_demo' | 'babel_parity_corpus_task',
): SmallFixAnswer | null {
  try {
    const parsed = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
      fixture_type?: string;
      task?: string;
      target_file?: string;
      broken_implementation?: string;
      fixed_implementation?: string;
      mock_provider_answer?: string;
      files?: Record<string, { broken?: string; fixed?: string }>;
    };
    if (
      parsed.fixture_type !== expectedFixtureType ||
      typeof parsed.task !== 'string' ||
      typeof parsed.target_file !== 'string' ||
      typeof parsed.fixed_implementation !== 'string'
    ) {
      return null;
    }

    let brokenImplementation: string | undefined = parsed.broken_implementation;
    let replacement: string =
      typeof parsed.mock_provider_answer === 'string'
        ? parsed.mock_provider_answer
        : parsed.fixed_implementation!;

    if (detected.targetFile === parsed.target_file) {
      if (typeof brokenImplementation !== 'string') {
        return null;
      }
    } else {
      const extraFile = parsed.files?.[detected.targetFile];
      if (typeof extraFile?.broken !== 'string' || typeof extraFile.fixed !== 'string') {
        return null;
      }
      brokenImplementation = extraFile.broken;
      replacement = extraFile.fixed;
    }

    const taskMatches = options.task.trim() === parsed.task.trim();
    if (!taskMatches) {
      if (
        expectedFixtureType !== 'babel_parity_corpus_task' ||
        options.projectRoot === undefined ||
        typeof brokenImplementation !== 'string'
      ) {
        return null;
      }
      const targetPath = resolve(options.projectRoot, detected.targetFile);
      if (!existsSync(targetPath) || readFileSync(targetPath, 'utf-8') !== brokenImplementation) {
        return null;
      }
      // Guard: verify the fixture's fixed_implementation exports cover all
      // functions exported by the on-disk broken file. Prevents mock-fixture
      // mismatches when the project has tests for functions the fixture doesn't
      // know about (e.g. dynamically-generated subtract test alongside the add fixture).
      const onDiskExports = extractExportedFunctionNames(readFileSync(targetPath, 'utf-8'));
      const fixtureExports = extractExportedFunctionNames(replacement);
      const missingExports = onDiskExports.filter((n) => !fixtureExports.includes(n));
      if (missingExports.length > 0) {
        return null;
      }
    }
    return {
      schema_version: 1,
      summary:
        expectedFixtureType === 'babel_parity_corpus_task'
          ? 'Updated parity corpus implementation (offline demo).'
          : 'Updated math implementation (offline demo).',
      replacement_content: replacement,
      confidence: 'high',
    };
  } catch {
    return null;
  }
}

function tryOfflineDemoAnswer(
  options: SmallFixOptions,
  detected: { targetFile: string },
): SmallFixAnswer | null {
  for (const fixturePath of listLiteTrustDemoFixturePaths()) {
    const answer = offlineDemoAnswerFromFixture(
      options,
      detected,
      fixturePath,
      'babel_lite_trust_demo',
    );
    if (answer) {
      return answer;
    }
  }
  for (const fixturePath of listParityCorpusFixturePaths()) {
    const answer = offlineDemoAnswerFromFixture(
      options,
      detected,
      fixturePath,
      'babel_parity_corpus_task',
    );
    if (answer) {
      return answer;
    }
  }
  return null;
}

function failureCodeForError(error: unknown): string {
  return classifySmallFixProviderFailure(error).failureCode;
}

function appendDirectSmallFixTelemetry(input: {
  evidence: EvidenceBundle;
  metadata: RunnerInvocationMetadata | null;
  succeeded: boolean;
  errorSummary: string | null;
  provider: string;
  attempt: number;
}): void {
  const runnerName = `small-fix-direct-${input.provider}`;
  input.evidence.appendWaterfallLog({
    stage: 'small_fix',
    tier_succeeded: input.succeeded ? runnerName : null,
    tier_index: 0,
    attempts: input.attempt,
    tiers_skipped: [],
    cascade_reason: input.succeeded ? 'none' : 'failed',
    ts: new Date().toISOString(),
    attempts_detail: [
      {
        tier_name: runnerName,
        tier_index: 0,
        attempt: input.attempt,
        succeeded: input.succeeded,
        error_summary: input.errorSummary,
        provider: input.metadata?.provider ?? input.provider,
        provider_model_id: input.metadata?.provider_model_id ?? null,
        latency_ms: input.metadata?.latency_ms ?? null,
        prompt_tokens: input.metadata?.prompt_tokens ?? null,
        completion_tokens: input.metadata?.completion_tokens ?? null,
        total_tokens: input.metadata?.total_tokens ?? null,
        prompt_cache_hit_tokens: input.metadata?.prompt_cache_hit_tokens ?? null,
        prompt_cache_miss_tokens: input.metadata?.prompt_cache_miss_tokens ?? null,
        estimated_cost_usd: input.metadata?.estimated_cost_usd ?? null,
        cost_precision: input.metadata?.cost_precision ?? null,
        pricing_source_url: input.metadata?.pricing_source_url ?? null,
        pricing_verified_at: input.metadata?.pricing_verified_at ?? null,
        input_cost_per_1m: input.metadata?.input_cost_per_1m ?? null,
        output_cost_per_1m: input.metadata?.output_cost_per_1m ?? null,
        input_cache_hit_cost_per_1m: input.metadata?.input_cache_hit_cost_per_1m ?? null,
        input_cache_miss_cost_per_1m: input.metadata?.input_cache_miss_cost_per_1m ?? null,
        ttft_ms: input.metadata?.ttft_ms ?? null,
        generation_ms: input.metadata?.generation_ms ?? null,
        validation_ms: input.metadata?.validation_ms ?? null,
      },
    ],
    total_latency_ms: input.metadata?.latency_ms ?? null,
    total_prompt_tokens: input.metadata?.prompt_tokens ?? null,
    total_completion_tokens: input.metadata?.completion_tokens ?? null,
    total_tokens: input.metadata?.total_tokens ?? null,
    total_estimated_cost_usd: input.metadata?.estimated_cost_usd ?? null,
  });
}

async function runSmallFixModel(
  prompt: string,
  evidence: EvidenceBundle,
  options: SmallFixOptions,
  detected: { targetFile: string },
  attempt = 1,
): Promise<{
  answer: SmallFixAnswer;
  modelPolicy?: ResolvedModelPolicy;
  executionMode?: SmallFixExecutionMode;
}> {
  const modelPolicy = options.model
    ? resolveFamilyModelPolicy({
        family: options.model,
        ...(options.modelTier !== undefined ? { requestedTier: options.modelTier } : {}),
        ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
        babelRoot: BABEL_ROOT,
      })
    : undefined;

  const provider = resolveSmallFixProvider(options);
  if (provider === 'live') {
    assertLiveProviderCredential(modelPolicy?.provider);
  }
  if (provider === 'mock') {
    const offlineAnswer = tryOfflineDemoAnswer(options, detected);
    if (!offlineAnswer) {
      throw new Error(
        'Offline demo fix (--provider mock / BABEL_LITE_OFFLINE=1) is only supported for lite-trust-demo and parity-corpus fixture tasks.',
      );
    }
    appendDirectSmallFixTelemetry({
      evidence,
      metadata: null,
      succeeded: true,
      errorSummary: null,
      provider: 'mock',
      attempt,
    });
    return { answer: offlineAnswer, executionMode: 'offline_demo' };
  }

  if (modelPolicy?.provider === 'deepinfra' || modelPolicy?.provider === 'deepseek') {
    const policyProvider = modelPolicy.provider;
    const runner =
      policyProvider === 'deepseek'
        ? new DeepSeekApiRunner(modelPolicy.providerModelId)
        : new DeepInfraApiRunner(modelPolicy.providerModelId);
    try {
      const answer = await runner.execute(prompt, SmallFixAnswerSchema);
      const metadata = runner.getLastInvocationMetadata?.() ?? null;
      if (
        metadata?.provider_model_id &&
        metadata.prompt_tokens !== null &&
        metadata.completion_tokens !== null
      ) {
        globalCostTracker.trackUsage(
          metadata.provider_model_id,
          metadata.prompt_tokens,
          metadata.completion_tokens,
          metadata.prompt_cache_hit_tokens,
          metadata.prompt_cache_miss_tokens,
        );
      }
      appendDirectSmallFixTelemetry({
        evidence,
        metadata,
        succeeded: true,
        errorSummary: null,
        provider: policyProvider,
        attempt,
      });
      return { answer, modelPolicy, executionMode: 'live' };
    } catch (error: unknown) {
      appendDirectSmallFixTelemetry({
        evidence,
        metadata: runner.getLastInvocationMetadata?.() ?? null,
        succeeded: false,
        errorSummary: error instanceof Error ? error.message : String(error),
        provider: policyProvider,
        attempt,
      });
      throw error;
    }
  }

  const answer = await runWithPrimaryOnlyFallback(prompt, SmallFixAnswerSchema, {
    evidence,
    stage: 'executor',
    schemaName: 'SmallFixAnswerSchema',
    maxCliAttempts: 1,
  });
  return {
    answer,
    ...(modelPolicy !== undefined ? { modelPolicy } : {}),
    executionMode: 'live',
  };
}

export async function runSmallFixPath(options: SmallFixOptions): Promise<SmallFixResult> {
  if (isAmbiguousBroadRefactor(options.task)) {
    return {
      status: 'SMALL_FIX_NOT_APPLICABLE',
      reason:
        "Broad refactor tasks are not supported in the fix lane. Please specify the target files you wish to edit, or use the 'deep' lane for governed planning.",
    };
  }

  const planHandoff =
    options.planHandoff ??
    (options.projectRoot
      ? loadPlanHandoff({
          repoPath: options.projectRoot,
          task: options.task,
          ...(options.planRunId !== undefined ? { planRunId: options.planRunId } : {}),
        })
      : null);
  let detected = detectSmallFix(options);
  let discoveryBundle: FixDiscoveryBundle | null = null;

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

  if ((detected.mode === 'dual' || detected.mode === 'multi') && !options.forcedTargetFile) {
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

    // Checkpoint all files before mutation
    const originalContents = new Map<string, string>();
    const originalHashes = new Map<string, string>();
    const originalByteLengths = new Map<string, number>();

    for (const file of targets) {
      const filePath = resolve(detected.projectRoot, file);
      const content = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
      originalContents.set(file, content);
      originalHashes.set(file, hashText(content));
      originalByteLengths.set(file, byteLengthUtf8(content));
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

    const scopeBeforePath = join(evidence.runDir, 'small_fix_scope_before.json');
    writeJsonArtifact(scopeBeforePath, {
      schema_version: 1,
      scope_artifact_type: 'small_fix_scope_before_mutation',
      target_files: targets,
      project_root: detected.projectRoot,
      inferred_scope: 'multi_file_coordinated_scope',
      normalized: true,
      next_step_hint: 'run small-fix checkpoint restore after verification if needed',
    });

    // 1. Initial Mutation Loop: edit each file sequentially (without running verifier between edits)
    const currentContents = new Map<string, string>(originalContents);
    let modelPolicy: ResolvedModelPolicy | undefined;
    let executionMode: SmallFixExecutionMode = 'live';
    let lastSummary = 'Multi-file fix applied';

    try {
      for (const targetFile of targets) {
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

        const modelResult = await runSmallFixModel(prompt, evidence, options, { targetFile });
        currentContents.set(targetFile, modelResult.answer.replacement_content);
        if (modelResult.modelPolicy) {
          modelPolicy = modelResult.modelPolicy;
        }
        if (modelResult.executionMode) {
          executionMode = modelResult.executionMode;
        }
        lastSummary = modelResult.answer.summary;

        // Write file locally
        const filePath = resolve(detected.projectRoot, targetFile);
        writeFileSync(filePath, modelResult.answer.replacement_content, 'utf-8');
      }
    } catch (error: unknown) {
      options.progress?.finish('fail', 'Model call failed');
      const classified = classifySmallFixProviderFailure(error);
      const message = classified.message;
      const failureCode = classified.failureCode;
      const failureCapsulePath = join(evidence.runDir, 'small_fix_failure_capsule.json');
      evidence.writeDebugFile(
        'small_fix_failure_capsule.json',
        `${JSON.stringify(
          {
            schema_version: 1,
            failure_capsule_id: `small_fix_${evidence.runId}`,
            category: failureCode,
            failure_code: failureCode,
            retryable: true,
            recoverable: true,
            next: classified.next,
            condition: message,
            task: options.task,
            project_root: detected.projectRoot,
            target_file: targets[0],
            verifier_command: verifierCommand,
            credential_env_key: failureCode === 'credential_missing' ? liveProviderEnvKey() : null,
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
      throw makeRecoverableRunError(message, evidence.runDir, failureCode, classified.next);
    }

    // 2. Shared Verifier Run & Coordinated Repair Loop
    const maxRepairAttempts =
      options.maxRepairAttempts ??
      (resolveSmallFixProvider(options) === 'mock' ? 1 : resolveSmallFixMaxRepairAttempts());
    const repairTimeline: SmallFixRepairAttemptRecord[] = [];

    // Run verifier initially
    const verifierRun = spawnSync(
      process.platform === 'win32' ? 'cmd.exe' : 'sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', verifierCommand] : ['-c', verifierCommand],
      { cwd: detected.projectRoot, encoding: 'utf-8', timeout: 30_000 },
    );
    let verifierExit = verifierRun.status ?? 1;
    let verifierStdout = verifierRun.stdout ?? '';
    let verifierStderr = verifierRun.stderr ?? '';

    for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
      const verifyPassed = verifierExit === 0;
      const attemptStatus = verifyPassed ? 'passed' : 'failed';
      repairTimeline.push({
        attempt,
        status: attemptStatus,
        verifier_exit_code: verifierExit,
        verifier_stdout_summary: verifierStdout.slice(0, 500),
        verifier_stderr_summary: verifierStderr.slice(0, 500),
        changed_files: targets,
      });

      if (verifyPassed) {
        break;
      }
      if (attempt >= maxRepairAttempts) {
        break;
      }

      options.progress?.report(
        'verify',
        `Verifier failed — coordinated repair attempt ${attempt + 1}/${maxRepairAttempts}`,
      );

      // Repair each file sequentially using the shared verifier feedback!
      for (const targetFile of targets) {
        options.progress?.report('model', `Repairing ${targetFile}…`);
        const repairPrompt = buildRepairPrompt({
          task: options.task,
          projectRoot: detected.projectRoot,
          targetFile,
          verifierCommand,
          attempt: attempt + 1,
          maxAttempts: maxRepairAttempts,
          verifierExitCode: verifierExit,
          verifierStdout,
          verifierStderr,
          currentFileContent: currentContents.get(targetFile)!,
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
        currentContents.set(targetFile, repairModel.answer.replacement_content);

        // Write file locally
        const filePath = resolve(detected.projectRoot, targetFile);
        writeFileSync(filePath, repairModel.answer.replacement_content, 'utf-8');
      }

      // Rerun verifier after repair
      const nextRun = spawnSync(
        process.platform === 'win32' ? 'cmd.exe' : 'sh',
        process.platform === 'win32'
          ? ['/d', '/s', '/c', verifierCommand]
          : ['-c', verifierCommand],
        { cwd: detected.projectRoot, encoding: 'utf-8', timeout: 30_000 },
      );
      verifierExit = nextRun.status ?? 1;
      verifierStdout = nextRun.stdout ?? '';
      verifierStderr = nextRun.stderr ?? '';
    }

    const repairTimelinePath = join(evidence.runDir, 'repair_attempt_timeline.json');
    writeJsonArtifact(repairTimelinePath, {
      schema_version: 1,
      artifact_type: 'babel_small_fix_repair_timeline',
      max_attempts: maxRepairAttempts,
      attempts: repairTimeline,
    });

    const verifierOk = verifierExit === 0;

    // Post-execution: checkpoint rollback if failed
    if (!verifierOk) {
      options.progress?.report('verify', `Verification failed. Rolling back changes…`);
      for (const [file, content] of originalContents) {
        const filePath = resolve(detected.projectRoot, file);
        writeFileSync(filePath, content, 'utf-8');
      }
    }

    // Write terminal status summary
    const status: 'SMALL_FIX_COMPLETE' | 'SMALL_FIX_FAILED' = verifierOk
      ? 'SMALL_FIX_COMPLETE'
      : 'SMALL_FIX_FAILED';
    const changedFiles = verifierOk ? targets : [];

    const summaryPath = join(evidence.runDir, 'terminal_status_summary.json');
    writeJsonArtifact(summaryPath, {
      schema_version: 1,
      artifact_type: 'babel_terminal_status_summary',
      status,
      reason_category: verifierOk ? 'none' : 'verifier_failed',
      failed_command: verifierOk ? null : verifierCommand,
      changed_files: changedFiles,
      change_disposition: verifierOk ? 'applied' : 'rolled_back',
      rollback_mode: verifierOk ? 'none' : 'restore_original',
      failure_capsule_path: null,
      next_recommended_operator_action: verifierOk
        ? []
        : ['inspect verifier output', 'run manually'],
      attempt_safety_summary_path: null,
      repair_attempt_timeline_path: repairTimelinePath,
      condition_summary: verifierOk ? null : 'Verifier failed.',
      verifier_contract: {
        schema_version: 1,
        verifier_command: verifierCommand,
        exit_code: verifierExit,
        passed: verifierOk,
      },
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
      checks: verifierOk ? [] : [`verifier failed: ${verifierCommand}`],
      summary: lastSummary,
      usageSummary,
      ...(modelPolicy !== undefined ? { modelPolicy } : {}),
      executionMode,
      sessionLoopSteps: [...(discoveryBundle?.discovery.sessionLoopSteps ?? [])],
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
      reason: 'Multi-file small fix must run through sequential or coordinated passes.',
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
    ...(options.sparkSynthesis ? { spark_synthesis: options.sparkSynthesis } : {}),
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
    next_step_hint: 'run small-fix checkpoint restore after verification if needed',
  });

  let answer: SmallFixAnswer;
  let modelPolicy: ResolvedModelPolicy | undefined;
  let executionMode: SmallFixExecutionMode = 'live';
  try {
    options.progress?.report('model', 'Calling model…');
    const modelResult = await runSmallFixModel(prompt, evidence, options, { targetFile });
    answer = modelResult.answer;
    modelPolicy = modelResult.modelPolicy;
    executionMode = modelResult.executionMode ?? 'live';
    options.progress?.report('model', 'Model patch ready');
  } catch (error: unknown) {
    options.progress?.finish('fail', 'Model call failed');
    const classified = classifySmallFixProviderFailure(error);
    const message = classified.message;
    const failureCode = classified.failureCode;
    const failureCapsulePath = join(evidence.runDir, 'small_fix_failure_capsule.json');
    evidence.writeDebugFile(
      'small_fix_failure_capsule.json',
      `${JSON.stringify(
        {
          schema_version: 1,
          failure_capsule_id: `small_fix_${evidence.runId}`,
          category: failureCode,
          failure_code: failureCode,
          retryable: true,
          recoverable: true,
          next: classified.next,
          condition: message,
          task: options.task,
          project_root: detected.projectRoot,
          target_file: targetFile,
          verifier_command: verifierCommand,
          credential_env_key: failureCode === 'credential_missing' ? liveProviderEnvKey() : null,
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
    throw makeRecoverableRunError(message, evidence.runDir, failureCode, classified.next);
  }
  evidence.writeDebugFile('small_fix_answer.json', `${JSON.stringify(answer, null, 2)}\n`);

  options.progress?.report('patch', `Applying patch to ${targetFile}`);
  const toolContext = {
    agentId: 'small-fix',
    runId: evidence.runId,
    runDir: evidence.runDir,
    babelRoot: BABEL_ROOT,
  };
  const maxRepairAttempts =
    options.maxRepairAttempts ??
    (resolveSmallFixProvider(options) === 'mock' ? 1 : resolveSmallFixMaxRepairAttempts());
  const repairTimeline: SmallFixRepairAttemptRecord[] = [];
  let currentAnswer = answer;
  let mutationLoop = await runSmallFixMutationLoop({
    targetFile,
    projectRoot: detected.projectRoot,
    verifierCommand,
    replacementContent: currentAnswer.replacement_content,
    toolContext,
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
    const attemptStatus: SmallFixRepairAttemptRecord['status'] = mutationLoop.policyBlocked
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
      changed_files: writeResultAttempt && writeResultAttempt.exit_code === 0 ? [targetFile] : [],
    });

    if (
      verifyPassed ||
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
    });
  }

  const repairTimelinePath = join(evidence.runDir, 'repair_attempt_timeline.json');
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
        ...(discoveryBundle ? { discovery_steps: discoveryBundle.discovery.sessionLoopSteps } : {}),
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
      ? typeof writeResult.checkpoint_ids[writeResult.checkpoint_ids.length - 1] === 'string'
        ? (writeResult.checkpoint_ids[writeResult.checkpoint_ids.length - 1] as string)
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
    checkpointRecord.post_mutation = {
      checksum_sha256: afterHash,
      bytes_after: afterByteLength,
    };
  } else if (!writeResult || writeResult.exit_code !== 0) {
    status = 'SMALL_FIX_FAILED';
    checks.push(
      `file_write failed: ${writeResult?.stderr || writeResult?.stdout || 'unknown error'}`,
    );
    checkpointRecord.post_mutation = {
      checksum_sha256: afterHash,
      bytes_after: afterByteLength,
    };
  } else {
    afterContent = readFileSync(targetFilePath, 'utf-8');
    afterHash = hashText(afterContent);
    afterByteLength = byteLengthUtf8(afterContent);
    if (afterHash !== originalHash) {
      changedFiles.push(targetFile);
      checkpointRecord.changed_files = changedFiles;
      checkpointRecord.changed = true;
    }
    checks.push(changedFiles.length > 0 ? `updated ${targetFile}` : `no changes to ${targetFile}`);
    evidence.writeDebugFile(
      'changes.diff',
      buildChangesDiff(targetFile, originalContent, afterContent),
    );
    checkpointRecord.post_mutation = {
      checksum_sha256: afterHash,
      bytes_after: afterByteLength,
    };
  }
  checkpointRecord.post_mutation = checkpointRecord.post_mutation ?? {
    checksum_sha256: afterHash,
    bytes_after: afterByteLength,
  };
  writeJsonArtifact(join(evidence.runDir, 'small_fix_checkpoint.json'), {
    ...checkpointRecord,
  });
  if (preMutationCheckpointId) {
    options.progress?.report('checkpoint', 'Checkpoint saved');
  }

  let rollbackMode: 'none' | 'auto_restored' | 'preserved_for_inspection' =
    changedFiles.length > 0 ? 'preserved_for_inspection' : 'none';
  if (testResult) {
    options.progress?.report('verify', `Running ${verifierCommand}…`);
    evidence.writeDebugFile('small_fix_verifier_stdout.log', testResult.stdout);
    evidence.writeDebugFile('small_fix_verifier_stderr.log', testResult.stderr);
    checks.push(`${verifierCommand}: ${testResult.exit_code === 0 ? 'passed' : 'failed'}`);
    options.progress?.report(
      'verify',
      `${verifierCommand}: ${testResult.exit_code === 0 ? 'passed' : 'failed'}`,
    );
    if (testResult.exit_code !== 0) {
      status = 'SMALL_FIX_FAILED';
      if (repairTimeline.length >= maxRepairAttempts) {
        checks.push(`repair budget exhausted (${maxRepairAttempts} attempt(s))`);
      }
      if (options.rollbackOnFail === true && preMutationCheckpointId) {
        try {
          const { record } = findCheckpoint(preMutationCheckpointId, { runDir: evidence.runDir });
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
    const failureCode = mutationLoop.policyBlocked
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
          retryable: true,
          target_file: targetFile,
          verifier_command: verifierCommand,
          project_root: detected.projectRoot,
          changed_files: changedFiles,
          checks,
          condition: checks.join('; '),
          verifier_stdout_path: testResult
            ? join(evidence.runDir, 'small_fix_verifier_stdout.log')
            : null,
          verifier_stderr_path: testResult
            ? join(evidence.runDir, 'small_fix_verifier_stderr.log')
            : null,
          next_recommended_operator_action:
            options.rollbackOnFail === true && rollbackMode === 'auto_restored'
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
    status: status === 'SMALL_FIX_COMPLETE' ? 'EXECUTION_COMPLETE' : 'EXECUTION_HALTED',
    stage_status: status,
    steps_executed: discoveryToolLog.length + (testResult ? 2 : writeResult ? 1 : 0),
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

  let reasonCategory = status === 'SMALL_FIX_COMPLETE' ? 'small_fix_complete' : 'small_fix_failed';
  if (status === 'SMALL_FIX_COMPLETE' && !verifierContract.summary.verifierCompletionSatisfied) {
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
        : mutationLoop.policyBlocked
          ? 'policy_gate'
          : !writeResult || writeResult.exit_code !== 0
            ? 'file_write'
            : verifierCommand,
    changed_files: changedFiles,
    change_disposition:
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
        : rollbackMode === 'auto_restored'
          ? 'Verifier failed; workspace was restored. Adjust the fix and retry.'
          : 'Inspect verifier output and rerun with the verified pipeline if needed.',
    parseable_json_stdout_required: true,
    attempt_safety_summary_path: null,
    repair_attempt_timeline_path: repairTimeline.length > 0 ? repairTimelinePath : null,
    condition_summary: status === 'SMALL_FIX_COMPLETE' ? null : checks.join('; '),
    verifier_contract: verifierContract.summary,
  };
  evidence.writeDebugFile('terminal_status_summary.json', `${JSON.stringify(terminal, null, 2)}\n`);
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
