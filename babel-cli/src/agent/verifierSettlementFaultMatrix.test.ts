/**
 * R0/W4 — verifier settlement fault matrix.
 *
 * Independent verification (not re-assertion of the prior read-only audit) that
 * each settlement fault still yields at most one terminal per tool-call id, at
 * most one authoritative terminal, no stale/current ambiguity, no verifier
 * authority from unavailable evidence, and no resurrected receipt after a cold
 * resume.
 *
 * Reachability legend (recorded in the final report):
 *   - Engine cases drive the real ChatEngine native loop over a stubbed provider.
 *   - Pure cases use the real evidence/adapter modules and a real temp workspace.
 *   - Faults with no existing seam are reported as gaps, not faked.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ChatEngine, type ChatEvent } from './chatEngine.js';
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import {
  createSessionEventLog,
  inspectSessionEventLogFromDir,
  interruptedToolRecoveries,
  markInterruptedToolsOnResume,
  recordToolProposed,
  recordToolStarted,
  recordVerifierAttempt,
  type SessionEvent,
} from './sessionEvents.js';
import {
  bindChatVerifierReceipt,
  refreshChatVerifierReceiptStalenessSync,
  revisionBindingProofErrors,
  toExecutorVerifierReceipt,
  type BoundChatVerifierReceipt,
} from '../evidence/chatRevisionBinding.js';
import {
  captureAndRecordVerifierReceipt,
  captureChatVerifierReceipt,
  prepareKernelVerifierInput,
  restorePersistedVerifierEvidence,
} from './chatEngineVerifierAdapter.js';
import {
  invalidateVerifierLedger,
  noteChatWorkspaceMutation,
} from './chatEngineSupport.js';

const MANAGED_ENV = [
  'BABEL_RUNS_DIR',
  'BABEL_BENCHMARK_AUTO_APPROVE',
  'BABEL_BENCHMARK_MODE',
  'BABEL_AUTONOMY_LEASE',
  'BABEL_EXECUTION_PROFILE',
  'BABEL_ALLOW_HOST_FALLBACK',
] as const;

const FIXTURE_POLICY: ResolvedModelPolicy = {
  policyPath: 'test-fixture',
  family: 'test-fixture',
  selectedTier: 'cheap',
  resolvedBackendKey: 'test-fixture',
  provider: 'opencode-go',
  providerModelId: 'mimo-v2.5',
  expensive: false,
  enabled: true,
  experimental: true,
  blockedWithoutExplicitOptIn: false,
  approximateInputTokens: 0,
  approximateOutputTokens: 0,
  warnings: [],
  waterfall: [],
  stagePolicies: [],
  contextWindow: 128_000,
  contextLimit: 128_000,
  maxOutputTokens: 4_096,
  nativeToolUse: true,
};

let snapshot: Record<string, string | undefined> = {};

before(() => {
  snapshot = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1';
  process.env['BABEL_BENCHMARK_MODE'] = '1';
  process.env['BABEL_AUTONOMY_LEASE'] = JSON.stringify({
    version: 2,
    leaseId: 'verifier-settlement-matrix-lease',
    scope: { repository: 'fixture', objective: 'qualify verifier settlement truth' },
    allowedCapabilities: [
      'inspect_repository',
      'search_repository',
      'run_arbitrary_code',
      'run_local_command',
      'run_tests',
      'edit_task_files',
    ],
  });
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local';
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
});

after(() => {
  for (const key of MANAGED_ENV) {
    const previous = snapshot[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-verifier-matrix-'));
  writeFileSync(join(root, 'a.txt'), 'alpha\n', 'utf8');
  writeFileSync(join(root, 'parser.ts'), 'export const x = 1;\n', 'utf8');
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node verify.mjs' } })}\n`,
    'utf8',
  );
  writeFileSync(join(root, 'verify.mjs'), 'process.exit(0);\n', 'utf8');
  return root;
}

interface ToolCallSpec {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type TurnSpec =
  | { kind: 'tools'; toolCalls: ToolCallSpec[]; text?: string }
  | { kind: 'text'; text: string }
  | { kind: 'http_error'; status: number };

function installTurns(turns: TurnSpec[]): () => void {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    const turn = turns[call++];
    if (!turn) {
      return new Response('no more turns', { status: 500 });
    }
    if (turn.kind === 'http_error') {
      return new Response('provider exploded', { status: turn.status });
    }
    const delta =
      turn.kind === 'text'
        ? { content: turn.text }
        : {
            ...(turn.text ? { content: turn.text } : {}),
            tool_calls: turn.toolCalls.map((tc, index) => ({
              index,
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          };
    return new Response(
      `data: ${JSON.stringify({
        model: 'mimo-v2.5',
        choices: [
          { delta, finish_reason: turn.kind === 'text' ? 'stop' : 'tool_calls' },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      })}\n\ndata: [DONE]\n\n`,
      { status: 200 },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function makeEngine(root: string, runId: string, task: string): ChatEngine {
  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'fixture-only',
  });
  return new ChatEngine({
    task,
    projectRoot: root,
    runId,
    model: 'mimo-v2.5',
    maxTurns: 8,
    providerRunner: runner,
    providerPolicy: FIXTURE_POLICY,
  });
}

function readSessionEvents(runId: string): SessionEvent[] {
  const loaded = inspectSessionEventLogFromDir(chatSessionDir(runId), runId);
  return loaded.kind === 'valid' ? loaded.log.events : [];
}

function terminalEvents(events: readonly ChatEvent[]) {
  return events.filter(
    (event) => event.type === 'tool_complete' || event.type === 'tool_failed',
  );
}

describe('verifier settlement fault matrix', { concurrency: false }, () => {
  test('receipt capture throws (authoritative verifier, empty mutation scope) degrades to exactly one terminal', async () => {
    const root = makeFixture();
    const runId = 'matrix-capture-throw';
    process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
    const restore = installTurns([
      { kind: 'tools', toolCalls: [{ id: 'call-verify', name: 'run_command', args: { command: 'npm test' } }] },
      { kind: 'text', text: 'Verifier ran.' },
    ]);
    try {
      // Precondition: capture really throws for an authoritative command with
      // no bound mutation scope.
      await assert.rejects(
        () =>
          captureChatVerifierReceipt({
            projectRoot: root,
            command: 'npm test',
            exitCode: 0,
            summary: 'ok',
            mutationPaths: [],
          }),
        /Revision-bound file scope must not be empty/,
      );

      const engine = makeEngine(root, runId, 'Run npm test and report the result.');
      const events: ChatEvent[] = [];
      for await (const event of engine.submitMessageStream('Run npm test and report the result.')) {
        events.push(event);
      }

      const terminals = terminalEvents(events).filter(
        (event) => (event as { toolCallId?: string }).toolCallId === 'call-verify',
      );
      assert.equal(terminals.length, 1, 'exactly one terminal for the verifier id');
      assert.equal(
        events.some((event) => event.type === 'failed' && /duplicate_tool_call_id/.test(JSON.stringify(event))),
        false,
        'capture throw must not corrupt the outbound tool protocol',
      );

      const sessionEvents = readSessionEvents(runId);
      const verifierAttempts = sessionEvents.filter((event) => event.kind === 'verifier_attempt');
      assert.equal(verifierAttempts.length, 0, 'no verifier_attempt recorded when capture threw');

      const conversation = (engine as unknown as { conversation: Array<{ content?: string }> }).conversation;
      assert.ok(
        conversation.some((message) => message.content?.includes('verifier_receipt_unavailable')),
        'degradation surfaces verifier_receipt_unavailable',
      );
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('receipt returns null (non-authoritative command) grants no verifier authority', async () => {
    const root = makeFixture();
    const runId = 'matrix-null-receipt';
    process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
    const restore = installTurns([
      { kind: 'tools', toolCalls: [{ id: 'call-plain', name: 'run_command', args: { command: 'node verify.mjs' } }] },
      { kind: 'text', text: 'Plain command ran.' },
    ]);
    try {
      // Precondition: a non-authoritative command yields a null receipt.
      const direct = await captureChatVerifierReceipt({
        projectRoot: root,
        command: 'node verify.mjs',
        exitCode: 0,
        summary: 'ok',
        mutationPaths: ['parser.ts'],
      });
      assert.equal(direct, null);

      const engine = makeEngine(root, runId, 'Run node verify.mjs and report.');
      const events: ChatEvent[] = [];
      for await (const event of engine.submitMessageStream('Run node verify.mjs and report.')) {
        events.push(event);
      }

      const terminals = terminalEvents(events).filter(
        (event) => (event as { toolCallId?: string }).toolCallId === 'call-plain',
      );
      assert.equal(terminals.length, 1, 'exactly one terminal for the plain command');

      const sessionEvents = readSessionEvents(runId);
      assert.equal(
        sessionEvents.filter((event) => event.kind === 'verifier_attempt' && (event as { authoritative?: boolean }).authoritative === true).length,
        0,
        'non-authoritative command records no authoritative verifier attempt',
      );
      assert.equal((engine as unknown as { lastVerifierReceipt: unknown }).lastVerifierReceipt, null);
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('receipt persistence rejects: adapter rejects and ledger entry is invalidated, not authoritative', async () => {
    const root = makeFixture();
    try {
      const base = createSessionEventLog('matrix-persist-reject');
      const throwingEvents = new Proxy(base.events, {
        get(target, prop, receiver) {
          if (prop === 'push') {
            return () => {
              throw new Error('session event persistence failed');
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      Object.defineProperty(base, 'events', { value: throwingEvents, configurable: true });

      const ledger: BoundChatVerifierReceipt[] = [];
      const cache = new Map<string, { receipt: BoundChatVerifierReceipt; writeCountAtCache: number }>();

      await assert.rejects(
        () =>
          captureAndRecordVerifierReceipt({
            projectRoot: root,
            command: 'npm test',
            exitCode: 0,
            summary: 'ok',
            mutationPaths: ['parser.ts'],
            sessionEvents: base,
            turnId: 't1',
            ledger,
            cache,
            writeCount: 1,
            toolCallId: 'call-verify',
          }),
        /session event persistence failed/,
      );

      // The adapter upserts the ledger before persistence; the engine's catch
      // invalidates it. Assert the entry cannot carry authority afterwards.
      assert.equal(ledger.length, 1, 'ledger upsert happened before the persistence reject');
      invalidateVerifierLedger(
        { lastVerifierReceipt: null, executedVerifierLedger: ledger },
        'verifier receipt persistence failed',
      );
      assert.equal(ledger[0]!.stale, true, 'rejected persistence leaves the receipt stale');
      assert.ok(revisionBindingProofErrors(ledger[0]).length > 0);

      const prepared = prepareKernelVerifierInput(null, ledger);
      assert.equal(prepared.lastVerifierReceipt, null);
      assert.equal(prepared.executedVerifierLedger?.[0]?.stale, true);
      assert.equal(cache.size, 0, 'no cache entry is minted on persistence reject');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('workspace mutation after a bound receipt makes it stale and denies authority', async () => {
    const root = makeFixture();
    try {
      const receipt = await bindChatVerifierReceipt({
        projectRoot: root,
        command: 'npm test',
        exit_code: 0,
        summary: 'green',
        mutationPaths: ['parser.ts'],
        structured: {
          verifierId: 'npm:test',
          authoritySource: 'built_in_runner',
          executable: 'npm',
          args: ['test'],
        },
      });
      assert.equal(refreshChatVerifierReceiptStalenessSync(root, receipt)?.stale, false);

      // A later confirmed mutation advances the workspace revision.
      const engineLike = {
        writeCount: 0,
        consecutiveReadOnlyTools: 0,
        lastVerifierReceipt: receipt as BoundChatVerifierReceipt | null,
        executedVerifierLedger: [receipt],
      };
      noteChatWorkspaceMutation(engineLike);
      writeFileSync(join(root, 'parser.ts'), 'export const x = 2;\n', 'utf8');

      const refreshed = refreshChatVerifierReceiptStalenessSync(root, engineLike.lastVerifierReceipt);
      assert.equal(refreshed?.stale, true);
      assert.ok(revisionBindingProofErrors(refreshed).some((error) => /stale/.test(error)));
      assert.equal(refreshed ? toExecutorVerifierReceipt(refreshed).ok : true, true, 'still structurally valid, but stale');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cold resume rehydrates a bound receipt but staleness refresh prevents resurrection', async () => {
    const root = makeFixture();
    try {
      const receipt = await bindChatVerifierReceipt({
        projectRoot: root,
        command: 'npm test',
        exit_code: 0,
        summary: 'green',
        mutationPaths: ['parser.ts'],
        structured: {
          verifierId: 'npm:test',
          authoritySource: 'built_in_runner',
          executable: 'npm',
          args: ['test'],
        },
      });

      // Durable evidence written while green.
      const log = createSessionEventLog('matrix-cold-resume');
      recordVerifierAttempt(log, {
        turn_id: 't1',
        command_preview: 'npm test',
        authoritative: true,
        exit_code: 0,
        tool_call_id: 'call-verify',
        receipt,
      });

      // Workspace moves after the receipt was persisted.
      writeFileSync(join(root, 'parser.ts'), 'export const x = 99;\n', 'utf8');

      // Cold resume: fresh in-memory ledger rehydrated purely from disk events.
      const resumedLedger: BoundChatVerifierReceipt[] = [];
      const resumed = restorePersistedVerifierEvidence(log, resumedLedger);
      assert.ok(resumed, 'durable verifier_attempt is rehydrated');
      assert.equal(resumedLedger.length, 1);

      // The resurrection is contained by the pre-decision staleness refresh.
      const refreshed = refreshChatVerifierReceiptStalenessSync(root, resumed);
      assert.equal(refreshed?.stale, true, 'rehydrated receipt is stale against the moved workspace');
      assert.ok(revisionBindingProofErrors(refreshed).some((error) => /stale/.test(error)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('provider failure on the request after settlement keeps exactly one terminal per id', async () => {
    const root = makeFixture();
    const runId = 'matrix-provider-failure';
    process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
    const restore = installTurns([
      {
        kind: 'tools',
        toolCalls: [
          { id: 'call-a', name: 'read_file', args: { path: 'a.txt' } },
          { id: 'call-b', name: 'read_file', args: { path: 'parser.ts' } },
        ],
      },
      { kind: 'http_error', status: 500 },
      { kind: 'http_error', status: 500 },
      { kind: 'http_error', status: 500 },
      { kind: 'http_error', status: 500 },
      { kind: 'http_error', status: 500 },
    ]);
    try {
      const engine = makeEngine(root, runId, 'Read a.txt and parser.ts then summarize.');
      const events: ChatEvent[] = [];
      for await (const event of engine.submitMessageStream('Read a.txt and parser.ts then summarize.')) {
        events.push(event);
      }

      const sessionEvents = readSessionEvents(runId);
      for (const id of ['call-a', 'call-b']) {
        const terminals = sessionEvents.filter(
          (event) =>
            (event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled') &&
            event.tool_call_id === id,
        );
        assert.equal(terminals.length, 1, `exactly one durable terminal for ${id}`);
      }
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('late/interrupted tool completion on cold resume settles exactly one terminal and is idempotent', () => {
    const log = createSessionEventLog('matrix-late-completion');
    recordToolProposed(log, {
      turn_id: 't1',
      tool_call_id: 'call-late',
      tool_name: 'run_command',
      idempotency_key: 'call-late',
      effect_class: 'external_side_effect',
    });
    recordToolStarted(log, {
      turn_id: 't1',
      tool_call_id: 'call-late',
      tool_name: 'run_command',
      idempotency_key: 'call-late',
      effect_class: 'external_side_effect',
    });

    const first = markInterruptedToolsOnResume(log, 'interrupted_mid_tool');
    assert.equal(first.length, 1, 'the interrupted started tool is settled once');
    assert.equal(first[0]!.kind, 'tool_cancelled');
    assert.equal(
      (first[0] as { recovery_state?: string }).recovery_state,
      'TOOL_OUTCOME_UNKNOWN',
    );
    const terminals = log.events.filter(
      (event) =>
        (event as { tool_call_id?: string }).tool_call_id === 'call-late' &&
        (event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled'),
    );
    assert.equal(terminals.length, 1, 'exactly one terminal after resume');

    const second = markInterruptedToolsOnResume(log);
    assert.equal(second.length, 0, 'resume settlement is idempotent');
    assert.equal(interruptedToolRecoveries(log).length, 0, 'no open interrupted operations remain');
  });

  test('callback throws after tool logging: executeActions rejects and pushes a duplicate row (private seam)', async () => {
    const root = makeFixture();
    const runId = 'matrix-callback-throw';
    process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
    try {
      const engine = makeEngine(root, runId, 'read a.txt');
      const executeActions = (
        engine as unknown as {
          executeActions: (
            actions: Array<Record<string, unknown>>,
            callbacks: Record<string, unknown>,
          ) => Promise<unknown>;
        }
      ).executeActions.bind(engine);

      await assert.rejects(
        () =>
          executeActions([{ type: 'read_file', path: 'a.txt' }], {
            onToolStart: () => 1,
            onToolComplete: () => {
              throw new Error('host callback exploded');
            },
          }),
        /host callback exploded/,
      );

      const log = (engine as unknown as { toolCallLog: Array<{ index: number; tool: string }> }).toolCallLog;
      const rowsForAction = log.filter((row) => row.index === 0 && row.tool === 'read_file');
      assert.equal(
        rowsForAction.length,
        2,
        'a throwing host callback duplicates the row for one action (latent exactly-one-row violation)',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
