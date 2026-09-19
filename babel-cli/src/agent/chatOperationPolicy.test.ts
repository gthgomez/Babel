/**
 * D01/D02 critical path — one coherent effective-operation policy.
 *
 * These tests exercise the production classifiers and TurnRuntime builder that
 * ChatEngine actually consumes (never a copied helper):
 *   - analyzeTaskShape / classifyChatTaskClassFromText (config classifier)
 *   - ChatEngine.classifyChatTaskIntent (text-intent classifier)
 *   - beginUserSubmission / ChatEngine.applyUserSubmission (accepted submission)
 *   - applyExploreFuses read-only preparation (mutation-pressure bypass)
 *   - the streamed production path via submitMessageStream
 *
 * Acceptance: D-T01, D-T02, D-T03, D-T04, D-T08(core).
 */

import assert from 'node:assert/strict';
import { describe, test, after } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import {
  analyzeTaskShape,
  classifyChatTaskClassFromText,
  type TaskOperation,
} from '../config/chatTaskClass.js';
import { beginUserSubmission, type TurnRuntimeSnapshot } from './turnRuntime.js';
import { applyExploreFuses } from './chatZeroWritePolicy.js';
import { consumeChatStream } from '../interactive/execution/chatCore.js';
import type { ToolStreamEvent } from '../runners/base.js';

const PROJECT_ROOT = join(tmpdir(), 'babel-op-policy');
const MODEL = 'deepseek-v4-flash';

const D_T01_PROMPT =
  'can you investigate the babel-public-live repo for the current TUI Code?';
const D_T03_PROMPT =
  'Investigate the Babel terminal interface and fix the rendering problem.';
const D_T04_PROMPT =
  'Read-only: do not edit files. Review this code: ```typescript\nconst x = 1;\n```';

/** D-T02: equivalent read-only verbs, ordinary + modal phrasing. */
const D_T02_PROMPTS: readonly string[] = [
  'inspect the tests',
  'investigate the tests',
  'research the tests',
  'review the tests',
  'Can you inspect the tests?',
  'can you investigate the tests?',
  'please research the tests',
  'Please review the tests.',
  'Research the build pipeline.',
];

function runtimeFor(
  prompt: string,
  previous: TurnRuntimeSnapshot | null = null,
  continueTask = false,
): TurnRuntimeSnapshot {
  return beginUserSubmission({
    userInput: prompt,
    projectRoot: PROJECT_ROOT,
    ...(previous ? { previous } : {}),
    ...(continueTask ? { continueTask: true } : {}),
    classifyIntent: (text) => ChatEngine.classifyChatTaskIntent(text),
  });
}

function installMockRunner(
  engine: ChatEngine,
  runner: {
    executeWithToolsStream: () => AsyncGenerator<ToolStreamEvent, void, undefined>;
    execute: () => Promise<{ type: string; answer: string }>;
    getLastInvocationMetadata: () => null;
  },
): void {
  const anyEngine = engine as unknown as {
    deliberationRunner: unknown;
    synthesisRunner: unknown;
    shouldUseNativeTools: () => boolean;
  };
  anyEngine.deliberationRunner = runner;
  anyEngine.synthesisRunner = runner;
  anyEngine.shouldUseNativeTools = () => true;
}

