import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ZodType } from 'zod';
import { ChatEngine } from '../agent/chatEngine.js';
import type { LlmRunner, ProviderMessage, RunnerCallbacks, RunnerInvocationMetadata, ToolDefinition, ToolStreamEvent } from '../runners/base.js';
import { ProviderEngine } from '../runners/providerEngine.js';
import { OPENCODE_GO_DEFAULT_BASE_URL } from './openCodeGoApi.js';
import { buildNeutralReceipt } from './receipt.js';
import { normalizeTrajectory } from './trajectory.js';
import { aggregateTelemetry, sampleTelemetry } from './telemetry.js';
import { RecoveryObservation } from './recovery-observation.js';
import type { BenchmarkProfile, OpenCodeGoModel } from './models.js';
import type { ControlledRun, NeutralLabReceipt } from './contracts.js';
import { fixturePrompt, type FixtureInstance, type FixtureTaskId } from '../fixtures/claude-babel-astra-lab/fixtures.js';

const DEFAULT_RUN_TIMEOUT_MS = 85_000;

export interface BabelHarnessCase {
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

class ObservedRunner implements LlmRunner {
  readonly events: Array<Record<string, unknown>> = [];
  modelCalls = 0;
  inputTokens: number | 'UNKNOWN' = 'UNKNOWN';
  outputTokens: number | 'UNKNOWN' = 'UNKNOWN';
  observedProvider: string = 'UNKNOWN';
  observedModel: string = 'UNKNOWN';
  requestedModel: string = 'UNKNOWN';
  providerTimeout = false;
  readonly recovery = new RecoveryObservation();
  private readonly seenDiagnostics = new Set<string>();
  private readonly delegate: ProviderEngine;
  private readonly expectedModel: string;
  private identityMismatch = false;

  constructor(delegate: ProviderEngine, expectedModel: string) {
    this.delegate = delegate;
    this.expectedModel = expectedModel;
  }

  private begin(kind: string): void {
    this.modelCalls += 1;
    this.events.push({ event: 'model_request', kind, sequence: this.modelCalls });
  }

  private failed(kind: string, error: unknown): void {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
    if (code === 'TIMEOUT') this.providerTimeout = true;
    this.events.push({ event: 'model_response', kind, status: 'failed', code });
  }

  private end(kind: string): void {
    const metadata = this.delegate.getLastInvocationMetadata();
    if (!this.identityMismatch && typeof metadata?.provider === 'string') this.observedProvider = metadata.provider;
    if (typeof metadata?.requested_model_id === 'string') this.requestedModel = metadata.requested_model_id;
    if (!this.identityMismatch && typeof metadata?.observed_model_id === 'string') this.observedModel = metadata.observed_model_id;
    if (metadata?.provider && metadata.provider !== 'opencode-go' || metadata?.observed_model_id && metadata.observed_model_id !== this.expectedModel) this.identityMismatch = true;
    if (typeof metadata?.prompt_tokens === 'number') this.inputTokens = (typeof this.inputTokens === 'number' ? this.inputTokens : 0) + metadata.prompt_tokens;
    if (typeof metadata?.completion_tokens === 'number') this.outputTokens = (typeof this.outputTokens === 'number' ? this.outputTokens : 0) + metadata.completion_tokens;
    this.events.push({
      event: 'model_response',
      kind,
      provider: metadata?.provider ?? 'UNKNOWN',
      requested_model: metadata?.requested_model_id ?? 'UNKNOWN',
      observed_model: metadata?.observed_model_id ?? 'UNKNOWN',
      input_tokens: metadata?.prompt_tokens ?? 'UNKNOWN',
      output_tokens: metadata?.completion_tokens ?? 'UNKNOWN',
    });
  }

  async execute<T>(prompt: string, schema: ZodType<T, unknown>, callbacks?: RunnerCallbacks, systemPrompt?: string, signal?: AbortSignal): Promise<T> {
    this.begin('structured');
    try {
      const result = await this.delegate.execute(prompt, schema, callbacks, systemPrompt, signal);
      this.end('structured');
      return result;
    } catch (error) {
      this.failed('structured', error);
      throw error;
    }
  }

