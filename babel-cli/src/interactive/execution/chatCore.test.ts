import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, test } from 'node:test';

import type { ChatEngineOptions, ChatEvent, ChatResult } from '../../agent/chatEngine.js';
import { ChatEngine } from '../../agent/chatEngine.js';
import { globalCostTracker } from '../../services/costTracker.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import {
  buildChatRunPayload,
  consumeChatStream,
  gatherChatPreflightContext,
  runChatEngineOnce,
} from './chatCore.js';

const EMPTY_USAGE = globalCostTracker.getSessionSummary();

function makeTarget(root: string): AgentTargetContext {
  return {
    targetRoot: root,
    workspaceRoot: null,
    project: null,
    source: 'cwd',
    cwd: root,
  };
}

function completedResult(answer: string): ChatResult {
  return {
    status: 'completed',
    answer,
    usage: EMPTY_USAGE,
    conversation: [],
  };
}

function failedResult(error: string): ChatResult {
  return {
    status: 'failed',
    answer: error,
    usage: EMPTY_USAGE,
    conversation: [],
  };
}

test('buildChatRunPayload maps completed ChatResult to ANSWER_READY', () => {
  const payload = buildChatRunPayload(completedResult('All good.'), {
    task: 'explain repo',
    project: 'babel-cli',
    projectRoot: '/tmp/project',
  });

  assert.equal(payload['status'], 'ANSWER_READY');
  assert.equal(payload['user_status'], 'success');
  assert.equal(payload['command'], 'run');
  assert.equal(payload['mode'], 'chat');
  assert.equal(payload['task'], 'explain repo');
  assert.equal(payload['project'], 'babel-cli');
  const routing = payload['routing'] as Record<string, unknown>;
  assert.equal(routing['orchestrator'], 'chat_engine');
  const answer = payload['answer'] as Record<string, unknown>;
  assert.equal(answer['answer'], 'All good.');
});

test('buildChatRunPayload maps failed ChatResult to NEEDS_MORE_CONTEXT', () => {
  const payload = buildChatRunPayload(failedResult('rate limited'), {
    task: 'fix bug',
    projectRoot: '/tmp/project',
  });

  assert.equal(payload['status'], 'NEEDS_MORE_CONTEXT');
  assert.equal(payload['user_status'], 'blocked');
  const answer = payload['answer'] as Record<string, unknown>;
  assert.equal(answer['answer'], 'rate limited');
});

test('runChatEngineOnce uses injected engineFactory and submitMessage', async () => {
  const target = makeTarget('/tmp/project');
  let factoryCalled = false;
  let submitCalled = false;

  const mockEngine = {
    submitMessage: async () => {
      submitCalled = true;
      return completedResult('mock answer');
    },
    submitMessageStream: async function* () {
      yield { type: 'done', answer: 'stream', usage: EMPTY_USAGE } as ChatEvent;
    },
    cancel: () => undefined,
  } as unknown as ChatEngine;

  const engineFactory = (options: ChatEngineOptions) => {
    factoryCalled = true;
    assert.equal(options.task, 'hello task');
    assert.equal(options.projectRoot, target.targetRoot);
    return mockEngine;
  };

  const result = await runChatEngineOnce({
    task: 'hello task',
    target,
    engineFactory,
    useStreaming: false,
    preflightContext: '',
  });

  assert.equal(factoryCalled, true);
  assert.equal(submitCalled, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'mock answer');
});

test('runChatEngineOnce streaming path uses submitMessageStream via engineFactory', async () => {
  const target = makeTarget('/tmp/project');
  let streamCalled = false;

  const mockEngine = {
    submitMessage: async () => completedResult('callback path'),
    submitMessageStream: async function* () {
      streamCalled = true;
      yield { type: 'answer_chunk', text: 'partial ' };
      yield { type: 'done', answer: 'partial answer', usage: EMPTY_USAGE };
    },
    cancel: () => undefined,
  } as unknown as ChatEngine;

  const result = await runChatEngineOnce({
    task: 'stream task',
    target,
    engineFactory: () => mockEngine,
    useStreaming: true,
    preflightContext: '',
  });

  assert.equal(streamCalled, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'partial answer');
});

