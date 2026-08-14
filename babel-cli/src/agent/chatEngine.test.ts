import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { ChatEngine } from './chatEngine.js';
import { BABEL_RUNS_DIR } from '../cli/constants.js';
import { createSessionEventLog, flushSessionEventLog, recordUserSubmitted } from './sessionEvents.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Set up a mock chat-session directory in the real BABEL_RUNS_DIR/chat-sessions
 * with a transcript.jsonl file. Returns the engineRunId.
 * Cleaned up in after().
 */
function setupMockSession(tempRoot: string): string {
  const sessionId = `test-session-${randomBytes(4).toString('hex')}`;
  const sessionDir = join(tempRoot, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  new ChatEngine({ task: 'Resume test', projectRoot: '/tmp', runId: sessionId });
  const sessionLog = createSessionEventLog(sessionId);
  recordUserSubmitted(sessionLog, { turn_id: 'restore-turn', task: 'Resume test' });
  flushSessionEventLog(sessionDir, sessionLog);

  const transcript = [
    { role: 'system', content: 'You are a helpful coding assistant.' },
    { role: 'user', content: 'What is in this repository?' },
    {
      role: 'assistant',
      content: 'Let me explore the repository structure.',
      name: 'tool_calls',
    },
    { role: 'tool', content: 'src/\npackage.json\nREADME.md' },
    {
      role: 'assistant',
      content:
        'This repository contains source code in src/, a package.json, and a README.',
    },
    { role: 'user', content: 'Show me the main entry point.' },
    { role: 'assistant', content: 'The main entry point is src/index.ts.' },
  ];

  const jsonl = transcript.map((m) => JSON.stringify(m)).join('\n') + '\n';
  writeFileSync(join(sessionDir, 'transcript.jsonl'), jsonl, 'utf-8');

  return sessionId;
}

/** Collect all session IDs we create so we can tear them down. */
const createdSessions: string[] = [];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ChatEngine.restore()', () => {
  // The real BABEL_RUNS_DIR/chat-sessions location. All test artifacts go here
  // and are removed in after().
  const testRoot = join(BABEL_RUNS_DIR, 'chat-sessions');

  after(() => {
    for (const id of createdSessions) {
      const dir = join(testRoot, id);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    createdSessions.length = 0;
  });

  it('loads a transcript into the engine conversation', async () => {
    const sessionId = setupMockSession(testRoot);
    createdSessions.push(sessionId);

    const engine = await ChatEngine.restore(sessionId, {
      task: 'Resume test',
      projectRoot: '/tmp',
    });

    assert.ok(engine, 'Engine should be created');
    assert.equal(
      engine.getEngineRunId(),
      sessionId,
      'Engine run ID should match the session ID',
    );

    const conversation = engine.getConversation();
    assert.equal(conversation.length, 7, 'Conversation should have 7 messages');

    // Verify first message is the system prompt
    assert.equal(conversation[0]!.role, 'system');
    assert.equal(conversation[0]!.content, 'You are a helpful coding assistant.');

    // Verify a user message
    const userMsg = conversation.find((m) => m.role === 'user');
    assert.ok(userMsg, 'Should have user messages');
    assert.equal(userMsg!.content, 'What is in this repository?');

    // Verify the last message
    const lastMsg = conversation[conversation.length - 1]!;
    assert.equal(lastMsg.role, 'assistant');
    assert.equal(lastMsg.content, 'The main entry point is src/index.ts.');
  });

  it('allows continuing the conversation after restore', async () => {
    const sessionId = setupMockSession(testRoot);
    createdSessions.push(sessionId);

    const engine = await ChatEngine.restore(sessionId, {
      task: 'Resume test',
      projectRoot: '/tmp',
    });

    // The conversation should be pre-populated; no system prompt re-injection needed
    const conversation = engine.getConversation();
    const systemCount = conversation.filter((m) => m.role === 'system').length;
    assert.equal(systemCount, 1, 'Should have exactly one system message');

    // Before submitting, check that a system message exists at index 0
    assert.equal(conversation[0]!.role, 'system');

    // Verify getConversation returns a copy, not the internal array reference
    const convCopy = engine.getConversation();
    assert.notStrictEqual(convCopy, conversation);
    assert.equal(convCopy.length, conversation.length);
  });

  it('throws when engineRunId does not exist', async () => {
    const fakeId = 'non-existent-session-test-1234';

    await assert.rejects(
      async () => {
        await ChatEngine.restore(fakeId, {
          task: 'Should fail',
          projectRoot: '/tmp',
        });
      },
      { code: 'ENOENT' },
      'Should throw ENOENT for missing session',
    );
  });

  it('throws when transcript file is corrupt JSON', async () => {
    const badId = `corrupt-session-${randomBytes(4).toString('hex')}`;
    createdSessions.push(badId);
    const badDir = join(testRoot, badId);
    mkdirSync(badDir, { recursive: true });
    writeFileSync(
      join(badDir, 'transcript.jsonl'),
      'not-valid-json\n{also: bad,\n',
      'utf-8',
    );

    await assert.rejects(
      async () => {
        await ChatEngine.restore(badId, {
          task: 'Should fail',
          projectRoot: '/tmp',
        });
      },
      SyntaxError,
      'Should throw SyntaxError for corrupt JSON',
    );
  });
});