  async executeRaw(prompt: string, callbacks?: RunnerCallbacks, systemPrompt?: string, signal?: AbortSignal): Promise<string> {
    this.begin('raw');
    try {
      const result = await this.delegate.executeRaw(prompt, callbacks, systemPrompt, signal);
      this.end('raw');
      return result;
    } catch (error) {
      this.failed('raw', error);
      throw error;
    }
  }

  async *executeWithToolsStream(messages: ProviderMessage[], tools: ToolDefinition[], systemPrompt?: string, signal?: AbortSignal, toolChoice?: 'auto' | 'required', callbacks?: RunnerCallbacks): AsyncGenerator<ToolStreamEvent, void, undefined> {
    this.begin('native_tool_stream');
    const toolCalls = new Map(messages.flatMap((message) => message.tool_calls ?? []).map((call) => [call.id, call]));
    for (const message of messages.filter((item) => item.role === 'tool')) {
      const key = `${message.tool_call_id}:${message.content}`;
      if (this.seenDiagnostics.has(key)) continue;
      this.seenDiagnostics.add(key);
      this.events.push({ event: 'model_facing_tool_observation', tool_call_id: message.tool_call_id, diagnostic: message.content });
      const call = toolCalls.get(message.tool_call_id ?? '');
      if (call) {
        try {
          const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
          const target = args['command'] ?? args['path'] ?? args['file_path'];
          if (typeof target === 'string') this.recovery.modelFacing(call.function.name, target, message.content);
        } catch { /* Unparseable action identity does not establish diagnostic visibility. */ }
      }
    }
    try {
      for await (const event of this.delegate.executeWithToolsStream(messages, tools, systemPrompt, signal, toolChoice, callbacks)) {
        this.events.push({ event: event.type, ...(event.type === 'tool_use' ? { name: event.name, id: event.id } : {}) });
        yield event;
      }
      this.end('native_tool_stream');
    } catch (error) {
      this.failed('native_tool_stream', error);
      throw error;
    }
  }

  getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    return this.delegate.getLastInvocationMetadata();
  }
}

function fixtureHeadSha(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
}

function changedFiles(root: string): string[] {
  return execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8', windowsHide: true })
    .split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
}

function writeTrajectory(path: string, events: readonly Record<string, unknown>[]): string {
  const raw = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw, 'utf8');
  const normalizedPath = path.replace(/\.jsonl$/, '.normalized.jsonl');
  writeFileSync(normalizedPath, normalizeTrajectory(raw), 'utf8');
  return normalizedPath;
}

