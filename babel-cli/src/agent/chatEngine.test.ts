import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { ChatEngine } from './chatEngine.js';
import { BABEL_RUNS_DIR } from '../cli/constants.js';

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
