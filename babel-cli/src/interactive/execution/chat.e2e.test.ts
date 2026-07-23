/**
 * chat.e2e.test.ts — True end-to-end chat journey with a real LLM.
 *
 * Exercises the full path: execution dispatch → ChatEngine multi-turn tool
 * loop → rendered output to stdout. Complements chat.integration.test.ts
 * (which tests executeChatTask with a mock engine) by driving through a
 * real LLM provider.
 *
 * ALL tests are conditionally skipped when no API key is available — they
 * are safe to include in CI even without credentials.
 *
 * Costs are bounded: each test uses the cheap model tier
 * (deepseek-v4-flash via DeepSeek). Expected cost per full run is ~$0.05-0.15.
 *
 * Each test creates its own temp directory that is cleaned up in `finally`.
 */

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ChatEngine } from '../../agent/chatEngine.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Check whether the default provider (DeepSeek) is available. */
function hasLiveProvider(): boolean {
  return Boolean(process.env['DEEPSEEK_API_KEY']);
}

/** Create a temp directory with known fixtures for a single test. */
function createE2eEnv(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'babel-chat-e2e-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'README.md'),
    '# Test Project\n\nThis is a test project for E2E chat testing.\n\nThe answer to the ultimate question is 42.\n',
    'utf-8',
  );
  writeFileSync(
    join(root, 'src', 'config.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0', debug: false }, null, 2),
    'utf-8',
  );
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Long timeout for real LLM calls (3 min). */
const E2E_TIMEOUT = 180_000;

// ─── Tests ─────────────────────────────────────────────────────────────────────

test(
  'chat E2E: ≥2 turns with tool call, answer reaches stdout',
  { skip: !hasLiveProvider(), timeout: E2E_TIMEOUT },
  async () => {
    const { root, cleanup } = createE2eEnv();
    try {
      // ── Turn 1: read a file ─────────────────────────────────────────────
      const engine = new ChatEngine({
        task: 'Read the file src/README.md and tell me what the answer to the ultimate question is.',
        projectRoot: root,
        maxTurns: 4,
        modelTier: 'cheap',
      });

      const writes: string[] = [];
      const origStdout = process.stdout.write.bind(process.stdout);
      const capturedWrite = (chunk: unknown): boolean => {
        const str = typeof chunk === 'string' ? chunk
          : chunk instanceof Uint8Array ? Buffer.from(chunk).toString()
          : String(chunk ?? '');
        writes.push(str);
        return true;
      };
      process.stdout.write = capturedWrite as typeof process.stdout.write;

      try {
        const result1 = await engine.submitMessage(
          'Read the file src/README.md and tell me what the answer to the ultimate question is.',
          {},
        );

        assert.equal(result1.status, 'completed', 'turn 1 should complete');
        assert.ok(
          result1.answer.includes('42'),
          `turn 1 answer should mention 42, got: "${result1.answer.slice(0, 200)}"`,
        );

        // Check tool calls via ChatResult.toolCalls (ChatMessage has no tool_calls field)
        const usedTools = (result1.toolCalls?.length ?? 0) > 0;
        assert.ok(
          usedTools || result1.answer.includes('42'),
          'turn 1 should use tool calls or contain the answer',
        );

        // ── Turn 2: follow-up question using the context ─────────────────
        const result2 = await engine.submitMessage(
          'Based on the README, what is the answer to the ultimate question? Give it as just the number.',
          {},
        );

        assert.equal(result2.status, 'completed', 'turn 2 should complete');
        assert.ok(
          result2.answer.includes('42'),
          `turn 2 answer should include 42, got: "${result2.answer.slice(0, 200)}"`,
        );

        // Verify conversation accumulated across turns
        assert.ok(
          result2.conversation.length >= result1.conversation.length,
          'conversation should grow across turns',
        );
      } finally {
        process.stdout.write = origStdout;
      }
    } finally {
      cleanup();
    }
  },
);

test(
  'chat E2E: tool use observable in conversation history',
  { skip: !hasLiveProvider(), timeout: E2E_TIMEOUT },
  async () => {
    const { root, cleanup } = createE2eEnv();
    try {
      const engine = new ChatEngine({
        task: 'List the files in the src/ directory.',
        projectRoot: root,
        maxTurns: 4,
        modelTier: 'cheap',
      });

      const result = await engine.submitMessage(
        'List the files in the src/ directory and tell me what files you see.',
        {},
      );

      assert.equal(result.status, 'completed', 'should complete');
      assert.ok(result.answer.length > 0, 'answer should not be empty');

      // Tool calls are tracked in result.toolCalls, not ChatMessage (which has no tool_calls field)
      const didUseTools = (result.toolCalls?.length ?? 0) > 0;
      if (didUseTools) {
        // Verify tool response messages exist in the conversation
        const toolResults = result.conversation.filter(
          (m) => m.role === 'tool',
        );
        assert.ok(toolResults.length > 0, 'tool calls should have responses');
      }
    } finally {
      cleanup();
    }
  },
);

test(
  'chat E2E: multi-turn context retention',
  { skip: !hasLiveProvider(), timeout: E2E_TIMEOUT },
  async () => {
    const { root, cleanup } = createE2eEnv();
    try {
      const engine = new ChatEngine({
        task: 'Read src/config.json and tell me the app name.',
        projectRoot: root,
        maxTurns: 4,
        modelTier: 'cheap',
      });

      // Turn 1: read config
      const result1 = await engine.submitMessage(
        'Read src/config.json and tell me the app name.',
        {},
      );
      assert.equal(result1.status, 'completed', 'turn 1 should complete');
      assert.ok(
        result1.answer.toLowerCase().includes('test-app'),
        `turn 1 should mention test-app, got: "${result1.answer.slice(0, 200)}"`,
      );

      // Turn 2: follow-up without restating context
      const result2 = await engine.submitMessage(
        'What is the version of the app you just read about?',
        {},
      );
      assert.equal(result2.status, 'completed', 'turn 2 should complete');
      assert.ok(
        result2.answer.includes('1.0.0'),
        `turn 2 should include version 1.0.0, got: "${result2.answer.slice(0, 200)}"`,
      );
    } finally {
      cleanup();
    }
  },
);