describe('D01/D02 effective-operation policy', () => {
  test('D-T01 exact prompt resolves to investigate/READ_ONLY with no mutation pressure', () => {
    const shape = analyzeTaskShape(D_T01_PROMPT);
    assert.equal(shape.operation, 'READ_ONLY');
    assert.equal(classifyChatTaskClassFromText(D_T01_PROMPT), 'investigate');
    assert.equal(ChatEngine.classifyChatTaskIntent(D_T01_PROMPT), 'explain');

    const runtime = runtimeFor(D_T01_PROMPT);
    assert.equal(runtime.taskClass, 'investigate');
    assert.equal(runtime.effectiveOperation, 'READ_ONLY');

    // Preparation must not press the read-only submission to mutate even though
    // the legacy executeIntent flag may still be true at some call sites.
    const fuses = applyExploreFuses({
      executeIntent: true,
      readOnlyOperation: true,
      taskClass: 'investigate',
      hasAnyWrites: false,
      state: {
        turnsWithoutWrite: 9,
        consecutiveReadOnlyTools: 30,
        cumulativeExplorationTools: 30,
        restrictToolsNextTurn: false,
        consecutiveNonMutatingShells: 6,
        toolsWithoutWrite: 30,
        phase: 'investigate',
      },
      pushUser: () => {},
    });
    assert.equal(fuses.forceMutateMessage, null);
    assert.equal(fuses.readThrashMessage, null);
    assert.equal(fuses.explorationFuseMessage, null);
    assert.equal(fuses.shellSoftMessage, null);
  });

  test('D-T02 inspect/investigate/research/review agree on read-only semantics', () => {
    for (const prompt of D_T02_PROMPTS) {
      const shape = analyzeTaskShape(prompt);
      assert.equal(shape.operation, 'READ_ONLY', `shape READ_ONLY for "${prompt}"`);
      assert.equal(
        classifyChatTaskClassFromText(prompt),
        'investigate',
        `task class investigate for "${prompt}"`,
      );
      assert.equal(
        ChatEngine.classifyChatTaskIntent(prompt),
        'explain',
        `intent explain for "${prompt}"`,
      );
      const runtime = runtimeFor(prompt);
      assert.equal(
        runtime.effectiveOperation,
        'READ_ONLY',
        `effective operation READ_ONLY for "${prompt}"`,
      );
      assert.equal(runtime.taskClass, 'investigate', `runtime class for "${prompt}"`);
    }
  });

  test('D-T03 investigate-and-fix keeps mutation intent', () => {
    const shape = analyzeTaskShape(D_T03_PROMPT);
    assert.equal(shape.operation, 'MUTATING');
    assert.equal(classifyChatTaskClassFromText(D_T03_PROMPT), 'default');
    assert.equal(ChatEngine.classifyChatTaskIntent(D_T03_PROMPT), 'execute');

    const runtime = runtimeFor(D_T03_PROMPT);
    assert.equal(runtime.effectiveOperation, 'MUTATING');

    // No blanket investigate => read-only shortcut.
    const fuses = applyExploreFuses({
      executeIntent: true,
      readOnlyOperation:
        (runtime.effectiveOperation as TaskOperation | undefined) === 'READ_ONLY',
      taskClass: runtime.taskClass,
      hasAnyWrites: false,
      state: {
        turnsWithoutWrite: 9,
        consecutiveReadOnlyTools: 30,
        cumulativeExplorationTools: 30,
        restrictToolsNextTurn: false,
        consecutiveNonMutatingShells: 6,
        toolsWithoutWrite: 30,
        phase: 'investigate',
      },
      pushUser: () => {},
    });
    assert.ok(fuses.forceMutateMessage, 'mutation-shaped hybrid task keeps fuse pressure');
  });

  test('D-T04 fenced code cannot overrule an explicit no-edit directive', () => {
    const shape = analyzeTaskShape(D_T04_PROMPT);
    assert.equal(shape.operation, 'READ_ONLY');
    assert.equal(classifyChatTaskClassFromText(D_T04_PROMPT), 'investigate');
    assert.equal(ChatEngine.classifyChatTaskIntent(D_T04_PROMPT), 'explain');

    const runtime = runtimeFor(D_T04_PROMPT);
    assert.equal(runtime.effectiveOperation, 'READ_ONLY');
  });

  test('D-T08 fresh vs reused submissions and direct vs streamed callers agree', async () => {
    // Direct builder: fresh submission derives the policy from the task text.
    const fresh = runtimeFor(D_T01_PROMPT);
    assert.equal(fresh.effectiveOperation, 'READ_ONLY');

    // Reused runtime: prior mutating task must not leak into the isolated
    // read-only submission, and a later mutating task must not inherit either.
    const mutating = runtimeFor('fix the rendering bug');
    assert.equal(mutating.effectiveOperation, 'MUTATING');
    const reused = runtimeFor(D_T01_PROMPT, mutating);
    assert.equal(reused.continuedTask, false);
    assert.equal(reused.effectiveOperation, 'READ_ONLY');
    assert.equal(reused.taskClass, 'investigate');
    const afterReuse = runtimeFor('implement the new endpoint', reused);
    assert.equal(afterReuse.effectiveOperation, 'MUTATING');

    // Explicit continuation freezes the prior operation policy.
    const continued = runtimeFor('continue', mutating, true);
    assert.equal(continued.continuedTask, true);
    assert.equal(continued.effectiveOperation, 'MUTATING');

    // Reused ChatEngine instance (TUI) + streamed production caller.
    const root = mkdtempSync(join(tmpdir(), 'babel-op-stream-'));
    try {
      writeFileSync(join(root, 'target.ts'), 'export const x = 1;\n', 'utf-8');
      const engine = new ChatEngine({ task: D_T01_PROMPT, projectRoot: root, model: MODEL });
      let call = 0;
      installMockRunner(engine, {
        executeWithToolsStream: async function* () {
          call += 1;
          if (call === 1) {
            yield {
              type: 'tool_use',
              id: 'r1',
              name: 'read_file',
              input: { path: 'target.ts' },
            };
            yield { type: 'done', finishReason: 'tool_calls' };
            return;
          }
          yield { type: 'text_delta', text: 'Investigation complete.' };
          yield { type: 'done', finishReason: 'stop' };
        },
        execute: async () => ({ type: 'completion', answer: 'Investigation complete.' }),
        getLastInvocationMetadata: () => null,
      });

      const captured: ChatEvent[] = [];
      const generator = engine.submitMessageStream(D_T01_PROMPT);
      await consumeChatStream(
        (async function* () {
          for await (const event of generator) {
            captured.push(event);
            yield event;
          }
        })(),
        null,
      );

      const snapshot = engine.getTurnRuntimeSnapshot();
      assert.ok(snapshot, 'streamed run records a turn runtime');
      assert.equal(snapshot!.effectiveOperation, 'READ_ONLY');
      assert.equal(snapshot!.taskClass, 'investigate');

      const falseEnforced = captured.filter(
        (event) =>
          event.type === 'progress_recovery' &&
          (event.intervention === 'restricted_tools' ||
            event.intervention === 'terminal_blocked'),
      );
      assert.deepEqual(falseEnforced, [], 'no false enforced progress labels for D-T01');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  after(() => {
    rmSync(PROJECT_ROOT, { recursive: true, force: true });
  });
});
