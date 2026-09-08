import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { aggregateTelemetry, sampleTelemetry } from './telemetry.js';
import { buildNeutralReceipt } from './receipt.js';
import { normalizeTrajectory } from './trajectory.js';
import { observeClaudeRecovery } from './recovery-observation.js';
import { OPENCODE_GO_DEFAULT_BASE_URL } from './openCodeGoApi.js';
import type { BenchmarkProfile, OpenCodeGoModel } from './models.js';
import type { ControlledRun, NeutralLabReceipt } from './contracts.js';
import { fixturePrompt, type FixtureInstance, type FixtureTaskId } from '../fixtures/claude-babel-astra-lab/fixtures.js';

const DEFAULT_RUN_TIMEOUT_MS = 85_000;
const ROUTATIC_LOG = join(homedir(), '.config', 'routatic-proxy', 'routatic-proxy.log');

export interface ClaudeHarnessCase {
  experimentId: string;
  pairId: string;
  taskId: FixtureTaskId;
  profile: BenchmarkProfile;
  model: OpenCodeGoModel;
  fixture: FixtureInstance;
  outputRoot: string;
  timeoutMs?: number;
  frozenPrompt?: string;
}

interface ClaudeProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  pid: number | null;
  signal: string | null;
  settled: boolean;
}

function claudeExecutable(): string {
  return process.env['BABEL_CLAUDE_CMD']?.trim() || join(homedir(), '.local', 'bin', 'claude.exe');
}

/** Observe version without launching a model session or reading credentials. */
export function observeClaudeVersion(): string {
  try {
    return execFileSync(claudeExecutable(), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 }).trim() || 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

function runClaudeProcess(input: ClaudeHarnessCase): Promise<ClaudeProcessResult> {
  const executable = claudeExecutable();
  const args = [
    '--print',
    '--model', input.model,
    '--tools', 'Read,Edit,Write,Bash',
    '--allowedTools', 'Read,Edit,Write,Bash',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'dontAsk',
    '--add-dir', input.fixture.root,
  ];
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: input.fixture.root,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancellationGrace: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      cancellationGrace = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ stdout, stderr, exitCode: null, timedOut, pid: child.pid ?? null, signal: null, settled: false });
      }, 5_000);
    }, input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
    child.on('error', () => {
      clearTimeout(timeout);
      if (cancellationGrace) clearTimeout(cancellationGrace);
      resolve({ stdout, stderr, exitCode: null, timedOut, pid: child.pid ?? null, signal: null, settled: true });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      if (cancellationGrace) clearTimeout(cancellationGrace);
      resolve({ stdout, stderr, exitCode, timedOut, pid: child.pid ?? null, signal, settled: true });
    });
    child.stdin.end(input.frozenPrompt ?? fixturePrompt(input.taskId));
  });
}

function parseJsonLines(raw: string): Record<string, unknown>[] {
  return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function boundaryObserved(model: OpenCodeGoModel, offset: number): boolean {
  try {
    const section = readFileSync(ROUTATIC_LOG).subarray(offset).toString('utf8');
    const exact = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`received request.*model=${exact}`,'i').test(section)
      && new RegExp(`routing request.*model=${exact} provider=opencode-go.*resolved model ${exact}`,'i').test(section)
      && new RegExp(`streaming completed.*model=${exact}`,'i').test(section);
  } catch {
    return false;
  }
}

