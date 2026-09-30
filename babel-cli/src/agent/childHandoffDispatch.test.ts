/**
 * S02/#212 + S03/#213 production-path evidence (review I2).
 *
 * Drives the real `ChatEngine.executeOneAction` sub_agent dispatch with a
 * deterministic offline read-only child, then asserts the bounded child result
 * reaches the parent tool message on BOTH delivery modes (native observations
 * and the text-tools renderer), and that the resolved effective spec is
 * reflected in the same observation.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine, formatTextToolResults } from './chatEngine.js';
import type { ChatToolAction } from './chatToolDefinitions.js';
import { buildMutationAgentTurnPrompt } from './lanes/runMutationAgentLoop.js';
import { buildReadOnlyAgentTurnPrompt } from './lanes/readOnlyAgentLoop.js';

const roots: string[] = [];
const previousOffline = process.env['BABEL_LITE_OFFLINE'];

before(() => {
  process.env['BABEL_LITE_OFFLINE'] = '1';
});

after(() => {
  if (previousOffline === undefined) delete process.env['BABEL_LITE_OFFLINE'];
  else process.env['BABEL_LITE_OFFLINE'] = previousOffline;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type SubAgentToolLogEntry = {
  tool: string;
  target: string;
  detail?: string;
  stdout?: string;
  exit_code?: number;
};

async function dispatchSubAgent(
  task: string,
  action: Partial<ChatToolAction> = {},
): Promise<{ engine: ChatEngine; observation: string; entry: SubAgentToolLogEntry }> {
  const root = mkdtempSync(join(tmpdir(), 'babel-child-dispatch-'));
  roots.push(root);
  const engine = new ChatEngine({ task, projectRoot: root, model: 'deepseek-v4-flash' });
  const internals = engine as unknown as {
    executeOneAction: (
      action: ChatToolAction,
      toolContext: unknown,
      callbacks: unknown,
      meta: unknown,
    ) => Promise<{ index: number; observation: string; stop?: boolean }>;
    abortController: AbortController;
    toolCallLog: SubAgentToolLogEntry[];
  };
  const result = await internals.executeOneAction(
    { type: 'sub_agent', task, mutation: false, ...action } as ChatToolAction,
    {
      agentId: 'test-parent',
      runId: 'test-parent',
      runDir: root,
      babelRoot: root,
      projectRoot: root,
      signal: internals.abortController.signal,
    },
    {},
    { index: 0, idempotencyKey: 'call-0' },
  );
  const entry = [...internals.toolCallLog].reverse().find((row) => row.tool === 'sub_agent');
  assert.ok(entry, 'sub_agent tool log entry must exist');
  return { engine, observation: result.observation, entry: entry! };
}

describe('S02/#212 production dispatch — child conclusion reaches the parent tool message', () => {
  test('native/role:tool observation carries the conclusion, state and provenance', async () => {
    const { observation } = await dispatchSubAgent('Summarize the module');
    assert.match(observation, /Read-only discovery complete/, 'child finish summary reaches parent');
    assert.match(observation, /Child conclusion \(child-reported; NOT verified\)/);
    assert.match(observation, /authority: child_assertion_not_verified/);
    assert.match(observation, /completion: completed/);
    assert.doesNotMatch(observation, /confirmed_change/);
  });

  test('text-tools renderer carries the conclusion, state and provenance exactly once', async () => {
    const { entry } = await dispatchSubAgent('Summarize the module');
    assert.ok(entry.stdout, 'sub_agent row must carry the bounded child section for the text path');
    const text = formatTextToolResults([entry]);
    assert.equal(text.split('Read-only discovery complete').length - 1, 1);
    assert.match(text, /\[RESULT\] sub_agent:/);
    assert.match(text, /authority: child_assertion_not_verified/);
    assert.match(text, /completion: completed/);
  });

  test('a long child conclusion keeps the authority/evidence tail on the text path', async () => {
    // Simulate the worst case the renderer must survive: a conclusion at the
    // childConclusion bound plus evidence refs and the provenance tail.
    const { renderReadOnlyChildResultSection, buildReadOnlyChildResult } = await import(
      './childConclusion.js'
    );
    const long = 'x'.repeat(2100);
    const section = renderReadOnlyChildResultSection(
      buildReadOnlyChildResult({
        steps: [
          { phase: 'observe', action: { type: 'read_file' } },
          { phase: 'finish', action: { type: 'finish', summary: long } },
        ],
        toolCallLog: Array.from({ length: 12 }, (_, i) => ({
          tool: 'read_file',
          target: `src/f${i}.ts`,
          exit_code: 0,
          verified: true,
        })),
        observations: long,
        stepsExecuted: 12,
        degraded: false,
        completed: true,
        roundExhausted: false,
        policyBlocked: false,
        roundsExecuted: 1,
        lane: 'ask',
        childId: 'chat-sub-long',
        maxRounds: 4,
        cancelled: false,
      }),
    );
    const text = formatTextToolResults([
      { tool: 'sub_agent', target: 'long task', detail: 'x', exit_code: 0, stdout: section },
    ]);
    assert.match(text, /authority: child_assertion_not_verified/, 'authority must survive');
    assert.match(text, /Child evidence references/, 'evidence section must survive');
    assert.match(text, /\[child conclusion truncated/);
  });
});

describe('S03/#213 production dispatch — resolved spec reaches the child', () => {
  test('read-only dispatch resolves and reports requested vs effective options', async () => {
    const { observation } = await dispatchSubAgent('Research the codebase', {
      max_rounds: 7,
      instructions: 'INSTRUCTION_SENTINEL_S03',
      model: 'scout',
    } as Partial<ChatToolAction>);
    assert.match(observation, /child_spec: .*rounds=7\(honored\)/);
    assert.match(observation, /model=scout\(override\)/);
    assert.match(observation, /instructions=forwarded/);
  });

  test('read-only dispatch clamps an over-limit max_rounds with a visible reason', async () => {
    const { observation } = await dispatchSubAgent('Research the codebase', {
      max_rounds: 99,
    } as Partial<ChatToolAction>);
    assert.match(observation, /rounds=20\(clamped:above_ceiling_20\)/);
  });

  test('instructions sentinel reaches both child prompt builders', () => {
    const sentinel = 'INSTRUCTION_SENTINEL_PROMPT';
    const readPrompt = buildReadOnlyAgentTurnPrompt({
      verb: 'ask',
      task: 't',
      projectRoot: '/p',
      round: 1,
      maxRounds: 4,
      priorObservations: '',
      allowedTools: ['file_read'],
      additionalInstructions: sentinel,
    });
    assert.match(readPrompt, /# Additional Instructions/);
    assert.ok(readPrompt.includes(sentinel));

    const mutationPrompt = buildMutationAgentTurnPrompt({
      task: 't',
      projectRoot: '/p',
      round: 1,
      maxRounds: 8,
      priorObservations: '',
      writeScope: ['src'],
      additionalInstructions: sentinel,
    });
    assert.match(mutationPrompt, /# Additional Instructions/);
    assert.ok(mutationPrompt.includes(sentinel));
  });
});