// ─── P-4.2: BABEL.md Project Memory ─────────────────────────────────────────

describe('BABEL.md project memory', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(BABEL_RUNS_DIR, 'babel-md-test-' + randomBytes(4).toString('hex'));
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('injects BABEL.md content into system prompt when present', () => {
    const content = '# Test Project\nnpm test\ndist/ is build output';
    writeFileSync(join(tmpDir, 'BABEL.md'), content, 'utf8');

    const engine = new ChatEngine({
      task: 'what command runs tests?',
      projectRoot: tmpDir,
    });

    const sysPrompt = (engine as any).getOrBuildSystemPrompt(true);
    assert.ok(
      sysPrompt.includes('## Project Memory (BABEL.md)'),
      'system prompt should include BABEL.md header',
    );
    assert.ok(
      sysPrompt.includes('npm test'),
      'system prompt should include BABEL.md content',
    );
  });

  it('does not inject when BABEL.md is absent', () => {
    // Ensure no BABEL.md exists
    const mdPath = join(tmpDir, 'BABEL.md');
    if (existsSync(mdPath)) rmSync(mdPath, { force: true });

    const engine = new ChatEngine({
      task: 'what command runs tests?',
      projectRoot: tmpDir,
    });

    const sysPrompt = (engine as any).getOrBuildSystemPrompt(true);
    assert.ok(
      !sysPrompt.includes('## Project Memory (BABEL.md)'),
      'system prompt should NOT include BABEL.md header when file absent',
    );
  });

  it('does not inject when BABEL.md is empty', () => {
    writeFileSync(join(tmpDir, 'BABEL.md'), '', 'utf8');

    const engine = new ChatEngine({
      task: 'what command runs tests?',
      projectRoot: tmpDir,
    });

    const sysPrompt = (engine as any).getOrBuildSystemPrompt(true);
    assert.ok(
      !sysPrompt.includes('## Project Memory (BABEL.md)'),
      'system prompt should NOT include BABEL.md header when file is empty',
    );
  });
});

describe('ChatEngine active verifier ledger & invalidation', () => {
  it('invalidateVerifierLedger marks receipts stale without modifying writeCount', async () => {
    const { invalidateVerifierLedger } = await import('./chatEngineSupport.js');
    const engine: any = {
      writeCount: 0,
      lastVerifierReceipt: { command: 'npm test', stale: false },
      executedVerifierLedger: [{ command: 'npm test', stale: false }],
    };

    invalidateVerifierLedger(engine, 'non-verifier shell command executed');

    assert.equal(engine.writeCount, 0, 'writeCount MUST NOT be incremented by invalidateVerifierLedger');
    assert.equal(engine.lastVerifierReceipt.stale, true);
    assert.match(engine.lastVerifierReceipt.staleReason, /non-verifier shell/);
    assert.equal(engine.executedVerifierLedger[0].stale, true);
  });

  it('session restore clears active verifier ledger, last receipt, and cache', async () => {
    const testRoot = join(BABEL_RUNS_DIR, 'chat-sessions');
    const sessionId = setupMockSession(testRoot);
    createdSessions.push(sessionId);

    const engine = await ChatEngine.restore(sessionId, {
      task: 'Restore evidence test',
      projectRoot: '/tmp',
    });

    assert.deepEqual((engine as any).executedVerifierLedger, [], 'executedVerifierLedger MUST be empty on restore');
    assert.equal((engine as any).lastVerifierReceipt, null, 'lastVerifierReceipt MUST be null on restore');
    assert.equal((engine as any).verifierReceiptCache.size, 0, 'verifierReceiptCache MUST be empty on restore');
  });
});

describe('ChatEngine recursive shell degradation & suppression loop', () => {
  it('suppresses recursive shell commands and emits list_dir advisory after repeat failures', async () => {
    const engine = new ChatEngine({
      task: 'Find all files in repo',
      projectRoot: '/tmp',
    });

    const action = {
      type: 'run_command' as const,
      command: 'Get-ChildItem -Path /non_existent_path_xyz_123 -Recurse',
    };

    const ctx = { agentId: 'test', runId: 'test', runDir: '/tmp', babelRoot: '/tmp' };

    // Tool call 1: fails -> records failure -> SUSPECT
    const res1 = await (engine as any).executeOneAction(action, ctx, {}, { index: 0, subAgentCounter: 0 });
    assert.ok(res1.observation.includes('exit_code: 1') || res1.observation.includes('Cannot find path') || res1.observation.includes('non_existent'));

    // Tool call 2: fails -> records failure -> DEGRADED
    const res2 = await (engine as any).executeOneAction(action, ctx, {}, { index: 1, subAgentCounter: 0 });
    assert.equal((engine as any).progressController.getCapabilityState('shell.recursive_enumeration'), 'DEGRADED');

    // Tool call 3: equivalent recursive command -> pre-execution interception blocks executor!
    const res3 = await (engine as any).executeOneAction(action, ctx, {}, { index: 2, subAgentCounter: 0 });
    assert.ok(res3.observation.includes('[BABEL ADVISORY] Recursive shell command suppressed'));
    assert.ok(res3.observation.includes('list_dir'));
  });
});