function fixtureHeadSha(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

function changedFiles(root: string): string[] {
  return execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8', windowsHide: true })
    .split(/\r?\n/).filter(Boolean).map((line: string) => line.slice(3).trim()).filter(Boolean);
}

function buildReceipt(input: ClaudeHarnessCase, runId: string, start: string, end: string, processResult: ClaudeProcessResult, messages: readonly Record<string, unknown>[], rawPath: string, normalizedPath: string, metrics: ReturnType<typeof aggregateTelemetry>, verifier: { result: 'UNKNOWN'; detail: string }, observed: boolean, version: string): NeutralLabReceipt {
  const changed = changedFiles(input.fixture.root);
  const allowedChanges: Readonly<Record<FixtureTaskId, readonly string[]>> = { T1: ['answer.txt'], T2: ['src/math.js'], T4: ['src/format.js'] };
  const policyViolation = changed.some((path) => !allowedChanges[input.taskId].includes(path));
  const toolUses = messages.flatMap((message) => {
    const content = message['message'] && typeof message['message'] === 'object' ? (message['message'] as Record<string, unknown>)['content'] : message['content'];
    return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null && (block as Record<string, unknown>)['type'] === 'tool_use') : [];
  });
  const usage = messages.map((message) => (message['usage'] && typeof message['usage'] === 'object' ? message['usage'] as Record<string, unknown> : null)).filter((value): value is Record<string, unknown> => value !== null);
  const sumUsage = (key: string): number | 'UNKNOWN' => {
    const values = usage.map((entry) => entry[key]).filter((value): value is number => typeof value === 'number');
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : 'UNKNOWN';
  };
  const commands = toolUses.map((tool) => (tool['input'] && typeof tool['input'] === 'object' ? (tool['input'] as Record<string, unknown>)['command'] : undefined)).filter((value): value is string => typeof value === 'string');
  const receiptInput = {
    EXPERIMENT_ID: input.experimentId,
    PAIR_ID: input.pairId,
    RUN_ID: runId,
    SUPERVISOR: 'astra',
    HARNESS: 'claude-code' as const,
    HARNESS_VERSION: version,
    HARNESS_ADAPTER: 'claude-cli',
    HARNESS_ADAPTER_VERSION: 'stream-json-v1',
    PROVIDER: observed ? 'opencode-go' : 'UNKNOWN',
    PROVIDER_ROUTE: `${OPENCODE_GO_DEFAULT_BASE_URL}/chat/completions`,
    REQUESTED_MODEL: input.model,
    OBSERVED_MODEL: observed ? input.model : 'UNKNOWN',
    TASK_ID: input.taskId,
    REPOSITORY: input.fixture.root,
    BASE_SHA: input.fixture.baseSha,
    HEAD_SHA: fixtureHeadSha(input.fixture.root),
    START_TIME: start,
    END_TIME: end,
    WALL_TIME: Date.parse(end) - Date.parse(start),
    PROCESS_IDS: processResult.pid === null ? [] : [processResult.pid],
    PROCESS_COUNT: metrics.processCount,
    PEAK_WORKING_SET: metrics.peakWorkingSet,
    CPU_TIME: metrics.cpuTimeMs,
    DISK_READ_BYTES: metrics.diskReadBytes,
    DISK_WRITE_BYTES: metrics.diskWriteBytes,
    MODEL_CALLS: messages.filter((message) => message['type'] === 'assistant').length,
    INPUT_TOKENS: sumUsage('input_tokens'),
    OUTPUT_TOKENS: sumUsage('output_tokens'),
    CACHED_TOKENS: sumUsage('cache_read_input_tokens'),
    TOOL_CALLS: toolUses.length,
    FILES_READ: toolUses.map((tool) => (tool['input'] && typeof tool['input'] === 'object' ? (tool['input'] as Record<string, unknown>)['file_path'] : undefined)).filter((value): value is string => typeof value === 'string'),
    FILES_CHANGED: changed,
    TEST_COMMANDS: commands.filter((command) => /test|npm|node --test/i.test(command)),
    TEST_RESULTS: { result: verifier.result, detail: verifier.detail, claude_exit_code: processResult.exitCode ?? 'UNKNOWN', timed_out: processResult.timedOut },
    REPAIR_LOOPS: 'UNKNOWN' as const,
    CONTEXT_COMPACTIONS: 'UNKNOWN' as const,
    TERMINAL_CLAIM: messages.find((message) => message['type'] === 'result')?.['subtype'] as string ?? (processResult.timedOut ? 'TIMEOUT' : 'UNKNOWN'),
    VERIFIER_RESULT: verifier.result,
    FALSE_COMPLETION: 'UNKNOWN' as const,
    POLICY_VIOLATION: policyViolation,
    HUMAN_INTERVENTIONS: 0,
    RAW_TRAJECTORY_PATH: rawPath,
    NORMALIZED_TRAJECTORY_PATH: normalizedPath,
    // Shared proxy log lines are route evidence, not per-invocation fallback proof.
    FALLBACK_USED: 'UNKNOWN' as const,
  } satisfies Omit<NeutralLabReceipt, 'RECEIPT_HASH'>;
  return buildNeutralReceipt(receiptInput);
}

