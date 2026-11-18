/**
 * Scripted, no-key ChatEngine control for the local parity benchmark.
 *
 * The same ChatEngine and tool protocol as a live cell executes the turn, but a
 * deterministic host-owned runner emits read/write/test tool calls for the
 * frozen parity fixture. It never creates a provider client, reads credentials
 * or makes a network request. Results are protocol controls, not model
 * performance evidence.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { AgentBenchmarkSurface, AgentBenchmarkTask } from './agentBenchmark.js';
import type { ParityToolResult } from './parityBenchmark.js';
import {
  readParityCorpusTask,
  resolveParityCorpusRepoKind,
  resolveParityCorpusRunMode,
  runParityCorpusVerifier,
  writeParityCorpusRepo,
  type ParityCorpusTaskFixture,
} from './parityCorpus.js';

export interface ScriptedParityChatCell {
  parityResult: ParityToolResult;
  engineStatus: string | null;
  engineOutcome: string | null;
  toolCallCount: number;
  expectedChangesApplied: boolean;
  verifierOk: boolean;
  answer: string;
}

function expectedWrites(task: ParityCorpusTaskFixture): Array<{ path: string; content: string }> {
  const writes = [
    { path: task.target_file, content: task.fixed_implementation },
  ];
  for (const [path, entry] of Object.entries(task.files ?? {})) {
    if (typeof entry.fixed === 'string') writes.push({ path, content: entry.fixed });
  }
  return writes.filter((write) => {
    const original =
      write.path === task.target_file
        ? task.broken_implementation
        : task.files?.[write.path]?.broken;
    return original !== write.content;
  });
}

function expectedReads(task: ParityCorpusTaskFixture): string[] {
  return [...new Set([task.target_file, ...Object.keys(task.files ?? {})])];
}

function buildScriptedRunner(task: ParityCorpusTaskFixture, verifierCommand: string) {
  const writes = expectedWrites(task);
  const reads = expectedReads(task);
  const readOnly = resolveParityCorpusRepoKind(task) === 'read_only_review';
  let turn = 0;
  return {
    async *executeWithToolsStream() {
      const current = turn++;
      if (current === 0) {
        for (const [index, path] of reads.entries()) {
          yield { type: 'tool_use' as const, id: `scripted-read-${index}`, name: 'read_file', input: { path } };
        }
        yield { type: 'done' as const, finishReason: 'tool_calls' };
        return;
      }
      if (current === 1 && !readOnly && writes.length > 0) {
        for (const [index, write] of writes.entries()) {
          yield {
            type: 'tool_use' as const,
            id: `scripted-write-${index}`,
            name: 'write_file',
            input: { path: write.path, content: write.content },
          };
        }
        yield { type: 'done' as const, finishReason: 'tool_calls' };
        return;
      }
      if (current === 2 && !readOnly) {
        yield {
          type: 'tool_use' as const,
          id: 'scripted-verify',
          name: 'test_run',
          input: { command: verifierCommand },
        };
        yield { type: 'done' as const, finishReason: 'tool_calls' };
        return;
      }
      yield {
        type: 'text_delta' as const,
        text: readOnly
          ? 'Compared the documented options and reported tradeoffs. No source files were edited.'
          : 'Applied the requested change and ran the project verifier. Completion status is decided by the harness, not this script.',
      };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    async execute() {
      return { type: 'completion' as const, answer: 'Scripted parity control.' };
    },
    async executeRaw() {
      return 'Scripted parity control.';
    },
    getLastInvocationMetadata() {
      return null;
    },
    buildNativeToolsWireBody(messages: unknown[], tools: unknown[]) {
      return JSON.stringify({ model: 'synthetic-scripted-control', messages, tools, max_tokens: 4096 });
    },
    getNativeRequestReservedCompletionTokens() {
      return 4096;
    },
  };
}

function readIfPresent(root: string, relative: string): string | null {
  const file = join(root, relative);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** Run one parity cell through ChatEngine with a deterministic host runner. */
