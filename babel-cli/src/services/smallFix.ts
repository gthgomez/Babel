import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { z } from 'zod';

import { BABEL_ROOT, BABEL_RUNS_DIR } from '../cli/constants.js';
import type { EvidenceBundle } from '../evidence.js';
import {
  beginLiteEvidenceSession,
  writeLiteManifest,
  writeLiteRequest,
} from '../agent/liteArtifacts.js';
import { findCheckpoint, restoreCheckpoint } from './checkpoints.js';
import { runWithPrimaryOnlyFallback } from '../execute.js';
import { resolveFamilyModelPolicy, type ResolvedModelPolicy } from '../modelPolicy.js';
import { runSmallFixMutationLoop } from '../agent/lanes/smallFixLoop.js';
import type { RunnerInvocationMetadata } from '../runners/base.js';
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js';
import { globalCostTracker, type SessionUsageSummary } from './costTracker.js';
import {
  buildCostLedger,
  usageSummaryFromCostLedger,
} from './costLedger.js';
import type { SparkSynthesis } from './babelFull.js';

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

export interface SmallFixOptions {
  task: string;
  projectRoot?: string;
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
  if (beforeLines.length === 1 && beforeLines[0] === '' && afterLines.length === 1 && afterLines[0] === '') {
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

function extractOnlyEditFile(task: string): string | null {
  const patterns = [
    /\bonly\s+(?:edit|modify|change|touch)\s+[`'"]?([A-Za-z0-9_.\-\\/]+\.[A-Za-z0-9]+)[`'"]?/i,
    /\bedit\s+only\s+[`'"]?([A-Za-z0-9_.\-\\/]+\.[A-Za-z0-9]+)[`'"]?/i,
  ];
  for (const pattern of patterns) {
    const match = task.match(pattern);
    if (match?.[1]) {
      return normalizeRelativePath(match[1]);
    }
  }
  return null;
}

function extractVerifierCommand(task: string): string | null {
  const explicit = task.match(/\brun\s+([A-Za-z0-9_.\-\\/]+(?:\s+[A-Za-z0-9_.\-\\/]+){0,3})\s+before\s+(?:completing|completion|finishing)/i);
  const candidate = explicit?.[1]?.trim().replace(/[.。]+$/, '');
  if (candidate && LOCAL_VERIFIER_COMMANDS.some(pattern => pattern.test(candidate))) {
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
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { scripts?: Record<string, unknown> };
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
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'coverage') {
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
  const match = normalized.match(/\bfailing\s+([a-z0-9_-]+)\s+test\b/) ??
    normalized.match(/\bfix\s+the\s+([a-z0-9_-]+)\s+test\b/);
  return match?.[1] ?? null;
}

function sourceForTestFile(projectRoot: string, testFile: string): string | null {
  const candidates = [
    testFile.replace(/(?:\.test|\.spec)(\.[^.]+)$/i, '$1'),
    testFile.replace(/__tests__\//i, '').replace(/(?:\.test|\.spec)(\.[^.]+)$/i, '$1'),
  ].filter(candidate => candidate !== testFile);
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
  if (!/\b(fix|repair)\b/.test(normalized) || !/\b(failing|failed|broken)\b/.test(normalized) || !/\btest\b/.test(normalized)) {
    return null;
  }

  const descriptor = taskDescriptor(task);
  const files = collectCandidateFiles(projectRoot);
  const testFiles = files.filter(file => /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file));
  const candidates = new Set<string>();

  if (descriptor) {
    for (const file of files) {
      const base = basename(file).replace(/\.[^.]+$/, '').toLowerCase();
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

export function detectSmallFix(options: Pick<SmallFixOptions, 'task' | 'projectRoot'>): {
  targetFile: string;
  verifierCommand: string;
  projectRoot: string;
} | null {
  if (!options.projectRoot) {
    return null;
  }
  const projectRoot = resolve(options.projectRoot);
  const targetFile = inferTargetFile(options.task, projectRoot);
  const verifierCommand = extractVerifierCommand(options.task) ?? readPackageTestCommand(projectRoot);
  if (!targetFile || !verifierCommand) {
    return null;
  }
  const absoluteTarget = resolve(projectRoot, targetFile);
  if (!isInsideRoot(projectRoot, absoluteTarget) || !existsSync(absoluteTarget)) {
    return null;
  }
  return { targetFile, verifierCommand, projectRoot };
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
    '',
    'Return exactly:',
    '{"schema_version":1,"summary":"what changed","replacement_content":"entire new file content","confidence":"high"}',
    '',
    `Task: ${input.task}`,
    '',
    `# Target file: ${input.targetFile}`,
    trimForPrompt(readFileSync(absTarget, 'utf-8'), 7000),
    '',
    '# Nearby tests',
    readNearbyTests(input.projectRoot, input.targetFile),
    '',
    '# package.json',
    existsSync(packageJson) ? trimForPrompt(readFileSync(packageJson, 'utf-8'), 2000) : 'No package.json found.',
  ].join('\n');
}

function liveProviderEnvKey(): 'DEEPINFRA_API_KEY' {
  return 'DEEPINFRA_API_KEY';
}

function assertLiveProviderCredential(provider?: string, env: NodeJS.ProcessEnv = process.env): void {
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
      message: 'DEEPSEEK_API_KEY is not set. Direct DeepSeek requires DEEPSEEK_API_KEY in environment or .env. Adjust key or run Full Babel (governed mode) to allow backup cascading.',
      next: ['check DEEPSEEK_API_KEY', 'bl undo'],
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
      next: ['check DEEPINFRA_API_KEY', 'bl undo'],
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
      next: [isDeepSeek ? 'check DEEPSEEK_API_KEY' : 'check DEEPINFRA_API_KEY', 'bl undo'],
    };
  }
  if (/timeout/i.test(message)) {
    const isDeepSeek = /\[deepSeekApi\]/i.test(message) || /DEEPSEEK_API_KEY/i.test(message);
    return {
      failureCode: 'provider_timeout',
      message,
      next: [isDeepSeek ? 'check DEEPSEEK_API_KEY' : 'check DEEPINFRA_API_KEY', 'bl undo'],
    };
  }
  if (/zod|schema|invalid json|parse/i.test(message)) {
    return {
      failureCode: 'provider_schema_invalid',
      message,
      next: ['Retry the fix with the same task', 'bl undo'],
    };
  }
  if (/waterfall failed/i.test(message) || /all \d+ runner/i.test(message)) {
    return {
      failureCode: 'provider_request_failed',
      message: `${message}. [Recovery Hint] Stage execution failed under 'primary_only' policy. Please ensure the primary provider API key is set, or run in Full Babel mode (governed mode) to allow backup cascades.`,
      next: ['check DEEPSEEK_API_KEY', 'check DEEPINFRA_API_KEY', 'bl undo'],
    };
  }
  const isDeepSeek = /\[deepSeekApi\]/i.test(message) || /DEEPSEEK_API_KEY/i.test(message);
  return {
    failureCode: 'provider_request_failed',
    message,
    next: [isDeepSeek ? 'check DEEPSEEK_API_KEY' : 'check DEEPINFRA_API_KEY', 'bl undo'],
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
const PARITY_CORPUS_FIXTURE_DIR = join(
  BABEL_ROOT,
  'babel-cli',
  'src',
  'fixtures',
  'conformance-corpus',
);

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
  return paths.filter(path => existsSync(path));
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
      .map(taskId => join(PARITY_CORPUS_FIXTURE_DIR, `${taskId}.json`))
      .filter(path => existsSync(path));
  } catch {
    return [];
  }
}

function offlineDemoAnswerFromFixture(
  options: SmallFixOptions,
  detected: { targetFile: string },
  fixturePath: string,
  expectedFixtureType: 'babel_lite_trust_demo' | 'babel_conformance_corpus_task',
): SmallFixAnswer | null {
  try {
    const parsed = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
      fixture_type?: string;
      task?: string;
      target_file?: string;
      fixed_implementation?: string;
      mock_provider_answer?: string;
    };
    if (
      parsed.fixture_type !== expectedFixtureType ||
      typeof parsed.task !== 'string' ||
      typeof parsed.target_file !== 'string' ||
      typeof parsed.fixed_implementation !== 'string'
    ) {
      return null;
    }
    if (options.task.trim() !== parsed.task.trim() || detected.targetFile !== parsed.target_file) {
      return null;
    }
    const replacement = typeof parsed.mock_provider_answer === 'string'
      ? parsed.mock_provider_answer
      : parsed.fixed_implementation;
    return {
      schema_version: 1,
      summary: expectedFixtureType === 'babel_conformance_corpus_task'
        ? 'Updated conformance fixture implementation (offline demo).'
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
    const answer = offlineDemoAnswerFromFixture(options, detected, fixturePath, 'babel_lite_trust_demo');
    if (answer) {
      return answer;
    }
  }
  for (const fixturePath of listParityCorpusFixturePaths()) {
    const answer = offlineDemoAnswerFromFixture(options, detected, fixturePath, 'babel_conformance_corpus_task');
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
    attempts_detail: [{
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
    }],
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
): Promise<{ answer: SmallFixAnswer; modelPolicy?: ResolvedModelPolicy; executionMode?: SmallFixExecutionMode }> {
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
        'Offline demo fix (--provider mock / BABEL_LITE_OFFLINE=1) is only supported for lite-trust-demo and conformance-corpus fixture tasks.',
      );
    }
    appendDirectSmallFixTelemetry({
      evidence,
      metadata: null,
      succeeded: true,
      errorSummary: null,
      provider: 'mock',
      attempt: 1,
    });
    return { answer: offlineAnswer, executionMode: 'offline_demo' };
  }

  if (modelPolicy?.provider === 'deepinfra' || modelPolicy?.provider === 'deepseek') {
    const policyProvider = modelPolicy.provider;
    const runner = policyProvider === 'deepseek'
      ? new DeepSeekApiRunner(modelPolicy.providerModelId)
      : new DeepInfraApiRunner(modelPolicy.providerModelId);
    try {
      const answer = await runner.execute(prompt, SmallFixAnswerSchema);
      const metadata = runner.getLastInvocationMetadata?.() ?? null;
      if (metadata?.provider_model_id && metadata.prompt_tokens !== null && metadata.completion_tokens !== null) {
        globalCostTracker.trackUsage(metadata.provider_model_id, metadata.prompt_tokens, metadata.completion_tokens);
      }
      appendDirectSmallFixTelemetry({ evidence, metadata, succeeded: true, errorSummary: null, provider: policyProvider, attempt: 1 });
      return { answer, modelPolicy, executionMode: 'live' };
    } catch (error: unknown) {
      appendDirectSmallFixTelemetry({
        evidence,
        metadata: runner.getLastInvocationMetadata?.() ?? null,
        succeeded: false,
        errorSummary: error instanceof Error ? error.message : String(error),
        provider: policyProvider,
        attempt: 1,
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

function writeLatestRunPointer(runDir: string, project?: string): void {
  const payload = `${JSON.stringify({
    run_dir: runDir,
    project: project ?? 'global',
    created_at: new Date().toISOString(),
  }, null, 2)}\n`;
  mkdirSync(BABEL_RUNS_DIR, { recursive: true });
  writeFileSync(join(BABEL_RUNS_DIR, '.latest.json'), payload, 'utf-8');
  if (project) {
    writeFileSync(join(BABEL_RUNS_DIR, `.latest.${project}.json`), payload, 'utf-8');
  }
}

export async function runSmallFixPath(options: SmallFixOptions): Promise<SmallFixResult> {
  const detected = detectSmallFix(options);
  if (!detected) {
    return {
      status: 'SMALL_FIX_NOT_APPLICABLE',
      reason: 'Task is not an explicit one-file fix with a local verifier command.',
    };
  }

  const { run: liteRun, evidence } = beginLiteEvidenceSession({
    command: 'fix',
    repoPath: detected.projectRoot,
  });
  writeLiteRequest(liteRun, {
    schema_version: 1,
    command: 'fix',
    task: options.task,
    project: options.project ?? null,
    project_root: detected.projectRoot,
    target_file: detected.targetFile,
    verifier_command: detected.verifierCommand,
    ...(options.sparkSynthesis ? { spark_synthesis: options.sparkSynthesis } : {}),
  });
  if (options.sparkSynthesis) {
    evidence.writeDebugFile('spark_synthesis.json', `${JSON.stringify(options.sparkSynthesis, null, 2)}\n`);
  }
  globalCostTracker.resetSession();
  const prompt = buildPrompt({
    task: options.task,
    projectRoot: detected.projectRoot,
    targetFile: detected.targetFile,
    verifierCommand: detected.verifierCommand,
  });
  evidence.writeCompiledContext('small_fix', prompt);
  const targetFile = detected.targetFile;
  const targetFilePath = resolve(detected.projectRoot, targetFile);
  const scopePath = join(evidence.runDir, 'small_fix_scope.json');
  evidence.writeDebugFile('small_fix_scope.json', `${JSON.stringify({
    schema_version: 1,
    selected_lane: 'small_fix',
    task: options.task,
    files_to_edit: [targetFile],
    checks_to_run: [detected.verifierCommand],
    inference: extractOnlyEditFile(options.task) ? 'explicit_one_file_scope' : 'local_test_context',
  }, null, 2)}\n`);
  const originalContent = readFileSync(targetFilePath, 'utf-8');
  const originalHash = hashText(originalContent);
  const originalByteLength = byteLengthUtf8(originalContent);
  const scopeBeforePath = join(evidence.runDir, 'small_fix_scope_before.json');
  writeJsonArtifact(scopeBeforePath, {
    schema_version: 1,
    scope_artifact_type: 'small_fix_scope_before_mutation',
    target_file: targetFile,
    project_root: detected.projectRoot,
    inferred_scope: extractOnlyEditFile(options.task) ? 'explicit_one_file_scope' : 'local_test_context',
    bytes_before: originalByteLength,
    sha256_before: originalHash,
    normalized: true,
    next_step_hint: 'run small-fix checkpoint restore after verification if needed',
  });

  let answer: SmallFixAnswer;
  let modelPolicy: ResolvedModelPolicy | undefined;
  let executionMode: SmallFixExecutionMode = 'live';
  try {
    const modelResult = await runSmallFixModel(prompt, evidence, options, detected);
    answer = modelResult.answer;
    modelPolicy = modelResult.modelPolicy;
    executionMode = modelResult.executionMode ?? 'live';
  } catch (error: unknown) {
    const classified = classifySmallFixProviderFailure(error);
    const message = classified.message;
    const failureCode = classified.failureCode;
    const failureCapsulePath = join(evidence.runDir, 'small_fix_failure_capsule.json');
    evidence.writeDebugFile('small_fix_failure_capsule.json', `${JSON.stringify({
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
      target_file: detected.targetFile,
      verifier_command: detected.verifierCommand,
      credential_env_key: failureCode === 'credential_missing' ? liveProviderEnvKey() : null,
      next_recommended_operator_action: classified.next.join('; '),
    }, null, 2)}\n`);
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
    evidence.writeDebugFile('terminal_status_summary.json', `${JSON.stringify({
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
    }, null, 2)}\n`);
    evidence.writeWaterfallTelemetry();
    evidence.writeCostLedger(buildCostLedger({
      runId: evidence.runId,
      task: options.task,
      lane: 'small_fix',
      waterfallEntries: evidence.getWaterfallLogSnapshot(),
    }));
    writeLatestRunPointer(evidence.runDir, options.project);
    throw makeRecoverableRunError(message, evidence.runDir, failureCode, classified.next);
  }
  evidence.writeDebugFile('small_fix_answer.json', `${JSON.stringify(answer, null, 2)}\n`);

  const toolContext = {
    agentId: 'small-fix',
    runId: evidence.runId,
    runDir: evidence.runDir,
    babelRoot: BABEL_ROOT,
  };
  const mutationLoop = await runSmallFixMutationLoop({
    targetFile,
    projectRoot: detected.projectRoot,
    verifierCommand: detected.verifierCommand,
    replacementContent: answer.replacement_content,
    toolContext,
  });
  evidence.writeDebugFile('small_fix_loop.json', `${JSON.stringify({
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
  }, null, 2)}\n`);

  const writeResult = mutationLoop.writeResult;
  const testResult = mutationLoop.testResult;

  const checks: string[] = [];
  let status: SmallFixCompleted['status'] = 'SMALL_FIX_COMPLETE';
  const preMutationCheckpointId = writeResult && Array.isArray(writeResult.checkpoint_ids) && writeResult.checkpoint_ids.length > 0
    ? typeof writeResult.checkpoint_ids[writeResult.checkpoint_ids.length - 1] === 'string'
      ? writeResult.checkpoint_ids[writeResult.checkpoint_ids.length - 1] as string
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
    checks.push(`file_write failed: ${writeResult?.stderr || writeResult?.stdout || 'unknown error'}`);
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
    evidence.writeDebugFile('changes.diff', buildChangesDiff(targetFile, originalContent, afterContent));
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

  let rollbackMode: 'none' | 'auto_restored' | 'preserved_for_inspection' = changedFiles.length > 0
    ? 'preserved_for_inspection'
    : 'none';
  if (testResult) {
    evidence.writeDebugFile('small_fix_verifier_stdout.log', testResult.stdout);
    evidence.writeDebugFile('small_fix_verifier_stderr.log', testResult.stderr);
    checks.push(`${detected.verifierCommand}: ${testResult.exit_code === 0 ? 'passed' : 'failed'}`);
    if (testResult.exit_code !== 0) {
      status = 'SMALL_FIX_FAILED';
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

  const failureCapsulePath = status === 'SMALL_FIX_COMPLETE'
    ? null
    : join(evidence.runDir, 'small_fix_failure_capsule.json');
  if (failureCapsulePath) {
    const failureCode = mutationLoop.policyBlocked
      ? 'policy_blocked'
      : !writeResult || writeResult.exit_code !== 0
        ? 'small_fix_write_failed'
        : 'verifier_failed';
    evidence.writeDebugFile('small_fix_failure_capsule.json', `${JSON.stringify({
      schema_version: 1,
      failure_capsule_id: `small_fix_${evidence.runId}`,
      category: failureCode,
      failure_code: failureCode,
      retryable: true,
      target_file: targetFile,
      verifier_command: detected.verifierCommand,
      project_root: detected.projectRoot,
      changed_files: changedFiles,
      checks,
      condition: checks.join('; '),
      verifier_stdout_path: testResult ? join(evidence.runDir, 'small_fix_verifier_stdout.log') : null,
      verifier_stderr_path: testResult ? join(evidence.runDir, 'small_fix_verifier_stderr.log') : null,
      next_recommended_operator_action: options.rollbackOnFail === true && rollbackMode === 'auto_restored'
        ? 'Verifier failed; checkpoint was auto-restored via --rollback-on-fail.'
        : 'Inspect verifier output and rerun with the verified pipeline if needed.',
      rollback_on_fail: options.rollbackOnFail === true,
      rollback_mode: rollbackMode,
    }, null, 2)}\n`);
  }

  const executionReport = {
    status: status === 'SMALL_FIX_COMPLETE' ? 'EXECUTION_COMPLETE' : 'EXECUTION_HALTED',
    stage_status: status,
    steps_executed: testResult ? 2 : writeResult ? 1 : 0,
    tool_call_log: [
      ...(writeResult ? [{
        step: 1,
        tool: 'file_write',
        target: detected.targetFile,
        exit_code: writeResult.exit_code,
        stdout: writeResult.stdout,
        stderr: writeResult.stderr,
        verified: writeResult.exit_code === 0,
        policy_blocked: mutationLoop.policyBlocked,
      }] : []),
      ...(testResult ? [{
        step: 2,
        tool: 'test_run',
        target: detected.verifierCommand,
        exit_code: testResult.exit_code,
        stdout: testResult.stdout,
        stderr: testResult.stderr,
        verified: testResult.exit_code === 0,
        policy_blocked: mutationLoop.steps.some((step) => step.phase === 'verify' && step.policyBlocked),
      }] : []),
    ],
    small_fix: {
      target_file: detected.targetFile,
      verifier_command: detected.verifierCommand,
      project_root: detected.projectRoot,
      summary: answer.summary,
    },
  };
  evidence.writeExecutionLog(executionReport);

  const terminal = {
    schema_version: 1,
    artifact_type: 'babel_terminal_status_summary',
    status,
    reason_category: status === 'SMALL_FIX_COMPLETE' ? 'small_fix_complete' : 'small_fix_failed',
    failed_command: status === 'SMALL_FIX_COMPLETE'
      ? null
      : mutationLoop.policyBlocked
        ? 'policy_gate'
        : !writeResult || writeResult.exit_code !== 0
          ? 'file_write'
          : detected.verifierCommand,
    changed_files: changedFiles,
    change_disposition: rollbackMode === 'auto_restored'
      ? 'auto_restored'
      : changedFiles.length > 0
        ? 'preserved_for_inspection'
        : 'none',
    rollback_mode: rollbackMode,
    failure_capsule_path: failureCapsulePath,
    next_recommended_operator_action: status === 'SMALL_FIX_COMPLETE'
      ? 'Review the changed file and commit when ready.'
      : rollbackMode === 'auto_restored'
        ? 'Verifier failed; workspace was restored. Adjust the fix and retry.'
        : 'Inspect verifier output and rerun with the verified pipeline if needed.',
    parseable_json_stdout_required: true,
    attempt_safety_summary_path: null,
    repair_attempt_timeline_path: null,
    condition_summary: status === 'SMALL_FIX_COMPLETE' ? null : checks.join('; '),
    verifier_contract: null,
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
  writeLatestRunPointer(evidence.runDir, options.project);
  const usageSummary = costLedger.entries.length > 0
    ? usageSummaryFromCostLedger(costLedger)
    : globalCostTracker.getSessionSummary();

  return {
    status,
    task: options.task,
    project: options.project ?? null,
    projectRoot: detected.projectRoot,
    targetFile,
    verifierCommand: detected.verifierCommand,
    runDir: evidence.runDir,
    scopePath,
    changedFiles,
    checks,
    summary: answer.summary,
    usageSummary,
    ...(modelPolicy !== undefined ? { modelPolicy } : {}),
    executionMode,
  };
}