function receiptFor(input: BabelHarnessCase, runId: string, start: string, end: string, result: Record<string, unknown>, observer: ObservedRunner, runEvents: readonly Record<string, unknown>[], rawPath: string, normalizedPath: string, metrics: ReturnType<typeof aggregateTelemetry>, verifier: { result: 'UNKNOWN'; detail: string }): NeutralLabReceipt {
  const metadata = observer.getLastInvocationMetadata();
  const status = typeof result.status === 'string' ? result.status : 'UNKNOWN';
  const changed = changedFiles(input.fixture.root);
  const allowedChanges: Readonly<Record<FixtureTaskId, readonly string[]>> = {
    T1: ['answer.txt'],
    T2: ['src/math.js'],
    T4: ['src/format.js'],
  };
  const policyViolation = changed.some((path) => !allowedChanges[input.taskId].includes(path));
  const receiptInput = {
    EXPERIMENT_ID: input.experimentId,
    PAIR_ID: input.pairId,
    RUN_ID: runId,
    SUPERVISOR: 'astra',
    HARNESS: 'babel-live' as const,
    HARNESS_VERSION: 'chat-engine',
    HARNESS_ADAPTER: 'provider-engine',
    HARNESS_ADAPTER_VERSION: 'benchmark-opencode-go-v1',
    PROVIDER: observer.observedProvider !== 'UNKNOWN' ? observer.observedProvider : metadata?.provider ?? 'UNKNOWN',
    PROVIDER_ROUTE: `${OPENCODE_GO_DEFAULT_BASE_URL}/chat/completions`,
    REQUESTED_MODEL: observer.requestedModel !== 'UNKNOWN' ? observer.requestedModel : metadata?.requested_model_id ?? input.model,
    OBSERVED_MODEL: observer.observedModel,
    TASK_ID: input.taskId,
    REPOSITORY: input.fixture.root,
    BASE_SHA: input.fixture.baseSha,
    HEAD_SHA: fixtureHeadSha(input.fixture.root),
    START_TIME: start,
    END_TIME: end,
    WALL_TIME: Date.parse(end) - Date.parse(start),
    PROCESS_IDS: [process.pid],
    PROCESS_COUNT: metrics.processCount,
    PEAK_WORKING_SET: metrics.peakWorkingSet,
    CPU_TIME: metrics.cpuTimeMs,
    DISK_READ_BYTES: metrics.diskReadBytes,
    DISK_WRITE_BYTES: metrics.diskWriteBytes,
    MODEL_CALLS: observer.modelCalls,
    INPUT_TOKENS: observer.inputTokens,
    OUTPUT_TOKENS: observer.outputTokens,
    CACHED_TOKENS: metadata?.prompt_cache_hit_tokens ?? 'UNKNOWN',
    TOOL_CALLS: runEvents.filter((event) => event.event === 'tool_started').length,
    FILES_READ: runEvents.filter((event) => event.event === 'tool_started' && ['read_file', 'grep', 'glob', 'list_dir'].includes(String(event.tool))).map((event) => String(event.target)),
    FILES_CHANGED: changed,
    TEST_COMMANDS: runEvents.filter((event) => event.event === 'tool_started' && event.tool === 'run_command').map((event) => String(event.target)),
    TEST_RESULTS: verifier,
    REPAIR_LOOPS: 'UNKNOWN' as const,
    CONTEXT_COMPACTIONS: 'UNKNOWN' as const,
    TERMINAL_CLAIM: typeof result.outcome === 'string' ? result.outcome : status,
    VERIFIER_RESULT: verifier.result,
    FALSE_COMPLETION: 'UNKNOWN' as const,
    POLICY_VIOLATION: policyViolation,
    HUMAN_INTERVENTIONS: 0,
    RAW_TRAJECTORY_PATH: rawPath,
    NORMALIZED_TRAJECTORY_PATH: normalizedPath,
    FALLBACK_USED: observer.observedProvider === 'opencode-go' && observer.observedModel === input.model ? false : 'UNKNOWN',
  } satisfies Omit<NeutralLabReceipt, 'RECEIPT_HASH'>;
  return buildNeutralReceipt(receiptInput);
}

