import { verifierSemanticProgress } from './verifierSemanticProgress.js';
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
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine, type ChatEvent, type ChatResult } from './chatEngine.js';
import {
  analyzeTaskShape,
  classifyChatTaskClassFromText,
  type TaskOperation,
} from '../config/chatTaskClass.js';
import { beginUserSubmission, type TurnRuntimeSnapshot } from './turnRuntime.js';
import { filterReadOnlyTaskTools } from './chatReadOnly.js';
import { buildChatToolDefinitions } from './chatToolDefinitions.js';
import { buildDelegatedChildEnvelope } from './chatEngineChildExecution.js';
import { applyExploreFuses } from './chatZeroWritePolicy.js';
import { consumeChatStream } from '../interactive/execution/chatCore.js';
import { ProgressController } from './progressController.js';
import { createStallDetector } from './stallDetector.js';
import type { ToolStreamEvent } from '../runners/base.js';

const PROJECT_ROOT = join(tmpdir(), 'babel-op-policy');
const MODEL = 'deepseek-v4-flash';

const D_T01_PROMPT =
  'can you investigate the babel-public-live repo for the current TUI Code?';
const D_T03_PROMPT =
  'Investigate the Babel terminal interface and fix the rendering problem.';
const D_T04_PROMPT =
  'Read-only: do not edit files. Review this code: ```typescript\nconst x = 1;\n```';
const D_T04_PATH_PROMPT = 'review the repair.ts and write_file paths';
const D_T04_PATH_DIRECTIVE_PROMPT =
  'Read-only: do not edit files. Review the repair.ts and write_file paths';

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
  // I1: informational "how to <verb>" frames describe a topic, not an action.
  'research how to implement OAuth',
  'can you research the best way to refactor this?',
  'investigate how to fix the memory leak',
  'research how to delete files safely',
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