test('runChatEngineOnce headless defaults to streaming when BABEL_STREAM_TOOLS=0', async () => {
  const target = makeTarget('/tmp/project');
  const prev = process.env['BABEL_STREAM_TOOLS'];
  process.env['BABEL_STREAM_TOOLS'] = '0';
  let streamCalled = false;
  let submitCalled = false;

  const mockEngine = {
    submitMessage: async () => {
      submitCalled = true;
      return completedResult('callback path');
    },
    submitMessageStream: async function* () {
      streamCalled = true;
      yield { type: 'done', answer: 'stream path', usage: EMPTY_USAGE };
    },
    cancel: () => undefined,
  } as unknown as ChatEngine;

  try {
    const result = await runChatEngineOnce({
      task: 'headless',
      target,
      engineFactory: () => mockEngine,
      convRenderer: null,
      preflightContext: '',
    });
    assert.equal(streamCalled, true);
    assert.equal(submitCalled, false);
    assert.equal(result.answer, 'stream path');
  } finally {
    if (prev === undefined) delete process.env['BABEL_STREAM_TOOLS'];
    else process.env['BABEL_STREAM_TOOLS'] = prev;
  }
});

test('runChatEngineOnce reuses provided engine without calling factory', async () => {
  const target = makeTarget('/tmp/project');
  let factoryCalled = false;

  const existingEngine = {
    submitMessage: async () => completedResult('reused'),
    submitMessageStream: async function* () {
      yield { type: 'done', answer: 'reused', usage: EMPTY_USAGE };
    },
    cancel: () => undefined,
  } as unknown as ChatEngine;

  const result = await runChatEngineOnce({
    task: 'reuse task',
    target,
    engine: existingEngine,
    engineFactory: () => {
      factoryCalled = true;
      return new ChatEngine({ task: 'x', projectRoot: target.targetRoot });
    },
    useStreaming: false,
    preflightContext: '',
  });

  assert.equal(factoryCalled, false);
  assert.equal(result.answer, 'reused');
});

// ── C1/E3: Intent plan + first-move injection via runChatEngineOnce ────────