/** Execute one real Babel ChatEngine turn through the benchmark ProviderEngine. */
export async function runBabelLiveCase(input: BabelHarnessCase): Promise<ControlledRun> {
  const runId = `babel-${input.profile}-${input.taskId.toLowerCase()}-${Date.now()}`;
  const rawPath = join(input.outputRoot, input.profile, input.pairId, `${runId}.jsonl`);
  const start = new Date().toISOString();
  const before = sampleTelemetry();
  const delegate = new ProviderEngine({
    provider: 'opencode-go',
    modelId: input.model,
    credentialSource: 'opencode-auth-helper',
    benchmarkRunId: runId,
    requestTimeoutMs: Math.min(input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS),
    sampling: { maxTokens: 4096, temperature: 0 },
  });
  const observer = new ObservedRunner(delegate, input.model);
  const engine = new ChatEngine({
    task: input.taskId,
    projectRoot: input.fixture.root,
    runId,
    model: 'DeepSeek',
    maxTurns: 8,
    executionProfile: 'chat',
  });
  const privateEngine = engine as unknown as Record<string, unknown>;
  privateEngine['deliberationRunner'] = observer;
  privateEngine['synthesisRunner'] = observer;
  privateEngine['fallbackRunner'] = observer;
  const priorAutoApprove = process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
  const priorToolProfile = process.env['BABEL_TOOL_PROFILE'];
  const priorMemoryWriteback = process.env['BABEL_MEMORY_WRITEBACK'];
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_TOOL_PROFILE'] = 'native';
  process.env['BABEL_MEMORY_WRITEBACK'] = '0';
  const events: Array<Record<string, unknown>> = [{ event: 'task_started', task_id: input.taskId, model: input.model, provider: 'opencode-go' }];
  let result: Record<string, unknown> = { status: 'failed', outcome: 'UNKNOWN' };
  let runnerTimedOut = false;
  let settled = true;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let submission: Promise<unknown> | undefined;
  let nextToolId = 0;
  try {
    settled = false;
    submission = engine.submitMessage(input.frozenPrompt ?? fixturePrompt(input.taskId), {
      onAnswerChunk: (text) => events.push({ event: 'model_response', text }),
      onThought: (text) => events.push({ event: 'model_response', thought: text }),
      onToolStart: (tool, target) => {
        const id = nextToolId++;
        observer.recovery.start(String(id), tool, target);
        events.push({ event: 'tool_started', id, tool, target });
        return id;
      },
      onToolComplete: (id, detail, error, exitCode) => {
        const failed = error !== undefined || exitCode !== undefined && exitCode !== 0;
        observer.recovery.complete(String(id), failed ? false : true, detail ?? error ?? 'UNKNOWN');
        events.push({ event: failed ? 'tool_failed' : 'tool_completed', id, detail: detail ?? 'UNKNOWN', error: error ?? undefined, exit_code: exitCode ?? 'UNKNOWN' });
      },
      onFileChanged: (path) => events.push({ event: 'mutation_completed', path }),
    }).then((value) => { settled = true; return value; }, (error: unknown) => { settled = true; throw error; });
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => { runnerTimedOut = true; engine.cancel(); reject(new Error('RUNNER_TIMEOUT')); }, input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    });
    result = (await Promise.race([submission, timeout])) as unknown as Record<string, unknown>;
  } catch (error) {
    events.push({ event: 'run_failed', error: error instanceof Error && error.message.startsWith('TIMEOUT:') ? 'TIMEOUT' : 'BABEL_HARNESS_FAILURE' });
    result = { status: 'failed', outcome: error instanceof Error ? error.message.split(':')[0] : 'BABEL_HARNESS_FAILURE' };
  } finally {
    if (deadline) clearTimeout(deadline);
    if (!settled && submission) {
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([submission.catch(() => undefined), new Promise<void>((resolve) => { grace = setTimeout(resolve, 5_000); })]);
      if (grace) clearTimeout(grace);
    }
    if (priorAutoApprove === undefined) delete process.env['BABEL_BENCHMARK_AUTO_APPROVE']; else process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = priorAutoApprove;
    if (priorToolProfile === undefined) delete process.env['BABEL_TOOL_PROFILE']; else process.env['BABEL_TOOL_PROFILE'] = priorToolProfile;
    if (priorMemoryWriteback === undefined) delete process.env['BABEL_MEMORY_WRITEBACK']; else process.env['BABEL_MEMORY_WRITEBACK'] = priorMemoryWriteback;
  }
  // The comparison runner exclusively owns independent evaluation. Never execute contestant-owned npm scripts here.
  const verifier = { result: 'UNKNOWN' as const, detail: 'NOT_EVALUATED: independent evaluator belongs to the comparison runner' };
  events.push({ event: 'evaluation_pending', result: verifier.result, detail: verifier.detail });
  events.push({ event: 'run_completed', status: result.status ?? 'UNKNOWN' });
  const normalizedPath = writeTrajectory(rawPath, [...observer.events, ...events]);
  const after = sampleTelemetry();
  const metrics = aggregateTelemetry([before, after], before.processCount === after.processCount ? 'PASS' : 'UNKNOWN');
  const end = new Date().toISOString();
  const receipt = receiptFor(input, runId, start, end, result, observer, events, rawPath, normalizedPath, metrics, verifier);
  const receiptPath = rawPath.replace(/\.jsonl$/, '.receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
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
      executionSuccess: settled && !runnerTimedOut && result.status === 'completed',
      termination: {
        kind: !settled ? 'PROCESS_HANG' : runnerTimedOut ? 'RUNNER_TIMEOUT' : result.status === 'completed' ? 'NORMAL' : observer.providerTimeout ? 'PROVIDER_TIMEOUT' : result.status === 'cancelled' ? 'UNKNOWN_TIMEOUT' : 'HARNESS_FAILURE',
        evidence: [!settled ? 'ChatEngine submission still active after cancel and 5000ms grace; evaluator skipped' : runnerTimedOut ? `Runner deadline ${input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS}ms triggered engine.cancel(); submission settled` : `ChatEngine status=${String(result.status)}; provider timeout observed=${observer.providerTimeout}`],
      },
      observedProvider: observer.observedProvider,
      observedModel: observer.observedModel,
      fallback: observer.observedProvider === 'opencode-go' && observer.observedModel === input.model ? false : 'UNKNOWN',
      ...observer.recovery.snapshot(),
    },
  };
}
