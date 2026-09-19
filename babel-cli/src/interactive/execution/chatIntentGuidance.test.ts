/**
 * S01/#211 — native request-capture regression.
 *
 * The defect: `runChatEngineOnce()` resolved the preparation task class with
 * `autoClassify:false` while limits used `autoClassify:true`, so informational
 * requests were treated as execute-like and received the generated intent plan
 * + pre-loop repair template ("identify the fix location" / `str_replace`).
 * `submitMessageStream()` then appended that harness guidance as a user message
 * with no operation-intent guard.
 *
 * These tests capture the actual provider-neutral messages handed to the runner
 * for BOTH a fresh engine (factory path) and a reused engine (applyTurnPreparation
 * path), and assert that READ_ONLY submissions never contain generated edit
 * mandates, while explicit `investigate and fix` still does.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine, type ChatEngineOptions } from '../../agent/chatEngine.js';
import { analyzeTaskShape } from '../../config/chatTaskClass.js';
import type {
  ProviderMessage,
  ToolDefinition,
  ToolStreamEvent,
} from '../../runners/base.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import { runChatEngineOnce } from './chatCore.js';

const MODEL = 'deepseek-v4-flash';

type Capture = { messages: ProviderMessage[]; systemPrompt?: string };

const roots: string[] = [];

function makeTarget(): AgentTargetContext {
  const root = mkdtempSync(join(tmpdir(), 'babel-intent-guidance-'));
  roots.push(root);
  return {
    targetRoot: root,
    workspaceRoot: null,
    project: null,
    source: 'cwd',
    cwd: root,
  };
}

function makeEngine(
  task: string,
  root: string,
  extra: Partial<ChatEngineOptions> = {},
): ChatEngine {
  return new ChatEngine({ task, projectRoot: root, model: MODEL, ...extra });
}

/** Install a deterministic runner that captures the provider-neutral request. */
function installCapturingRunner(engine: ChatEngine, captures: Capture[]): void {
  const runner = {
    executeWithToolsStream: async function* (
      messages: ProviderMessage[],
      _tools: ToolDefinition[],
      systemPrompt?: string,
    ): AsyncGenerator<ToolStreamEvent, void, undefined> {
      captures.push({ messages, ...(systemPrompt !== undefined ? { systemPrompt } : {}) });
      yield { type: 'text_delta', text: 'Answer.' };
      yield { type: 'done', finishReason: 'stop' };
    },
    execute: async (
      messages: ProviderMessage[],
    ): Promise<{ type: string; answer: string }> => {
      captures.push({ messages });
      return { type: 'completion', answer: 'Answer.' };
    },
    getLastInvocationMetadata: () => null,
  };
  const anyEngine = engine as unknown as {
    deliberationRunner: unknown;
    synthesisRunner: unknown;
    shouldUseNativeTools: () => boolean;
  };
  anyEngine.deliberationRunner = runner;
  anyEngine.synthesisRunner = runner;
  anyEngine.shouldUseNativeTools = () => true;
}

function userContents(capture: Capture): string {
  return capture.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n---\n');
}

function enginePlan(engine: ChatEngine): string | undefined {
  return (engine as unknown as { options: { intentPlanUserMessage?: string } }).options
    .intentPlanUserMessage;
}

/** Every marker is repair/execute-shaped guidance produced by the harness. */
const EDIT_MANDATE_MARKERS = [
  '## Intent Plan',
  '## Before You Start',
  'Identify the fix location',
  'str_replace',
  'Aim for: localize',
];

function assertNoEditMandate(capture: Capture, label: string): void {
  const text = userContents(capture);
  for (const marker of EDIT_MANDATE_MARKERS) {
    assert.ok(
      !text.includes(marker),
      `${label}: native request must not contain generated edit mandate "${marker}"\n--- captured user content ---\n${text}`,
    );
  }
}