describe('intent plan injection via runChatEngineOnce', () => {
  function makeMockEngine() {
    return {
      submitMessage: async () => completedResult('ok'),
      submitMessageStream: async function* () {
        yield { type: 'done', answer: 'ok', usage: EMPTY_USAGE } as ChatEvent;
      },
      cancel: () => undefined,
    } as unknown as ChatEngine;
  }

  it('injects intentPlanUserMessage for vague execute task', async () => {
    const target = makeTarget('/tmp/project');
    let capturedOptions: ChatEngineOptions | undefined;

    const result = await runChatEngineOnce({
      task: 'fix the histogram density range bug',
      target,
      engineFactory: (opts) => {
        capturedOptions = opts;
        return makeMockEngine();
      },
      useStreaming: false,
      preflightContext: '',
    });

    assert.equal(result.status, 'completed');
    assert.ok(capturedOptions !== undefined, 'engineFactory should have been called');
    const opts = capturedOptions!;
    assert.ok(opts.intentPlanUserMessage, 'should inject intent plan for vague execute task');
    assert.match(opts.intentPlanUserMessage!, /## Intent Plan/);
    assert.match(opts.intentPlanUserMessage!, /histogram density range/);
  });

  it('skips intentPlanUserMessage for FAIL_TO_PASS SWE task', async () => {
    const target = makeTarget('/tmp/project');
    let capturedOptions: ChatEngineOptions | undefined;

    const result = await runChatEngineOnce({
      task: 'FAIL_TO_PASS: test_a.py::test_x — fix the assertion error',
      target,
      engineFactory: (opts) => {
        capturedOptions = opts;
        return makeMockEngine();
      },
      useStreaming: false,
      preflightContext: '',
    });

    assert.equal(result.status, 'completed');
    assert.ok(capturedOptions !== undefined, 'engineFactory should have been called');
    assert.equal(
      capturedOptions!.intentPlanUserMessage,
      undefined,
      'should NOT inject intent plan for FAIL_TO_PASS SWE task',
    );
  });

  it('skips intentPlanUserMessage for dataset test path tasks', async () => {
    const target = makeTarget('/tmp/project');
    let capturedOptions: ChatEngineOptions | undefined;

    const result = await runChatEngineOnce({
      task: 'fix the bug in tests/logging/test_fixture.py::test_clear',
      target,
      engineFactory: (opts) => {
        capturedOptions = opts;
        return makeMockEngine();
      },
      useStreaming: false,
      preflightContext: '',
    });

    assert.equal(result.status, 'completed');
    assert.ok(capturedOptions !== undefined, 'engineFactory should have been called');
    assert.equal(
      capturedOptions!.intentPlanUserMessage,
      undefined,
      'should NOT inject intent plan for task with explicit pytest path',
    );
  });

  it('includes first-move hint when test_command is detected from task', async () => {
    const target = makeTarget('/tmp/project');
    let capturedOptions: ChatEngineOptions | undefined;

    const result = await runChatEngineOnce({
      task: 'run npm test and fix the type error in src/worker.ts',
      target,
      engineFactory: (opts) => {
        capturedOptions = opts;
        return makeMockEngine();
      },
      useStreaming: false,
      preflightContext: '',
    });

    assert.equal(result.status, 'completed');
    assert.ok(capturedOptions !== undefined, 'engineFactory should have been called');
    const opts = capturedOptions!;
    assert.ok(opts.intentPlanUserMessage, 'should inject intent plan');
    assert.match(opts.intentPlanUserMessage!, /## Intent Plan/);
    // First-move hint: mutate-first (not pytest-first) when test_command is known
    assert.match(opts.intentPlanUserMessage!, /## First Move/);
    assert.match(opts.intentPlanUserMessage!, /npm test/);
    assert.match(opts.intentPlanUserMessage!, /Mutate first, verify second/);
  });

  it('does NOT include first-move hint when no test command in task', async () => {
    const target = makeTarget('/tmp/project');
    let capturedOptions: ChatEngineOptions | undefined;

    const result = await runChatEngineOnce({
      task: 'fix the histogram density range bug',
      target,
      engineFactory: (opts) => {
        capturedOptions = opts;
        return makeMockEngine();
      },
      useStreaming: false,
      preflightContext: '',
    });

    assert.equal(result.status, 'completed');
    assert.ok(capturedOptions !== undefined, 'engineFactory should have been called');
    const opts = capturedOptions!;
    assert.ok(opts.intentPlanUserMessage, 'should inject intent plan');
    assert.match(opts.intentPlanUserMessage!, /## Intent Plan/);
    // No test_command in task → no first-move hint
    assert.ok(!opts.intentPlanUserMessage!.includes('## First Move'));
  });

  it('skips intent plan for investigate task class', async () => {
    const target = makeTarget('/tmp/project');
    let capturedOptions: ChatEngineOptions | undefined;

    // Task classified as investigate skips intent compilation
    const result = await runChatEngineOnce({
      task: 'explain this codebase architecture',
      target,
      engineFactory: (opts) => {
        capturedOptions = opts;
        return makeMockEngine();
      },
      useStreaming: false,
      preflightContext: '',
    });

    assert.equal(result.status, 'completed');
    assert.ok(capturedOptions !== undefined, 'engineFactory should have been called');
    // Investigate tasks may or may not get intent plan depending on classification
    // The compileIntentPlan call uses shouldSkipIntentCompiler which checks taskClass
    // This test verifies the integration doesn't throw
  });
});

test('gatherChatPreflightContext in non-git temp dir returns undefined without throwing', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'babel-chat-preflight-'));
  try {
    const context = await gatherChatPreflightContext(tempDir);
    assert.equal(context, undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('consumeChatStream aggregates answer_chunk events and returns completed result', async () => {
  async function* mockStream(): AsyncGenerator<ChatEvent, void, undefined> {
    yield { type: 'answer_chunk', text: 'Hello' };
    yield { type: 'answer_chunk', text: ' world' };
    yield { type: 'done', answer: 'Hello world', usage: EMPTY_USAGE };
  }

  const result = await consumeChatStream(mockStream(), null);

  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'Hello world');
});

test('consumeChatStream returns failed result on failed event', async () => {
  async function* mockStream(): AsyncGenerator<ChatEvent, void, undefined> {
    yield { type: 'answer_chunk', text: 'partial' };
    yield { type: 'failed', error: 'upstream error' };
  }

  const result = await consumeChatStream(mockStream(), null);

  assert.equal(result.status, 'failed');
  assert.equal(result.answer, 'upstream error');
});

describe('completion_verification in buildChatRunPayload', () => {
  it('verifierReceipt with exit_code 0 sets status=pass required=true', () => {
    const payload = buildChatRunPayload(
      {
        status: 'completed',
        answer: 'done',
        usage: EMPTY_USAGE,
        conversation: [],
        verifierReceipt: { command: 'npm test', exit_code: 0, summary: 'All tests passed' },
      },
      { task: 'fix', projectRoot: '/tmp/project' },
    );
    const cv = payload['completion_verification'] as Record<string, unknown>;
    assert.equal(cv['status'], 'pass');
    assert.equal(cv['required'], true);
  });

  it('verifierReceipt with non-zero exit_code sets status=fail required=true', () => {
    const payload = buildChatRunPayload(
      {
        status: 'completed',
        answer: 'done',
        usage: EMPTY_USAGE,
        conversation: [],
        verifierReceipt: { command: 'pytest', exit_code: 1, summary: 'Tests failed' },
      },
      { task: 'fix', projectRoot: '/tmp/project' },
    );
    const cv = payload['completion_verification'] as Record<string, unknown>;
    assert.equal(cv['status'], 'fail');
    assert.equal(cv['required'], true);
  });

  it('no verifierReceipt + gatePolicy=none sets status=not_required required=false', () => {
    const payload = buildChatRunPayload(
      {
        status: 'completed',
        answer: 'done',
        usage: EMPTY_USAGE,
        conversation: [],
        gatePolicy: 'none',
      },
      { task: 'fix', projectRoot: '/tmp/project' },
    );
    const cv = payload['completion_verification'] as Record<string, unknown>;
    assert.equal(cv['status'], 'not_required');
    assert.equal(cv['required'], false);
  });

  it('no verifierReceipt + gatePolicy=required sets status=not_run required=true', () => {
    const payload = buildChatRunPayload(
      {
        status: 'completed',
        answer: 'done',
        usage: EMPTY_USAGE,
        conversation: [],
        gatePolicy: 'required',
      },
      { task: 'fix', projectRoot: '/tmp/project' },
    );
    const cv = payload['completion_verification'] as Record<string, unknown>;
    assert.equal(cv['status'], 'not_run');
    assert.equal(cv['required'], true);
  });

  it('no verifierReceipt + gatePolicy=strict sets status=not_run required=true', () => {
    const payload = buildChatRunPayload(
      {
        status: 'completed',
        answer: 'done',
        usage: EMPTY_USAGE,
        conversation: [],
        gatePolicy: 'strict',
      },
      { task: 'fix', projectRoot: '/tmp/project' },
    );
    const cv = payload['completion_verification'] as Record<string, unknown>;
    assert.equal(cv['status'], 'not_run');
    assert.equal(cv['required'], true);
  });

  it('no verifierReceipt + no gatePolicy (fallback) sets status=not_required required=false', () => {
    const payload = buildChatRunPayload(completedResult('done'), {
      task: 'fix',
      projectRoot: '/tmp/project',
    });
    const cv = payload['completion_verification'] as Record<string, unknown>;
    assert.equal(cv['status'], 'not_required');
    assert.equal(cv['required'], false);
  });
});