/** One read of `file`, then a text completion. */
function installReadThenComplete(engine: ChatEngine, file: string): void {
  let call = 0;
  installMockRunner(engine, {
    executeWithToolsStream: async function* () {
      call += 1;
      if (call === 1) {
        yield { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: file } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text_delta', text: 'Investigation complete.' };
      yield { type: 'done', finishReason: 'stop' };
    },
    execute: async () => ({ type: 'completion', answer: 'Investigation complete.' }),
    getLastInvocationMetadata: () => null,
  });
}

async function drain(
  engine: ChatEngine,
  prompt: string,
  captured: ChatEvent[],
): Promise<ChatResult> {
  const generator = engine.submitMessageStream(prompt);
  return consumeChatStream(
    (async function* () {
      for await (const event of generator) {
        captured.push(event);
        yield event;
      }
    })(),
    null,
  );
}

const RESTRICTING_LABELS = new Set(['restricted_tools', 'last_chance_repair', 'terminal_blocked']);

describe('D01/D02 effective-operation policy', () => {
  test('saved live maintenance request retains its accepted documentation-edit authority', () => {
    const prompt = 'I am onboarding a new analyst who needs to refresh the monthly dashboard safely. The instructions are hard to find. Improve the navigation so a newcomer can reach the current procedure and understand what not to overwrite. Use your judgment for a small, reversible documentation change; keep all existing pages, and do not change scripts or data. Ask only if a choice is genuinely necessary. Explain what changed and what you checked. Do not commit or push.';
    const runtime = runtimeFor(prompt);

    assert.equal(runtime.effectiveOperation, 'HYBRID');
    assert.equal(runtime.taskIntent, 'execute');
    const tools = filterReadOnlyTaskTools(buildChatToolDefinitions(), runtime.effectiveOperation, []);
    assert.ok(tools.some((tool) => tool.function.name === 'write_file'));
  });

  test('scoped preservation clauses keep documentation edits writable through Chat delegation', () => {
    const prompt = 'Improve the navigation for new analysts. Keep all existing pages, and do not change scripts or data. Explain what changed and what you checked.';
    const runtime = runtimeFor(prompt);
    const parentReadOnly = runtime.effectiveOperation === 'READ_ONLY';

    assert.equal(runtime.effectiveOperation, 'HYBRID');
    assert.equal(parentReadOnly, false);
    assert.equal(runtime.taskIntent, 'execute');

    const tools = filterReadOnlyTaskTools(buildChatToolDefinitions(), runtime.effectiveOperation, []);
    assert.ok(tools.some((tool) => tool.function.name === 'write_file'));

    const delegated = buildDelegatedChildEnvelope({
      task: prompt,
      projectRoot: PROJECT_ROOT,
      parentReadOnly,
      requestedMutation: true,
      requestedWriteScope: ['README.md'],
      instructions: 'Make the scoped documentation change.',
      parentModel: null,
    });
    assert.equal(delegated.mutationEnabled, true);
    assert.deepEqual(delegated.writeScope, ['README.md']);

    const inspection = runtimeFor('Review the documentation and suggest improvements. Do not edit files.');
    assert.equal(inspection.effectiveOperation, 'READ_ONLY');
    const readOnlyTools = filterReadOnlyTaskTools(buildChatToolDefinitions(), inspection.effectiveOperation, []);
    assert.ok(!readOnlyTools.some((tool) => tool.function.name === 'write_file'));
    const readOnlyChild = buildDelegatedChildEnvelope({
      task: 'Review the documentation and suggest improvements. Do not edit files.',
      projectRoot: PROJECT_ROOT,
      parentReadOnly: inspection.effectiveOperation === 'READ_ONLY',
      requestedMutation: true,
      requestedWriteScope: ['README.md'],
      instructions: 'Make a change.',
      parentModel: null,
    });
    assert.equal(readOnlyChild.mutationEnabled, false);
    assert.deepEqual(readOnlyChild.writeScope, []);

    const preservedScriptsInspection = runtimeFor('Review docs. Do not change scripts or data.');
    assert.equal(preservedScriptsInspection.effectiveOperation, 'READ_ONLY');
    const preservedScriptsTools = filterReadOnlyTaskTools(
      buildChatToolDefinitions(), preservedScriptsInspection.effectiveOperation, [],
    );
    assert.ok(!preservedScriptsTools.some((tool) => tool.function.name === 'write_file'));
  });

  test('a dependency constraint preserves only the parent task’s existing scoped child-write authority', () => {
    const prompt = 'Implement the requested function and create solution.py. Do not add third-party dependencies.';
    const runtime = runtimeFor(prompt);
    const parentReadOnly = runtime.effectiveOperation === 'READ_ONLY';
    assert.equal(runtime.effectiveOperation, 'HYBRID');
    assert.equal(parentReadOnly, false);

    const delegated = buildDelegatedChildEnvelope({
      task: prompt,
      projectRoot: PROJECT_ROOT,
      parentReadOnly,
      requestedMutation: true,
      requestedWriteScope: ['solution.py'],
      instructions: 'Implement the requested function in the scoped solution file.',
      parentModel: null,
    });
    assert.equal(delegated.mutationEnabled, true);
    assert.deepEqual(delegated.writeScope, ['solution.py']);

    const readOnlyPrompt = 'Do not add third-party dependencies.';
    const readOnly = runtimeFor(readOnlyPrompt);
    assert.equal(readOnly.effectiveOperation, 'READ_ONLY');
    const deniedDelegation = buildDelegatedChildEnvelope({
      task: readOnlyPrompt,
      projectRoot: PROJECT_ROOT,
      parentReadOnly: readOnly.effectiveOperation === 'READ_ONLY',
      requestedMutation: true,
      requestedWriteScope: ['solution.py'],
      instructions: 'Create solution.py.',
      parentModel: null,
    });
    assert.equal(deniedDelegation.mutationEnabled, false);
    assert.deepEqual(deniedDelegation.writeScope, []);
  });

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
    // Mixed investigate+fix is HYBRID (not READ_ONLY): mutation intent is
    // preserved while the investigation is acknowledged.
    assert.equal(shape.operation, 'HYBRID');
    assert.equal(classifyChatTaskClassFromText(D_T03_PROMPT), 'default');
    assert.equal(ChatEngine.classifyChatTaskIntent(D_T03_PROMPT), 'execute');

    const runtime = runtimeFor(D_T03_PROMPT);
    assert.equal(runtime.effectiveOperation, 'HYBRID');

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

  test('D-T04 fenced code/repair paths cannot overrule an explicit no-edit directive', () => {
    const shape = analyzeTaskShape(D_T04_PROMPT);
    assert.equal(shape.operation, 'READ_ONLY');
    assert.equal(classifyChatTaskClassFromText(D_T04_PROMPT), 'investigate');
    assert.equal(ChatEngine.classifyChatTaskIntent(D_T04_PROMPT), 'explain');
    assert.equal(runtimeFor(D_T04_PROMPT).effectiveOperation, 'READ_ONLY');

    // I2: a path named "repair.ts"/"write_file" is evidence, never mutation
    // authority — with or without an explicit no-edit directive.
    const pathShape = analyzeTaskShape(D_T04_PATH_PROMPT);
    assert.equal(pathShape.operation, 'READ_ONLY');
    assert.equal(classifyChatTaskClassFromText(D_T04_PATH_PROMPT), 'investigate');
    assert.equal(ChatEngine.classifyChatTaskIntent(D_T04_PATH_PROMPT), 'explain');
    assert.equal(runtimeFor(D_T04_PATH_PROMPT).effectiveOperation, 'READ_ONLY');

    const directedShape = analyzeTaskShape(D_T04_PATH_DIRECTIVE_PROMPT);
    assert.equal(directedShape.operation, 'READ_ONLY');
    assert.equal(runtimeFor(D_T04_PATH_DIRECTIVE_PROMPT).effectiveOperation, 'READ_ONLY');
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
      // Reused engine: register a prior mutating submission first.
      const prior = engine.applyUserSubmission({ userInput: 'fix the rendering bug' });
      assert.equal(prior.effectiveOperation, 'MUTATING');
      installReadThenComplete(engine, 'target.ts');

      const captured: ChatEvent[] = [];
      await drain(engine, D_T01_PROMPT, captured);

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

  test('C1 reused engine resets W3 progress state per submission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-op-reused-'));
    try {
      writeFileSync(join(root, 'target.ts'), 'export const x = 1;\n', 'utf-8');
      const engine = new ChatEngine({ task: 'fix the bug', projectRoot: root, model: MODEL });
      const staleController = (engine as unknown as { progressController: ProgressController })
        .progressController;
      // Simulate a prior task that thrashed to terminal_blocked.
      for (let i = 0; i < 4; i += 1) staleController.scoreTurn([], true, 0);
      assert.equal(staleController.InterventionLevel, 'terminal_blocked');

      installReadThenComplete(engine, 'target.ts');
      const captured: ChatEvent[] = [];
      await drain(engine, D_T01_PROMPT, captured);

      const restricting = captured.filter(
        (event) =>
          event.type === 'progress_recovery' && RESTRICTING_LABELS.has(event.intervention),
      );
      assert.deepEqual(
        restricting,
        [],
        'reused engine must not leak prior W3 strikes into a read-only submission',
      );
      const freshController = (engine as unknown as { progressController: ProgressController })
        .progressController;
      // S06 integration: the controller instance is preserved (capability health
      // must survive), but its task-local punishment is reset. The streamed
      // read turn may add its own localization progress, so assert the leaked
      // punishment level is gone rather than a raw score of zero.
      assert.equal(freshController, staleController, 'controller instance preserved across submissions');
      assert.equal(freshController.InterventionLevel, 'none');
      assert.ok(
        freshController.TotalScore < 20,
        `stale task-local punishment must be cleared (score=${freshController.TotalScore})`,
      );
      assert.equal(engine.getTurnRuntimeSnapshot()?.effectiveOperation, 'READ_ONLY');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('M1 repeated identical verifier runs are not progress', () => {
    const engine = new ChatEngine({ task: 'run the tests', projectRoot: PROJECT_ROOT, model: MODEL });
    const anyEngine = engine as unknown as {
      computeVerifierChanged: (
        results: Array<{ tool_name: string; content?: string; exit_code?: number; verifierSemanticSignature?: string }>,
      ) => boolean;
    };
    const red = verifierSemanticProgress({ executionContextKey: 'host-context', candidateRevision: 'candidate', command: 'npm test', exitCode: 1, stdout: 'FAIL 1 test', stderr: '' });
    const green = verifierSemanticProgress({ executionContextKey: 'host-context', candidateRevision: 'candidate', command: 'npm test', exitCode: 0, stdout: 'PASS', stderr: '' });
    const run = { tool_name: 'run_command', content: 'FAIL 1 test', exit_code: 1, target: 'npm test', verifierExecuted: true, verifierSemanticSignature: red };
    assert.equal(anyEngine.computeVerifierChanged([run]), true, 'first verifier run counts');
    assert.equal(
      anyEngine.computeVerifierChanged([{ ...run }]),
      false,
      'identical repeat is not progress',
    );
    assert.equal(
      anyEngine.computeVerifierChanged([{ ...run, exit_code: 0, verifierSemanticSignature: green }]),
      true,
      'exit-code change counts',
    );
    assert.equal(
      anyEngine.computeVerifierChanged([{ ...run, exit_code: 0, verifierSemanticSignature: green }]),
      false,
      'same verdict again is not progress',
    );
    assert.equal(
      anyEngine.computeVerifierChanged([{ ...run, content: 'PASS', exit_code: 0, verifierSemanticSignature: green }]),
      false,
      'display text alone is not semantic progress',
    );
    assert.equal(anyEngine.computeVerifierChanged([]), false, 'no verifier tool is not progress');
  });

  test('only executed authoritative verifiers earn progress, including real failures', () => {
    const engine = new ChatEngine({ task: 'run tests', projectRoot: PROJECT_ROOT, model: MODEL });
    const check = (rows: unknown[]) => (engine as any).computeVerifierChanged(rows);
    for (const tool_name of ['run_command', 'test_run']) {
      assert.equal(check([{ tool_name, target: 'npm test', content: 'FAIL 1 test', exit_code: 1 }]), false);
      assert.equal(check([{ tool_name, target: 'npm test', verifierExecuted: false,
        content: 'Policy denied: DENY_MISSING_AUTHORITY', exit_code: 1 }]), false);
      assert.equal(check([{ tool_name, target: 'node --version', verifierExecuted: true,
        content: 'v22.0.0', exit_code: 0 }]), false);
    }
    const failed = { tool_name: 'test_run', target: 'npm test', verifierExecuted: true,
      content: 'FAIL 1 test', exit_code: 1, verifierSemanticSignature: 'host-red-semantic-tuple' };
    assert.equal(check([failed]), true);
    assert.equal(check([{ tool_name: 'run_command', target: 'node --version', verifierExecuted: true,
      content: 'v22.0.1', exit_code: 0 }]), false);
    assert.equal(check([failed]), false, 'a probe must not reset the last real verifier signature');
    assert.equal(check([{ ...failed, content: 'PASS 1 test', exit_code: 0, verifierSemanticSignature: 'host-green-semantic-tuple' }]), true);
  });

  test('live streaming loop clears completion strikes after a newly executed red verifier', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-gate-verifier-progress-'));
    const previousFallback = process.env['BABEL_ALLOW_HOST_FALLBACK'];
    process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'red.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('red', () => assert.equal(1, 2));\n");
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], { cwd: root });
    const task = 'Fix the failure in red.test.mjs and run node --test red.test.mjs to verify the repair.';
    const engine = new ChatEngine({ task, projectRoot: root, model: MODEL, maxTurns: 2 });
    const box = engine as unknown as { gateStrikes: number };
    (engine as unknown as { hardPlanMode: boolean; requireTodoBeforeMutate: boolean }).hardPlanMode = false;
    (engine as unknown as { hardPlanMode: boolean; requireTodoBeforeMutate: boolean }).requireTodoBeforeMutate = false;
    let calls = 0;
    let strikesBeforeAnswer: number | undefined;
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        calls += 1;
        if (calls === 1) {
          box.gateStrikes = 2;
          yield { type: 'tool_use', id: 'red-verifier', name: 'test_run', input: { command: 'node --test red.test.mjs', cwd: 'nested' } };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        strikesBeforeAnswer = box.gateStrikes;
        yield { type: 'text_delta', text: 'The executed verifier is red; I cannot certify completion.' };
        yield { type: 'done', finishReason: 'stop' };
      },
      execute: async () => ({ type: 'completion', answer: 'The executed verifier is red; I cannot certify completion.' }),
      getLastInvocationMetadata: () => null,
    });
    try {
      const result = await drain(engine, task, []);
      assert.equal(calls, 2);
      assert.equal(strikesBeforeAnswer, 0, `actual verifier progress resets stale completion-gate strikes; log=${JSON.stringify(engine['toolCallLog'])}`);
      const verifierLog = engine['toolCallLog'].find(row => row.tool === 'test_run') as
        ({ tool: string; verifierExecuted?: boolean; working_directory?: string; processExecuted?: boolean; processCompleted?: boolean; exit_code?: number } | undefined);
      assert.equal(verifierLog?.verifierExecuted, true,
        'the reset requires a host-observed executed red verifier');
      assert.equal(verifierLog?.exit_code, 1, 'red test command exits nonzero and is not authoritative completion');
      const loggedCwdIdentity = statSync(verifierLog!.working_directory!);
      const expectedCwdIdentity = statSync(join(root, 'nested'));
      assert.equal(loggedCwdIdentity.isDirectory(), true, 'logged cwd resolves to a directory');
      assert.equal(loggedCwdIdentity.dev, expectedCwdIdentity.dev,
        'cwd provenance identifies the expected filesystem device');
      assert.equal(loggedCwdIdentity.ino, expectedCwdIdentity.ino,
        'cwd provenance identifies the expected directory even when Windows uses an 8.3 alias');
      const distinctCwdIdentity = statSync(root);
      assert.ok(
        loggedCwdIdentity.dev !== distinctCwdIdentity.dev || loggedCwdIdentity.ino !== distinctCwdIdentity.ino,
        'cwd provenance continues to distinguish a genuinely different working directory',
      );
      assert.equal(verifierLog?.processExecuted, true);
      assert.equal(verifierLog?.processCompleted, true, JSON.stringify(verifierLog));
      assert.notEqual(result.outcome, 'VERIFIED_COMPLETE', 'a red verifier cannot certify the task');
    } finally {
      if (previousFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
      else process.env['BABEL_ALLOW_HOST_FALLBACK'] = previousFallback;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('live streaming loop ignores a cached verifier result but resets for a distinct alternating result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-gate-verifier-repeat-'));
    const previousFallback = process.env['BABEL_ALLOW_HOST_FALLBACK'];
    process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'green.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('green', () => assert.equal(1, 1));\n");
    writeFileSync(join(root, 'nested', 'red.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('red', () => assert.equal(1, 2));\n");
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], { cwd: root });
    const task = 'Fix red.test.mjs so its test passes. Run the green and red verifier commands to check the fixtures.';
    const engine = new ChatEngine({ task, projectRoot: root, model: MODEL, maxTurns: 5 });
    const box = engine as unknown as { gateStrikes: number };
    (engine as unknown as { hardPlanMode: boolean; requireTodoBeforeMutate: boolean }).hardPlanMode = false;
    (engine as unknown as { hardPlanMode: boolean; requireTodoBeforeMutate: boolean }).requireTodoBeforeMutate = false;
    let calls = 0;
    let strikesAfterCachedReceipt: number | undefined;
    let strikesAfterStaleCacheRefresh: number | undefined;
    let strikesAfterAlternatingRed: number | undefined;
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        calls += 1;
        if (calls <= 2) {
          if (calls === 2) box.gateStrikes = 2;
          yield { type: 'tool_use', id: `green-verifier-${calls}`, name: 'test_run', input: { command: 'node --test green.test.mjs', cwd: 'nested' } };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        if (calls === 3) {
          strikesAfterCachedReceipt = box.gateStrikes;
          box.gateStrikes = 2;
          // Simulate a workspace change after the successful receipt was cached.
          // The same command must execute again; the prior receipt is stale.
          writeFileSync(join(root, 'nested', 'green.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('green changed', () => assert.equal(2, 2));\n");
          yield { type: 'tool_use', id: 'green-verifier-after-drift', name: 'test_run', input: { command: 'node --test green.test.mjs', cwd: 'nested' } };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        if (calls === 4) {
          strikesAfterStaleCacheRefresh = box.gateStrikes;
          box.gateStrikes = 2;
          yield { type: 'tool_use', id: 'red-verifier-alternating', name: 'test_run', input: { command: 'node --test red.test.mjs', cwd: 'nested' } };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        strikesAfterAlternatingRed = box.gateStrikes;
        yield { type: 'text_delta', text: 'The alternating verifier is red; I cannot certify completion.' };
        yield { type: 'done', finishReason: 'stop' };
      },
      execute: async () => ({ type: 'completion', answer: 'The alternating verifier is red; I cannot certify completion.' }),
      getLastInvocationMetadata: () => null,
    });
    try {
      const result = await drain(engine, task, []);
      assert.equal(calls, 5);
      assert.equal(strikesAfterCachedReceipt, 2, `a cached receipt must not reset recovery pressure; log=${JSON.stringify(engine['toolCallLog'])}`);
      assert.equal(strikesAfterStaleCacheRefresh, 0, `a changed workspace invalidates the old receipt and a newly executed result resets pressure; log=${JSON.stringify(engine['toolCallLog'])}`);
      assert.equal(strikesAfterAlternatingRed, 0, `a distinct red result remains fresh diagnostic progress; log=${JSON.stringify(engine['toolCallLog'])}`);
      assert.ok(engine['toolCallLog'].some(row => row.detail?.includes('cached receipt')),
        `second green check must be an actual cache reuse; log=${JSON.stringify(engine['toolCallLog'])}`);
      assert.ok(engine['toolCallLog'].some(row => row.target.includes('green.test.mjs') && row.processExecuted === true),
        `changed green fixture must re-execute after the prior receipt becomes stale; log=${JSON.stringify(engine['toolCallLog'])}`);
      assert.equal(engine['toolCallLog'].find(row => row.target.includes('red.test.mjs'))?.exit_code, 1);
      assert.notEqual(result.outcome, 'VERIFIED_COMPLETE');
    } finally {
      if (previousFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
      else process.env['BABEL_ALLOW_HOST_FALLBACK'] = previousFallback;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('live streaming loop does not reset strikes for a verifier rejected before execution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-gate-verifier-rejected-'));
    const previousFallback = process.env['BABEL_ALLOW_HOST_FALLBACK'];
    const previousProfile = process.env['BABEL_EXECUTION_PROFILE'];
    const previousImage = process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
    process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo';
    delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
    writeFileSync(join(root, 'red.test.mjs'), "import test from 'node:test'; test('fixture', () => {});\n");
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], { cwd: root });
    const task = 'Fix the issue in red.test.mjs and run node --test red.test.mjs to verify the repair.';
    const engine = new ChatEngine({ task, projectRoot: root, model: MODEL, maxTurns: 2 });
    const box = engine as unknown as { gateStrikes: number };
    (engine as unknown as { hardPlanMode: boolean; requireTodoBeforeMutate: boolean }).hardPlanMode = false;
    (engine as unknown as { hardPlanMode: boolean; requireTodoBeforeMutate: boolean }).requireTodoBeforeMutate = false;
    let calls = 0;
    let strikesAfterRejection: number | undefined;
    installMockRunner(engine, {
      executeWithToolsStream: async function* () {
        calls += 1;
        if (calls === 1) {
          box.gateStrikes = 2;
          yield { type: 'tool_use', id: 'rejected-verifier', name: 'test_run', input: { command: 'node --test red.test.mjs' } };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        strikesAfterRejection = box.gateStrikes;
        yield { type: 'text_delta', text: 'The verifier was rejected before execution; I cannot certify completion.' };
        yield { type: 'done', finishReason: 'stop' };
      },
      execute: async () => ({ type: 'completion', answer: 'The verifier was rejected before execution; I cannot certify completion.' }),
      getLastInvocationMetadata: () => null,
    });
    try {
      const result = await drain(engine, task, []);
      assert.equal(calls, 2);
      assert.equal(strikesAfterRejection, 2, `a rejected verifier cannot reset completion pressure; log=${JSON.stringify(engine['toolCallLog'])}`);
      const verifierLog = engine['toolCallLog'].find(row => row.tool === 'test_run');
      assert.ok(verifierLog);
      assert.notEqual(verifierLog.verifierExecuted, true);
      assert.notEqual(verifierLog.processExecuted, true);
      assert.notEqual(result.outcome, 'VERIFIED_COMPLETE');
    } finally {
      if (previousFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
      else process.env['BABEL_ALLOW_HOST_FALLBACK'] = previousFallback;
      if (previousProfile === undefined) delete process.env['BABEL_EXECUTION_PROFILE'];
      else process.env['BABEL_EXECUTION_PROFILE'] = previousProfile;
      if (previousImage === undefined) delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];
      else process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = previousImage;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('I3 bare continuation gestures carry the prior operation policy', () => {
    const mutating = runtimeFor('fix the rendering bug');
    assert.equal(mutating.effectiveOperation, 'MUTATING');
    for (const gesture of ['continue', 'keep going', 'go on', 'do it', 'proceed', 'continue please']) {
      const cont = runtimeFor(gesture, mutating);
      assert.equal(cont.continuedTask, false, `counters isolate for "${gesture}"`);
      assert.equal(cont.effectiveOperation, 'MUTATING', `mutation carries for "${gesture}"`);
      assert.equal(cont.taskClass, 'default', `class carries for "${gesture}"`);
    }

    const readOnly = runtimeFor('inspect the tests');
    assert.equal(readOnly.effectiveOperation, 'READ_ONLY');
    const contReadOnly = runtimeFor('continue', readOnly);
    assert.equal(contReadOnly.effectiveOperation, 'READ_ONLY');
    assert.equal(contReadOnly.taskClass, 'investigate');

    // Explicit operation text is classified on its own merits, not carried.
    const explicit = runtimeFor('continue and fix the bug', mutating);
    assert.notEqual(explicit.effectiveOperation, 'READ_ONLY');
  });

  test('I4 stall path consumes the effective operation, not taskClass', () => {
    const engine = new ChatEngine({ task: D_T01_PROMPT, projectRoot: PROJECT_ROOT, model: MODEL });
    // Simulate an env/autonomy task-class override that disagrees with the
    // admitted operation policy.
    (engine as unknown as { taskClass: string }).taskClass = 'default';
    const stalledState = () => {
      const state = createStallDetector();
      state.totalToolCalls = 10;
      state.turnsSinceLastWrite = 40;
      state.turnsSinceNewFileRead = 40;
      // isStalled requires the last three read targets to be identical.
      state.lastReadTargets = ['a.ts', 'b.ts', 'c.ts', 'c.ts', 'c.ts'];
      return state;
    };
    const anyEngine = engine as unknown as {
      stallState: ReturnType<typeof createStallDetector>;
      checkStallIntervention: (readOnly: boolean) => { level: string; message: string } | null;
    };

    anyEngine.stallState = stalledState();
    const readOnlyStall = anyEngine.checkStallIntervention(true);
    assert.ok(readOnlyStall, 'read-only stall still escalates');
    assert.match(readOnlyStall!.message, /synthesize/i);
    assert.doesNotMatch(readOnlyStall!.message, /write the necessary changes/i);

    anyEngine.stallState = stalledState();
    const mutatingStall = anyEngine.checkStallIntervention(false);
    assert.ok(mutatingStall, 'mutating stall still escalates');
    assert.match(mutatingStall!.message, /write|BLOCKED/i);
  });

  test('F1 finalization consumes the effective operation: bare how-to and fenced evidence are not pressed to patch', async () => {
    const prompts = [
      'how to fix the memory leak',
      'tell me how to fix the memory leak',
      'whether we should update the schema',
      // Bare problem statements (from the D03 lane's F1 ruling) must also stay
      // read-only; a mutation verb is required to earn execute pressure.
      'the login page is broken',
      'it crashes on startup',
      'users cannot log in',
      'the build is failing',
      'review this code: ```typescript\nconst x = 1;\n```',
    ];
    for (const prompt of prompts) {
      // Finalization follows the accepted operation regardless of legacy intent.
      assert.equal(
        analyzeTaskShape(prompt).operation,
        'READ_ONLY',
        `shape READ_ONLY for "${prompt}"`,
      );
      assert.equal(
        runtimeFor(prompt).effectiveOperation,
        'READ_ONLY',
        `effective operation READ_ONLY for "${prompt}"`,
      );

      const root = mkdtempSync(join(tmpdir(), 'babel-op-fin-'));
      try {
        const engine = new ChatEngine({
          task: prompt,
          projectRoot: root,
          model: MODEL,
          maxTurns: 8,
        });
        // Text-only completion each turn: without effective-operation
        // finalization this triggers "completion prefers patch" repeatedly and
        // burns the turn budget.
        installMockRunner(engine, {
          executeWithToolsStream: async function* () {
            yield { type: 'text_delta', text: 'Here is the explanation you asked for.' };
            yield { type: 'done', finishReason: 'stop' };
          },
          execute: async () => ({
            type: 'completion',
            answer: 'Here is the explanation you asked for.',
          }),
          getLastInvocationMetadata: () => null,
        });

        const captured: ChatEvent[] = [];
        const result: ChatResult = await drain(engine, prompt, captured);

        const patchPressure = captured.filter(
          (event) => event.type === 'thought' && /completion prefers patch/i.test(event.text),
        );
        assert.deepEqual(patchPressure, [], `no patch pressure for "${prompt}"`);

        const enforced = captured.filter(
          (event) =>
            event.type === 'progress_recovery' && RESTRICTING_LABELS.has(event.intervention),
        );
        assert.deepEqual(enforced, [], `no enforced restriction for "${prompt}"`);

        assert.notEqual(
          result.outcome,
          'BUDGET_EXHAUSTED',
          `read-only prompt must not burn to budget exhaustion: "${prompt}"`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  after(() => {
    rmSync(PROJECT_ROOT, { recursive: true, force: true });
  });
});