/** Informational submissions: all TaskShape READ_ONLY. */
const READ_ONLY_PROBES: ReadonlyArray<{ label: string; task: string }> = [
  { label: 'greeting', task: 'hello' },
  { label: 'explanation', task: 'What does this function do?' },
  {
    label: 'read-only investigation',
    task: 'can you investigate the example repo for the current TUI Code?',
  },
  {
    label: 'quoted code',
    task: 'Read-only: do not edit files. Review this code:\n```typescript\nconst x = 1;\n```',
  },
  {
    label: 'repair-shaped filename',
    task: 'review the repair.ts and write_file paths',
  },
  {
    label: 'no-edit scope + fence + repair name',
    task:
      'Without editing anything, explain what `repair.ts` and `write_file.ts` do:\n```ts\nexport function repair() { return 1 }\n```',
  },
  // I1: fenced evidence containing mutation verbs is not mutation authority.
  {
    label: 'fenced snippet with mutation verb',
    task: 'Here is a code snippet:\n```python\ndef fix():\n    return 1\n```\nWhat does it do?',
  },
  {
    label: 'fenced diff with mutation verb',
    task: 'Explain this diff:\n```diff\n+function update() { return 1 }\n```',
  },
];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('S01/#211 informational Chat requests receive no generated edit mandate', () => {
  for (const probe of READ_ONLY_PROBES) {
    it(`fresh engine — ${probe.label}`, async () => {
      const target = makeTarget();
      const captures: Capture[] = [];
      let engine: ChatEngine | undefined;

      await runChatEngineOnce({
        task: probe.task,
        target,
        preflightContext: '',
        useStreaming: true,
        engineFactory: (options) => {
          engine = makeEngine(probe.task, target.targetRoot, options);
          installCapturingRunner(engine, captures);
          return engine;
        },
      });

      assert.equal(captures.length, 1, 'expected exactly one provider request');
      assertNoEditMandate(captures[0]!, `fresh/${probe.label}`);
      assert.equal(
        enginePlan(engine!),
        undefined,
        `fresh/${probe.label}: no intent plan may be attached to the engine`,
      );
    });
  }

  it('reused engine — a stale attached plan is cleared for a read-only submission', async () => {
    const target = makeTarget();
    const captures: Capture[] = [];

    const engine = makeEngine('previous execute task', target.targetRoot, {
      intentPlanUserMessage:
        '> Harness-generated planning guidance (not user authorization).\n\n## Intent Plan\nSTALE',
    });
    installCapturingRunner(engine, captures);

    await runChatEngineOnce({
      task: 'can you investigate the example repo for the current TUI Code?',
      target,
      engine,
      preflightContext: '',
      useStreaming: true,
    });

    assert.equal(captures.length, 1);
    assertNoEditMandate(captures[0]!, 'reused/stale-plan');
    assert.equal(
      enginePlan(engine),
      undefined,
      'applyTurnPreparation must clear a stale plan for a read-only submission',
    );
  });

  it('reused engine — a READ_ONLY turn records no new generated mandate', async () => {
    const target = makeTarget();
    const first: Capture[] = [];
    const second: Capture[] = [];

    const engine = makeEngine('Investigate the terminal interface and fix the rendering problem.', target.targetRoot);
    const mandateRecords = (): number =>
      engine
        .getParityEventLog()
        .events.filter(
          (event) => event.kind === 'user_message' && event.content.includes('## Before You Start'),
        ).length;

    installCapturingRunner(engine, first);
    await runChatEngineOnce({
      task: 'Investigate the terminal interface and fix the rendering problem.',
      target,
      engine,
      preflightContext: '',
      useStreaming: true,
    });
    assert.ok(
      userContents(first[0]!).includes('## Before You Start'),
      'control: the execute turn must receive the repair guidance',
    );
    const afterExecute = mandateRecords();
    assert.equal(afterExecute, 1, 'control: the execute turn records exactly one guidance message');

    installCapturingRunner(engine, second);
    await runChatEngineOnce({
      task: 'hello',
      target,
      engine,
      preflightContext: '',
      useStreaming: true,
    });

    // M3: assert on the durable thread log (new records), not on a conversation
    // count that includes the prior turn's retained history.
    assert.equal(
      mandateRecords(),
      afterExecute,
      'the READ_ONLY turn must not record a new generated mandate',
    );
    const secondText = userContents(second[0]!);
    assert.ok(
      !secondText.includes('STALE'),
      'no stale per-turn plan may survive into the read-only turn',
    );
  });

  it('explicit "investigate and fix" still receives authorized execute guidance', async () => {
    const target = makeTarget();
    const captures: Capture[] = [];
    const task = 'Investigate the Babel terminal interface and fix the rendering problem.';
    let engine: ChatEngine | undefined;

    assert.notEqual(
      analyzeTaskShape(task).operation,
      'READ_ONLY',
      'control: investigate-and-fix must resolve to an execute-like operation',
    );

    await runChatEngineOnce({
      task,
      target,
      preflightContext: '',
      useStreaming: true,
      engineFactory: (options) => {
        engine = makeEngine(task, target.targetRoot, options);
        installCapturingRunner(engine, captures);
        return engine;
      },
    });

    const text = userContents(captures[0]!);
    assert.match(text, /## Intent Plan/);
    assert.match(text, /## Before You Start/);
    assert.match(text, /str_replace/);
    assert.ok(
      text.includes('Harness-generated planning guidance'),
      'harness guidance must identify itself as guidance, not user authorization',
    );
    assert.ok(enginePlan(engine!), 'execute task keeps the intent plan attached');
  });

  it('a mutation verb outside a fence still authorizes execute guidance', async () => {
    const target = makeTarget();
    const captures: Capture[] = [];
    const task =
      'implement this helper and run the tests:\n```ts\nfunction add(a: number, b: number) { return a + b }\n```';
    let engine: ChatEngine | undefined;

    assert.notEqual(
      analyzeTaskShape(task).operation,
      'READ_ONLY',
      'control: an imperative outside the fence keeps mutation authority',
    );

    await runChatEngineOnce({
      task,
      target,
      preflightContext: '',
      useStreaming: true,
      engineFactory: (options) => {
        engine = makeEngine(task, target.targetRoot, options);
        installCapturingRunner(engine, captures);
        return engine;
      },
    });

    const text = userContents(captures[0]!);
    assert.match(text, /## Intent Plan/);
    assert.match(text, /## Before You Start/);
    assert.match(text, /str_replace/);
  });

  it('streaming and callback preparation agree on operation and prompts', async () => {
    const task = 'can you investigate the example repo for the current TUI Code?';

    async function capturePath(useStreaming: boolean): Promise<Capture> {
      const target = makeTarget();
      const captures: Capture[] = [];
      await runChatEngineOnce({
        task,
        target,
        preflightContext: '',
        useStreaming,
        engineFactory: (options) => {
          const engine = makeEngine(task, target.targetRoot, options);
          installCapturingRunner(engine, captures);
          return engine;
        },
      });
      return captures[0]!;
    }

    const streaming = await capturePath(true);
    const callback = await capturePath(false);

    assert.equal(
      userContents(streaming),
      userContents(callback),
      'streaming and callback paths must send identical user content',
    );
    assertNoEditMandate(streaming, 'streaming/preparation');
    assertNoEditMandate(callback, 'callback/preparation');
  });
});
