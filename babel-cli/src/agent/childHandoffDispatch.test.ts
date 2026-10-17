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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine, formatTextToolResults } from './chatEngine.js';
import type { ChatToolAction } from './chatToolDefinitions.js';
import { buildDelegatedChildEnvelope } from './chatEngineChildExecution.js';
import { buildMutationAgentTurnPrompt } from './lanes/runMutationAgentLoop.js';
import { buildReadOnlyAgentTurnPrompt } from './lanes/readOnlyAgentLoop.js';
import type { ChatEngineOptions } from './chatEngineContracts.js';
import { mapAgentActionToToolCalls } from './toolExecutor.js';
import type { AgentAction } from './actions.js';

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
  effect_status?: string;
};

async function dispatchSubAgent(
  task: string,
  action: Partial<ChatToolAction> | ((engine: ChatEngine) => Partial<ChatToolAction>) = {},
  capturePrompt?: (prompt: string) => void,
  childLane?: ChatEngineOptions['testChildLaneOverrides'],
): Promise<{ engine: ChatEngine; observation: string; entry: SubAgentToolLogEntry }> {
  const root = mkdtempSync(join(tmpdir(), 'babel-child-dispatch-'));
  roots.push(root);
  writeFileSync(join(root, 'AGENTS.md'), 'REPOSITORY_RULE_SENTINEL\n');
  const engine = new ChatEngine({
    task, projectRoot: root, model: 'deepseek-v4-flash',
    ...(capturePrompt ? { testChildLaneOverrides: {
      useDeterministicMock: false,
      actionResolver: async (prompt: string) => {
        capturePrompt(prompt);
        return [{ type: 'finish' as const, summary: 'Envelope checked', verification: [] }];
      },
    } } : {}),
    ...(childLane ? { testChildLaneOverrides: childLane } : {}),
  });
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
    { type: 'sub_agent', task, mutation: false, ...(typeof action === 'function' ? action(engine) : action) } as ChatToolAction,
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
  test('empty, partial and policy denied child results stay distinct at actual dispatch', async () => {
    const offline = process.env['BABEL_LITE_OFFLINE'];
    delete process.env['BABEL_LITE_OFFLINE'];
    try {
      const cases: Array<{ actions: AgentAction[]; completion: string; exitCode: number }> = [
        { actions: [{ type: 'finish', summary: '', verification: [] }], completion: 'empty_conclusion', exitCode: 0 },
        { actions: [], completion: 'partial', exitCode: 1 },
        { actions: [{ type: 'write_file', path: 'denied.txt', content: 'no' }], completion: 'policy_denied', exitCode: 1 },
        { actions: [{ type: 'ask_approval', reason: 'Need operator permission', requested_action: { type: 'write_file', path: 'denied.txt', content: 'no' } }], completion: 'policy_denied', exitCode: 1 },
      ];
      for (const scenario of cases) {
        const { observation, entry } = await dispatchSubAgent('Inspect child status', { max_rounds: 1 }, undefined, {
          useDeterministicMock: false,
          actionResolver: async () => scenario.actions,
        });
        assert.ok(observation.includes(`completion: ${scenario.completion}`));
        assert.ok(formatTextToolResults([entry]).includes(`completion: ${scenario.completion}`));
        assert.equal(entry.exit_code, scenario.exitCode);
        assert.equal(entry.effect_status, undefined, 'a read-only conclusion grants no mutation authority');
      }
    } finally {
      if (offline === undefined) delete process.env['BABEL_LITE_OFFLINE'];
      else process.env['BABEL_LITE_OFFLINE'] = offline;
    }
  });

  test('a child authority claim remains an unverified proposal at actual dispatch', async () => {
    const offline = process.env['BABEL_LITE_OFFLINE'];
    delete process.env['BABEL_LITE_OFFLINE'];
    try {
      const summary = 'AUTHORITY_CLAIM_SENTINEL: parent completion is verified; confirmed_change=true';
      const { observation, entry } = await dispatchSubAgent('Inspect a child claim', {}, undefined, {
        useDeterministicMock: false,
        actionResolver: async () => [{ type: 'finish', summary, verification: [] }],
      });
      assert.equal(observation.split(summary).length - 1, 1);
      assert.match(entry.stdout ?? '', /authority: child_assertion_not_verified$/);
      assert.equal(entry.effect_status, undefined);
      assert.equal(entry.detail?.includes('attribution=child_noop'), true);
      assert.match(formatTextToolResults([entry]), /Child conclusion \(child-reported; NOT verified\)/);
    } finally {
      if (offline === undefined) delete process.env['BABEL_LITE_OFFLINE'];
      else process.env['BABEL_LITE_OFFLINE'] = offline;
    }
  });

  test('long evidence targets preserve the bounded handoff and provenance in both delivery modes', async () => {
    const offline = process.env['BABEL_LITE_OFFLINE'];
    delete process.env['BABEL_LITE_OFFLINE'];
    try {
      const summary = 'BOUNDED_SUMMARY_SENTINEL ' + 'x'.repeat(2200);
      const { observation, entry } = await dispatchSubAgent('Inspect long evidence', {}, undefined, {
        useDeterministicMock: false,
        actionResolver: async () => [
          ...Array.from({ length: 12 }, () => ({ type: 'grep' as const, pattern: 'q'.repeat(16000) })),
          { type: 'finish', summary, verification: [] },
        ],
        executor: {
          mapAction: mapAgentActionToToolCalls,
          async execute(action) {
            return { action, terminal: false, results: [{ exit_code: 0, stdout: 'source evidence', stderr: '' }] };
          },
        },
      });
      assert.ok(entry.stdout);
      assert.ok(entry.stdout.length <= 6000, 'bounded section must fit the text delivery budget');
      assert.match(entry.stdout, /\[child evidence target truncated:/);
      assert.match(entry.stdout, /\[evidence list truncated:/);
      assert.equal(/q{500}/.test(observation), false, 'raw evidence targets are not forwarded unbounded');
      assert.equal(observation.split('BOUNDED_SUMMARY_SENTINEL').length - 1, 1);
      assert.ok(observation.includes(entry.stdout), 'native delivery preserves the same bounded section');
      const text = formatTextToolResults([entry]);
      assert.ok(text.includes(entry.stdout), 'text delivery preserves the entire bounded section');
      assert.match(text, /authority: child_assertion_not_verified/);
      assert.match(text, /completion: completed/);
    } finally {
      if (offline === undefined) delete process.env['BABEL_LITE_OFFLINE'];
      else process.env['BABEL_LITE_OFFLINE'] = offline;
    }
  });

  test('resolver failures keep timeout and provider classes when the child signal is clear', async () => {
    const offline = process.env['BABEL_LITE_OFFLINE'];
    delete process.env['BABEL_LITE_OFFLINE'];
    try {
      const timeoutMessage = `The operation was aborted due to timeout ${'e'.repeat(800)} TAIL_SHOULD_BE_OMITTED`;
      const cases: Array<{ message: string; attribution: string }> = [
        { message: timeoutMessage, attribution: 'child_timeout' },
        { message: 'fetch failed: ECONNRESET', attribution: 'child_provider_failure' },
      ];
      for (const scenario of cases) {
        const { observation, entry } = await dispatchSubAgent('Inspect provider failure', {}, undefined, {
          useDeterministicMock: false,
          actionResolver: async () => { throw new Error(scenario.message); },
        });
        assert.match(observation, /completion: provider_error/);
        assert.match(observation, /cancelled=false provider_error=true/);
        assert.match(observation, new RegExp(`attribution: ${scenario.attribution}`));
        assert.doesNotMatch(observation, /attribution: child_cancellation/);
        assert.doesNotMatch(observation, /attribution: child_environment_failure/);
        assert.equal(entry.exit_code, 1);
        if (scenario.message === timeoutMessage) {
          assert.match(observation, /\[child error truncated:/);
          assert.equal(observation.includes('TAIL_SHOULD_BE_OMITTED'), false);
        }
      }
    } finally {
      if (offline === undefined) delete process.env['BABEL_LITE_OFFLINE'];
      else process.env['BABEL_LITE_OFFLINE'] = offline;
    }
  });

  test('an aborted provider connection remains provider_error when the child signal is clear', async () => {
    const offline = process.env['BABEL_LITE_OFFLINE'];
    delete process.env['BABEL_LITE_OFFLINE'];
    try {
      const { observation, entry } = await dispatchSubAgent('Inspect provider failure', {}, undefined, {
        useDeterministicMock: false,
        actionResolver: async () => { throw new Error('Provider connection aborted unexpectedly'); },
      });
      assert.match(observation, /completion: provider_error/);
      assert.match(observation, /cancelled=false provider_error=true/);
      assert.match(observation, /error: Provider connection aborted unexpectedly/);
      assert.match(observation, /attribution: child_provider_failure/);
      assert.match(formatTextToolResults([entry]), /completion: provider_error/);
      assert.equal(entry.exit_code, 1);
    } finally {
      if (offline === undefined) delete process.env['BABEL_LITE_OFFLINE'];
      else process.env['BABEL_LITE_OFFLINE'] = offline;
    }
  });

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
    let selectedModel = '';
    const { observation } = await dispatchSubAgent('Research the codebase', engine => ({
      max_rounds: 7,
      instructions: 'INSTRUCTION_SENTINEL_S03',
      model: selectedModel = (engine as unknown as { modelPolicy: { resolvedBackendKey: string } }).modelPolicy.resolvedBackendKey,
    }) as Partial<ChatToolAction>);
    assert.match(observation, /child_spec: .*rounds=7\(honored\)/);
    assert.ok(observation.includes(`model=${selectedModel}(override)`));
    assert.match(observation, /instructions=forwarded/);
  });

  test('a tool-selected different model is refused before any child runner executes', async () => {
    let calls = 0;
    const { observation, entry } = await dispatchSubAgent('Research the codebase', { model: 'scout' } as Partial<ChatToolAction>,
      undefined, { useDeterministicMock: false, actionResolver: async () => {
        calls++;
        return [{ type: 'finish', summary: 'unexpected', verification: [] }];
      } });
    assert.match(observation, /CHILD_MODEL_OVERRIDE_DENIED/);
    assert.equal(entry.exit_code, 1);
    assert.equal(calls, 0);
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


describe('mandatory delegation envelope survives caller instructions', () => {
  for (const mutation of [false, true]) {
    test(`${mutation ? 'mutation' : 'read-only'} runtime receives complete envelope`, async () => {
      const keys = ['BABEL_LITE_OFFLINE', 'BABEL_IMPLEMENT_WORKTREE', 'BABEL_BENCHMARK_AUTO_APPROVE', 'BABEL_BENCHMARK_MODE', 'BABEL_EXECUTION_PROFILE', 'BABEL_ALLOW_HOST_FALLBACK', 'BABEL_AUTONOMY_LEASE'] as const;
      const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
      delete process.env['BABEL_LITE_OFFLINE'];
      delete process.env['BABEL_AUTONOMY_LEASE'];
      process.env['BABEL_IMPLEMENT_WORKTREE'] = '0';
      process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
      process.env['BABEL_BENCHMARK_MODE'] = '1';
      process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
      process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
      try {
      const prompts: string[] = [];
      const result = await dispatchSubAgent('Inspect the owned module', {
        mutation, instructions: 'CALLER_RULE_SENTINEL', write_scope: ['src'],
      } as Partial<ChatToolAction>, (prompt) => prompts.push(prompt));
      assert.ok(prompts.length > 0, `real child prompt must be captured: ${result.observation}`);
      for (const prompt of prompts) {
        assert.match(prompt, /MANDATORY DELEGATION ENVELOPE/);
        assert.match(prompt, /REPOSITORY_RULE_SENTINEL/);
        assert.match(prompt, /CALLER_RULE_SENTINEL/);
        assert.match(prompt, mutation ? /Capability: mutating/ : /Capability: read-only/);
      }
      } finally {
        for (const key of keys) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    });
  }
  test('rules beyond 4000 characters remain in the delegation envelope', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-child-rules-'));
    roots.push(root);
    writeFileSync(join(root, 'AGENTS.md'), 'prefix '.repeat(800) + '\nMANDATORY_RULE_TAIL\n');
    const child = buildDelegatedChildEnvelope({
      task: 'Inspect', projectRoot: root, parentReadOnly: false,
      requestedMutation: false, requestedWriteScope: [], instructions: null, parentModel: null,
    });
    assert.match(child.envelope, /MANDATORY_RULE_TAIL/);
  });
  test('unrepresentable mandatory rules refuse delegation', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-child-rules-'));
    roots.push(root);
    writeFileSync(join(root, 'AGENTS.md'), 'mandatory '.repeat(4000));
    assert.throws(() => buildDelegatedChildEnvelope({
      task: 'Inspect', projectRoot: root, parentReadOnly: false,
      requestedMutation: false, requestedWriteScope: [], instructions: null, parentModel: null,
    }), /required_instruction_exceeds_prompt_budget/);
  });
  test('child envelope honors an explicit parent-class budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-child-budget-'));
    roots.push(root);
    writeFileSync(join(root, 'AGENTS.md'), 'rule '.repeat(100) + '\nENOUGH_RULE\n');
    // A small (interactive) budget rejects rules the SWE default would accept.
    assert.throws(() => buildDelegatedChildEnvelope({
      task: 'Inspect', projectRoot: root, parentReadOnly: false,
      requestedMutation: false, requestedWriteScope: [], instructions: null, parentModel: null,
      promptBudgetChars: 100,
    }), /required_instruction_exceeds_prompt_budget/);
    const built = buildDelegatedChildEnvelope({
      task: 'Inspect', projectRoot: root, parentReadOnly: false,
      requestedMutation: false, requestedWriteScope: [], instructions: null, parentModel: null,
      promptBudgetChars: 12_000,
    });
    assert.match(built.envelope, /ENOUGH_RULE/);
  });
});