describe('ChatEngine read-only inspection hard cap answer synthesis', () => {
  it('synthesizes informational answer and completes normally with blockedReport: null on hard cap', async () => {
    const engine = new ChatEngine({
      task: 'how many services exist in this project',
      projectRoot: '/tmp',
      maxTurns: 20,
    });

    let toolCount = 0;
    const mockRunner = {
      executeWithToolsStream: async function* () {
        toolCount += 1;
        yield {
          type: 'tool_use' as const,
          id: `tool-${toolCount}`,
          name: 'read_file',
          input: { path: `src/file_${toolCount}.ts` },
        };
        yield { type: 'done' as const, finishReason: 'tool_calls' as const };
      },
      execute: async () => ({
        type: 'completion',
        answer: 'Synthesized summary: The repository contains 10 modules and 4 services.',
      }),
      executeRaw: async () => 'Synthesized summary: The repository contains 10 modules and 4 services.',
      getLastInvocationMetadata: () => null,
    };

    (engine as any).deliberationRunner = mockRunner;
    (engine as any).synthesisRunner = mockRunner;
    (engine as any).shouldUseNativeTools = () => true;

    // Stub executeOneAction to return unique file contents per path and update inspection counters
    (engine as any).executeOneAction = async (action: any) => {
      (engine as any).noteToolForReadThrash(action.type ?? 'read_file');
      return {
        action: { ...action, path: action.path ?? `src/file_${toolCount}.ts` },
        observation: `Content of file_${toolCount}: exports data_${toolCount}`,
      };
    };

    let doneEvent: any = null;
    for await (const event of engine.submitMessageStream('how many services exist in this project', 'explain')) {
      if (event.type === 'done') {
        doneEvent = event;
      }
    }

    assert.ok(doneEvent, 'Stream must yield a done event');
    assert.equal(doneEvent.blockedReport ?? null, null, 'Must NOT be BLOCKED for reaching inspection budget');
    assert.ok(doneEvent.answer.includes('Synthesized summary: The repository contains 10 modules and 4 services.'));
    assert.ok(!doneEvent.answer.includes('BLOCKED:'));
    assert.ok(!doneEvent.answer.includes('str_replace'));
    assert.ok(!doneEvent.answer.includes('write_file'));
  });

  it('truthfully reports synthesis failure when synthesis runner errors without misreporting inspection budget', async () => {
    const engine = new ChatEngine({
      task: 'how many services exist in this project',
      projectRoot: '/tmp',
      maxTurns: 20,
    });

    let toolCount = 0;
    const mockDelibRunner = {
      executeWithToolsStream: async function* () {
        toolCount += 1;
        yield {
          type: 'tool_use' as const,
          id: `tool-${toolCount}`,
          name: 'read_file',
          input: { path: `src/file_${toolCount}.ts` },
        };
        yield { type: 'done' as const, finishReason: 'tool_calls' as const };
      },
      execute: async () => ({
        type: 'completion',
        answer: 'Exploring...',
      }),
      executeRaw: async () => 'Exploring...',
      getLastInvocationMetadata: () => null,
    };

    const mockSynthRunner = {
      execute: async () => {
        throw new Error('LLM Provider timeout 504');
      },
      executeRaw: async () => {
        throw new Error('LLM Provider timeout 504');
      },
      getLastInvocationMetadata: () => null,
    };

    (engine as any).deliberationRunner = mockDelibRunner;
    (engine as any).synthesisRunner = mockSynthRunner;
    (engine as any).shouldUseNativeTools = () => true;

    (engine as any).executeOneAction = async (action: any) => {
      (engine as any).noteToolForReadThrash(action.type ?? 'read_file');
      return {
        action: { ...action, path: action.path ?? `src/file_${toolCount}.ts` },
        observation: `Content of file_${toolCount}: exports data_${toolCount}`,
      };
    };

    const events: any[] = [];
    for await (const event of engine.submitMessageStream('how many services exist in this project', 'explain')) {
      events.push(event);
    }
    const doneEvents = events.filter((e) => e.type === 'done');
    const doneEvent = doneEvents[doneEvents.length - 1];

    assert.ok(doneEvent, `Stream must yield a done event; got all events: ${JSON.stringify(events)}`);
    assert.ok(doneEvent.blockedReport, `Must have blockedReport; got doneEvent: ${JSON.stringify(doneEvent)}`);
    assert.equal(doneEvent.blockedReport.reason, 'Answer synthesis unavailable');
    assert.notEqual(doneEvent.blockedReport.reason, 'Too many tools without a file mutation (investigate hard cap)');
    assert.notEqual(doneEvent.blockedReport.reason, 'Read-only inspection budget reached');
    assert.ok(doneEvent.blockedReport.missing.includes('LLM provider response'));
  });
});