/** Execute one Claude Code turn through the existing Routatic/OpenCode Go path. */
export async function runClaudeLiveCase(input: ClaudeHarnessCase): Promise<ControlledRun> {
  const runId = `claude-${input.profile}-${input.taskId.toLowerCase()}-${Date.now()}`;
  const rawPath = join(input.outputRoot, input.profile, input.pairId, `${runId}.jsonl`);
  const start = new Date().toISOString();
  const version = observeClaudeVersion();
  let beforeLog: number | undefined;
  try { beforeLog = statSync(ROUTATIC_LOG).size; } catch { /* Missing route evidence stays UNKNOWN. */ }
  const before = sampleTelemetry();
  const processResult = await runClaudeProcess(input);
  const messages = parseJsonLines(processResult.stdout);
  const observed = beforeLog !== undefined && boundaryObserved(input.model, beforeLog);
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, processResult.stdout, 'utf8');
  const normalizedPath = rawPath.replace(/\.jsonl$/, '.normalized.jsonl');
  writeFileSync(normalizedPath, normalizeTrajectory(processResult.stdout), 'utf8');
  // The comparison runner exclusively owns independent evaluation. Never execute contestant-owned npm scripts here.
  const verifier = { result: 'UNKNOWN' as const, detail: 'NOT_EVALUATED: independent evaluator belongs to the comparison runner' };
  const after = sampleTelemetry();
  const metrics = aggregateTelemetry([before, after], processResult.exitCode === 0 && !processResult.timedOut ? 'PASS' : 'UNKNOWN');
  const end = new Date().toISOString();
  const receipt = buildReceipt(input, runId, start, end, processResult, messages, rawPath, normalizedPath, metrics, verifier, observed, version);
  writeFileSync(rawPath.replace(/\.jsonl$/, '.receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return {
    receipt,
    profile: input.profile,
    exactModel: input.model,
    fixtureSha: input.fixture.baseSha,
    verifier: { result: verifier.result, deterministic: false },
    rawTrajectory: rawPath,
    normalizedTrajectory: normalizedPath,
    resourceMetrics: metrics,
    audit: {
      executionSuccess: processResult.exitCode === 0 && !processResult.timedOut && messages.some((message) => message['type'] === 'result' && message['subtype'] === 'success'),
      termination: {
        kind: !processResult.settled ? 'PROCESS_HANG' : processResult.timedOut ? 'RUNNER_TIMEOUT' : processResult.signal ? 'EXTERNAL_INTERRUPTION' : processResult.exitCode === 0 ? 'NORMAL' : 'HARNESS_FAILURE',
        evidence: [`Claude process exit=${processResult.exitCode ?? 'UNKNOWN'} signal=${processResult.signal ?? 'NONE'} runnerDeadlineTriggered=${processResult.timedOut} processClosed=${processResult.settled}; descendant process cleanup not independently observed`],
      },
      observedProvider: observed ? 'opencode-go' : 'UNKNOWN',
      observedModel: observed ? input.model : 'UNKNOWN',
      fallback: 'UNKNOWN',
      ...observeClaudeRecovery(messages),
    },
  };
}