export async function runScriptedParityChatCell(input: {
  task: AgentBenchmarkTask;
  parityTaskId: string;
  surface: AgentBenchmarkSurface;
  evidenceDir: string;
  runId: string;
}): Promise<ScriptedParityChatCell> {
  const corpusTask = readParityCorpusTask(input.parityTaskId);
  const runMode = resolveParityCorpusRunMode(corpusTask);
  const projectRoot = resolve(input.evidenceDir, 'workspaces', `${input.task.task_id}-scripted`);
  rmSync(projectRoot, { recursive: true, force: true });
  mkdirSync(projectRoot, { recursive: true });
  writeParityCorpusRepo(projectRoot, corpusTask);

  const started = performance.now();
  const toolCalls: Array<{ tool: string; target: string; error?: string; exit_code?: number }> = [];
  let answer = '';
  let engineStatus: string | null = null;
  let engineOutcome: string | null = null;
  let verifierReceipt: { command: string; exit_code: number; summary: string } | null = null;
  let runDir: string | null = null;

  // This control executes real local tools in a disposable fixture. Scope the
  // host-native profile and benchmark auto-approval to this cell only; no
  // provider credential or network path is consulted.
  const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
  const previousAutoApprove = process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
  process.env['BABEL_EXECUTION_PROFILE'] = 'host_native';
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  try {
    const { ChatEngine } = await import('../agent/chatEngine.js');
    const { calibrationPolicy } = await import('../eval/native-chat-calibration.js');
    const runner = buildScriptedRunner(corpusTask, corpusTask.verifier_command);
    const engine = new ChatEngine({
      task: corpusTask.task,
      projectRoot,
      runId: input.runId,
      providerRunner: runner as never,
      providerPolicy: calibrationPolicy,
      model: 'synthetic-scripted-control',
      maxTurns: 8,
    });
    const terminal = await engine.submitMessage(corpusTask.task, {
      onAnswerChunk(chunk: string) {
        answer += chunk;
      },
      onToolStart(tool: string, target: string) {
        toolCalls.push({ tool, target });
        return toolCalls.length - 1;
      },
      onToolComplete(_id: number, _detail: unknown, error?: string, exitCode?: number) {
        const entry = toolCalls[toolCalls.length - 1];
        if (!entry) return;
        if (error !== undefined) entry.error = error;
        if (exitCode !== undefined) entry.exit_code = exitCode;
      },
    });
    engineStatus = terminal.status ?? null;
    engineOutcome = terminal.outcome ?? null;
    answer = terminal.answer || answer;
    verifierReceipt = terminal.verifierReceipt ?? null;
    runDir = terminal.runDir ?? null;
    for (const call of terminal.toolCalls ?? []) {
      if (!toolCalls.some((entry) => entry.tool === call.tool && entry.target === call.target)) {
        toolCalls.push({ tool: call.tool, target: call.target, ...(call.error ? { error: call.error } : {}), ...(call.exit_code !== undefined ? { exit_code: call.exit_code } : {}) });
      }
    }
  } catch (error) {
    answer = `scripted_control_failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
    else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
    if (previousAutoApprove === undefined) delete process.env['BABEL_BENCHMARK_AUTO_APPROVE'];
    else process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = previousAutoApprove;
  }

  const verifierOk = runParityCorpusVerifier(projectRoot, corpusTask.verifier_command) === 0;
  const expectedChangesApplied = expectedWrites(corpusTask).every(
    (write) => readIfPresent(projectRoot, write.path) === (write.content.endsWith('\n') ? write.content : `${write.content}\n`),
  );
  const changedFiles = expectedReads(corpusTask).filter((relative) => {
    const actual = readIfPresent(projectRoot, relative);
    const original =
      relative === corpusTask.target_file
        ? corpusTask.broken_implementation
        : corpusTask.files?.[relative]?.broken ?? null;
    return actual !== null && original !== null && actual !== (original.endsWith('\n') ? original : `${original}\n`);
  });
  const hasToolEvidence = toolCalls.length > 0;
  const noMutation = changedFiles.length === 0;
  const success =
    hasToolEvidence &&
    verifierOk &&
    (runMode === 'ask' ? noMutation : expectedChangesApplied && changedFiles.length > 0);
  const falseComplete =
    (engineOutcome === 'VERIFIED_COMPLETE') &&
    (!verifierOk || (runMode === 'ask' ? !noMutation : !expectedChangesApplied));

  const evidencePath = join(input.evidenceDir, `${input.task.task_id}-scripted.json`);
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        task_id: input.task.task_id,
        parity_task_id: input.parityTaskId,
        execution_path: 'scripted_chat_engine',
        scripted_provider: true,
        model_performance_claim: false,
        engine_status: engineStatus,
        engine_outcome: engineOutcome,
        verifier_ok: verifierOk,
        expected_changes_applied: expectedChangesApplied,
        changed_files: changedFiles,
        tool_calls: toolCalls,
        answer,
        project_root: projectRoot,
        latency_ms: Math.round(performance.now() - started),
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    parityResult: {
      task_id: input.parityTaskId,
      tool: 'babel',
      status: success ? 'success' : 'failure',
      verifier: verifierOk ? 'pass' : 'fail',
      false_complete: falseComplete,
      latency_ms: Math.round(performance.now() - started),
      cost_usd: 0,
      token_count: null,
      changed_files: changedFiles,
      user_interventions: 0,
      evidence_path: evidencePath,
      notes: [
        'agent-benchmark surface=chat provider=mock execution=scripted_chat_engine',
        'scripted provider control: not model-performance evidence',
        `status=${String(engineStatus)} outcome=${String(engineOutcome)} verifier=${verifierOk ? 'pass' : 'fail'} tool_calls=${toolCalls.length} expected_changes=${expectedChangesApplied}`,
      ],
    },
    engineStatus,
    engineOutcome,
    toolCallCount: toolCalls.length,
    expectedChangesApplied,
    verifierOk,
    answer,
  };
}
