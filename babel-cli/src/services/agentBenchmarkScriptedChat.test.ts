import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isScriptedControlSuccess } from './agentBenchmarkScriptedChat.js';

test('scripted control predicate requires a completed ChatEngine terminal', () => {
  const base = {
    engineStatus: 'completed',
    engineOutcome: 'UNVERIFIED_PATCH',
    toolCallCount: 3,
    verifierOk: true,
    expectedChangesApplied: true,
    changedFileCount: 1,
    readOnly: false,
  };
  assert.equal(isScriptedControlSuccess(base), true);
  assert.equal(isScriptedControlSuccess({ ...base, engineOutcome: 'VERIFIED_COMPLETE' }), true);
  assert.equal(isScriptedControlSuccess({ ...base, engineStatus: 'blocked', engineOutcome: 'BLOCKED_POLICY' }), false);
  assert.equal(isScriptedControlSuccess({ ...base, engineStatus: 'failed', engineOutcome: 'AGENT_FAILURE' }), false);
  assert.equal(isScriptedControlSuccess({ ...base, engineStatus: 'cancelled', engineOutcome: 'CANCELLED' }), false);
  assert.equal(isScriptedControlSuccess({ ...base, engineStatus: 'budget_exhausted', engineOutcome: 'BUDGET_EXHAUSTED' }), false);
  assert.equal(isScriptedControlSuccess({ ...base, engineOutcome: null }), false);
  assert.equal(isScriptedControlSuccess({ ...base, engineOutcome: 'VERIFIED_COMPLETE', toolCallCount: 2 }), false);
  assert.equal(isScriptedControlSuccess({ ...base, verifierOk: false }), false);
  assert.equal(isScriptedControlSuccess({ ...base, expectedChangesApplied: false }), false);
  assert.equal(
    isScriptedControlSuccess({
      ...base,
      readOnly: true,
      changedFileCount: 0,
      expectedChangesApplied: false,
    }),
    true,
  );
  assert.equal(isScriptedControlSuccess({ ...base, readOnly: true, changedFileCount: 1 }), false);
});

test('mock chat benchmark exercises the real ChatEngine tool protocol without a provider', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'babel-scripted-benchmark-'));
  // node:test sets NODE_TEST_CONTEXT, which makes ChatEngine apply a stricter
  // headless gate than the production benchmark process. Exercise the real
  // benchmark path with that marker removed, then restore it.
  const testContext = process.env['NODE_TEST_CONTEXT'];
  delete process.env['NODE_TEST_CONTEXT'];
  try {
    // Load the benchmark and ChatEngine modules after removing the test marker;
    // they cache the headless gate at import time.
    const { loadAgentBenchmarkManifest, runAgentBenchmarkTask } = await import('./agentBenchmark.js');
    const manifest = loadAgentBenchmarkManifest();
    const task = manifest.tasks.find((entry) => entry.task_id === 'PAR-A01');
    assert.ok(task);
    const result = await runAgentBenchmarkTask(task, {
      provider: 'mock',
      evidenceDir,
    });
    assert.equal(result.execution_path, 'scripted_chat_engine');
    assert.equal(result.scripted_provider, true);
    assert.equal(result.model_performance_claim, false);
    assert.equal(result.score_class, 'scripted_protocol_control');
    assert.equal(result.status, 'success', result.notes.join('\n'));
    assert.equal(result.verifier, 'pass');
    assert.ok(result.changed_files.includes('src/math.js'));

    const notes = result.notes.join('\n');
    assert.match(notes, /status=completed outcome=UNVERIFIED_PATCH/);
    assert.doesNotMatch(notes, /control_error=/);
    const toolCalls = Number(notes.match(/scripted_tool_calls=(\d+)/)?.[1] ?? 0);
    assert.ok(toolCalls >= 3, `expected read/write/verify tool calls, got ${toolCalls}`);

    const evidence = JSON.parse(
      readFileSync(join(evidenceDir, 'PAR-A01-scripted.json'), 'utf8'),
    ) as {
      scripted_provider: boolean;
      model_performance_claim: boolean;
      tool_calls: unknown[];
      engine_status: string;
      engine_outcome: string;
    };
    assert.equal(evidence.scripted_provider, true);
    assert.equal(evidence.model_performance_claim, false);
    assert.equal(evidence.engine_status, 'completed');
    assert.equal(evidence.engine_outcome, 'UNVERIFIED_PATCH');
    assert.ok(Array.isArray(evidence.tool_calls) && evidence.tool_calls.length >= 3);
  } finally {
    if (testContext !== undefined) process.env['NODE_TEST_CONTEXT'] = testContext;
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('a scripted control that halts after writing the expected files fails closed', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'babel-scripted-halt-'));
  const testContext = process.env['NODE_TEST_CONTEXT'];
  delete process.env['NODE_TEST_CONTEXT'];
  try {
    const { loadAgentBenchmarkManifest } = await import('./agentBenchmark.js');
    const { runScriptedParityChatCell } = await import('./agentBenchmarkScriptedChat.js');
    const { readParityCorpusTask } = await import('./parityCorpus.js');
    const manifest = loadAgentBenchmarkManifest();
    const task = manifest.tasks.find((entry) => entry.task_id === 'PAR-A01');
    assert.ok(task);
    const corpus = readParityCorpusTask('small_bug_fix');
    const cell = await runScriptedParityChatCell({
      task,
      parityTaskId: 'small_bug_fix',
      surface: 'chat',
      evidenceDir,
      runId: `scripted-halt-${Date.now()}`,
      runnerFactory() {
        let turn = 0;
        return {
          async *executeWithToolsStream() {
            const current = turn++;
            if (current === 0) {
              yield { type: 'tool_use', id: 'read', name: 'read_file', input: { path: corpus.target_file } };
              yield { type: 'done', finishReason: 'tool_calls' };
              return;
            }
            if (current === 1) {
              yield {
                type: 'tool_use',
                id: 'write',
                name: 'write_file',
                input: { path: corpus.target_file, content: corpus.fixed_implementation },
              };
              yield { type: 'done', finishReason: 'tool_calls' };
              return;
            }
            // Deliberate halt/error after the writes land: the previous
            // predicate would still have certified this cell because the
            // files and host verifier agreed.
            throw new Error('scripted halt after writes');
          },
          async execute() {
            return { type: 'completion', answer: 'halted' };
          },
          async executeRaw() {
            return 'halted';
          },
          getLastInvocationMetadata() {
            return null;
          },
          buildNativeToolsWireBody(messages: unknown[], tools: unknown[]) {
            return JSON.stringify({ model: 'synthetic-scripted-halt', messages, tools });
          },
          getNativeRequestReservedCompletionTokens() {
            return 4096;
          },
        };
      },
    });
    assert.equal(cell.verifierOk, true, 'host verifier must observe the green repair');
    assert.equal(cell.expectedChangesApplied, true, 'expected files must have landed');
    assert.equal(cell.engineStatus, 'failed');
    assert.equal(cell.parityResult.status, 'failure');
    assert.equal(cell.parityResult.false_complete, false);
  } finally {
    if (testContext !== undefined) process.env['NODE_TEST_CONTEXT'] = testContext;
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});
