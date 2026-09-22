/**
 * P11 durable-owner wiring conformance (Task 2 — R1/P11 closure).
 *
 * Exercises the REAL P05 store and the REAL ChatEngine (no line-faithful
 * mirrors) against the required end state:
 *  - fresh production path: authorized command → admitCommand → durable owner
 *    row → engine receives the store → currentP11Owner resolves THAT owner →
 *    checkpoint installation proceeds;
 *  - resume path: reopen the existing store → recover the owner of record →
 *    hydrate applies; install/validation honor the durable owner;
 *  - lifetime: cancellation settles the claim as aborted; task replacement
 *    advances the owner generation; install authority is bounded to a live
 *    admitted command (a settled owner row alone never installs);
 *  - fencing negatives: missing owner, stale owner, cross-thread owner,
 *    cross-session owner, wrong owner token → checkpoint non-authoritative.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ChatEngine } from './chatEngine.js';
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';
import { chatSessionDir, openSessionAdmissionStore } from '../cli/runsLayout.js';
import { LIVE_SESSION_SNAPSHOT_FILENAME } from './liveSessionBridge.js';
import { getOpenAdmissionStoreCount } from '../runtime/admissionTestHooks.js';
import {
  prepareContextCheckpoint,
  type ContextCheckpointOwnerV1,
  type LiveOperationalSourcesV1,
} from '../runtime/contextCheckpoints.js';
import type { AdmissionStore } from '../runtime/admission.js';
import type { OwnerRecordV1 } from '../runtime/admissionContracts.js';

/** Static model for engines that never submit (policy must resolve offline). */
const STATIC_MODEL = 'deepseek-v4-flash';

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

const ROUTE = {
  compiled_request_identity: 'request-identity-fixture',
  tool_profile: 'native-tools',
  model_route: STATIC_MODEL,
} as const;

interface EngineAdmissionInternals {
  admitCurrentSubmission(submissionGeneration: number, userInput: string): void;
  settleActiveAdmissionClaim(): void;
  currentP11Owner(): ContextCheckpointOwnerV1 | null;
  installP11ContextCheckpoint(route?: unknown): Promise<boolean>;
}

function internals(engine: ChatEngine): EngineAdmissionInternals {
  return engine as unknown as EngineAdmissionInternals;
}

function requireStore(sessionId: string): AdmissionStore {
  const opened = openSessionAdmissionStore(sessionId);
  assert.equal(opened.ok, true, opened.ok ? '' : `${opened.reasonCode}: ${opened.detail}`);
  if (!opened.ok) throw new Error('store unavailable');
  return opened.store;
}

async function withRunsDir(fn: (runsRoot: string) => Promise<void>): Promise<void> {
  const previous = process.env['BABEL_RUNS_DIR'];
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-p11-wiring-'));
  process.env['BABEL_RUNS_DIR'] = runsRoot;
  try {
    await fn(runsRoot);
  } finally {
    if (previous === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = previous;
    rmSync(runsRoot, { recursive: true, force: true });
  }
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-p11-wiring-proj-'));
  writeFileSync(join(root, 'README.md'), 'fixture repository\n', 'utf8');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  return root;
}

function sources(): LiveOperationalSourcesV1 {
  return {
    resumed: false,
    task_contract: {
      goal: 'prove the durable owner gates checkpoint authority',
      acceptance_clause_ids: ['clause-1'],
      contract_hash: 'contract-hash-1',
    },
    working_state: {
      current_hypothesis: 'a checkpoint is inert until its owner is proven',
      unresolved_failures: [],
      next_experiment: 'install against the admitted owner',
    },
    workspace: {
      current_snapshot_revision: 'snapshot-current',
      capture_complete: true,
      coverage_ref: 'coverage-1',
      capture_provenance: 'current_capture',
      capture_epoch: 'capture-epoch-1',
    },
    receipts: [
      { receipt_id: 'receipt-1', identity: 'test', scope: 'unit', stale: false, bound_revision: 'rev-1' },
    ],
    budget: { owner: 'budget-owner', remaining_allowance: 1000, cancellation_owner: 'budget-owner' },
    pending: [],
    route: {
      compiled_request_identity: 'request-identity-fixture',
      tool_profile: 'chat-tools-v1',
      model_route: STATIC_MODEL,
    },
    observations: [],
    observation_manifest: [],
    authorized_observation_ids: [],
    legacy_observation_refs: [],
  };
}

/** Durable fixture: a prepared checkpoint + empty observation membership in a session dir. */
function writeCheckpointFixture(sessionId: string, owner: ContextCheckpointOwnerV1): void {
  const dir = chatSessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const prepared = prepareContextCheckpoint({
    checkpointId: `cp-${sessionId}`,
    owner,
    sources: sources(),
    turnId: 'turn-1',
    contextEpoch: '1:revision-1:capture-epoch-1',
  });
  assert.equal(
    prepared.status,
    'prepared',
    prepared.status === 'blocked' ? prepared.reasons.join(', ') : '',
  );
  if (prepared.status !== 'prepared') return;
  writeFileSync(join(dir, 'context-checkpoint.json'), JSON.stringify(prepared.checkpoint, null, 2), 'utf8');
  writeFileSync(
    join(dir, LIVE_SESSION_SNAPSHOT_FILENAME),
    JSON.stringify({ schema_version: 1, session_id: sessionId, authorized_observation_ids: [] }),
    'utf8',
  );
}

interface ProviderMode {
  providerCalls: number;
  abort: boolean;
}

function stubProvider(mode: ProviderMode): void {
  globalThis.fetch = (async () => {
    if (mode.abort) {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    mode.providerCalls += 1;
    return new Response(
      `data: ${JSON.stringify({
        model: 'mimo-v2.5',
        choices: [{ delta: { content: 'fixture answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\ndata: [DONE]\n\n`,
      { status: 200 },
    );
  }) as typeof fetch;
}

function staticEngine(runId: string, projectRoot: string, store: AdmissionStore): ChatEngine {
  return new ChatEngine({
    task: 'Prove the durable owner wiring',
    projectRoot,
    runId,
    admissionStore: store,
    model: STATIC_MODEL,
  });
}

function submittingEngine(runId: string, projectRoot: string, store: AdmissionStore): ChatEngine {
  const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, {
    credentialSource: 'explicit-test',
    explicitCredential: 'fixture-only',
  });
  return new ChatEngine({
    task: 'Prove the durable owner wiring',
    projectRoot,
    runId,
    admissionStore: store,
    model: 'mimo-v2.5',
    maxTurns: 4,
    providerRunner: runner,
    providerPolicy: FIXTURE_POLICY,
  });
}

test('fresh production path: admit → durable owner → currentP11Owner resolves it → install proceeds', async () => {
  await withRunsDir(async () => {
    const runId = 'p11-fresh-admission';
    const projectRoot = makeProjectRoot();
    const store = requireStore(runId);
    let engine: ChatEngine | undefined;
    try {
      engine = staticEngine(runId, projectRoot, store);
      const engineInternals = internals(engine);

      // Before any admission: no owner can be proven, so no install authority.
      assert.equal(engineInternals.currentP11Owner(), null);
      assert.equal(await engineInternals.installP11ContextCheckpoint(ROUTE), false);

      // The authorized command is admitted through the real production seam.
      engineInternals.admitCurrentSubmission(1, 'authorized fixture command');
      const owner = store.readOwner(runId);
      assert.ok(owner, 'admitCommand must have created the durable owner row');
      assert.equal(owner.generation, 1);
      assert.ok(owner.token.length > 0, 'the owner token is a lease nonce, never empty');

      // currentP11Owner resolves THAT durable owner (live admitted claim).
      assert.deepEqual(engineInternals.currentP11Owner(), {
        threadId: runId,
        generation: owner.generation,
        token: owner.token,
      });

      // Checkpoint installation proceeds and commits durably.
      const installed = await engineInternals.installP11ContextCheckpoint(ROUTE);
      assert.equal(installed, true, 'install must proceed under the admitted owner');
      const checkpointPath = join(chatSessionDir(runId), 'context-checkpoint.json');
      assert.ok(existsSync(checkpointPath), 'checkpoint must be committed to the session dir');
      const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
        owner: ContextCheckpointOwnerV1;
      };
      assert.equal(checkpoint.owner.generation, owner.generation, 'checkpoint records the admitted owner');
      assert.equal(checkpoint.owner.token, owner.token);

      // Command settlement records the terminal outcome durably...
      engineInternals.settleActiveAdmissionClaim();
      const records = store.listAdmissions(runId).records;
      assert.equal(records.length, 1);
      assert.equal(records[0]?.state, 'settled');
      assert.equal(
        (records[0]?.outcome as { finalOutcome?: string } | undefined)?.finalOutcome,
        'CHAT_SUBMISSION_TERMINAL',
      );
      // ...and install authority is bounded to a live admitted command: a
      // settled owner row alone can never install (no synthetic fallback).
      assert.equal(engineInternals.currentP11Owner(), null);
      assert.equal(await engineInternals.installP11ContextCheckpoint(ROUTE), false);
    } finally {
      engine?.closeAdmissionStore();
      store.close(); // idempotent belt: releases if construction never attached
    }
    assert.equal(getOpenAdmissionStoreCount(), 0, 'session end releases the SQLite handle');
  });
});

test('a real submission admits the command before execution and settles it at termination', async () => {
  await withRunsDir(async () => {
    const runId = 'p11-submission-e2e';
    const projectRoot = makeProjectRoot();
    const store = requireStore(runId);
    const mode: ProviderMode = { providerCalls: 0, abort: false };
    const originalFetch = globalThis.fetch;
    stubProvider(mode);
    let engine: ChatEngine | undefined;
    try {
      engine = submittingEngine(runId, projectRoot, store);
      const events = [];
      for await (const event of engine.submitMessageStream('Answer in one short sentence.')) {
        events.push(event);
      }
      assert.equal(events.at(-1)?.type, 'done', 'fixture turn must terminate');

      // The WRAPPER admission site ran: a durable owner row exists and the
      // command record carries its terminal settlement.
      const owner = store.readOwner(runId);
      assert.ok(owner, 'the submission wrapper must have run admitCommand');
      assert.equal(owner.generation, 1);
      const records = store.listAdmissions(runId).records;
      assert.equal(records.length, 1, 'exactly one admitted chat command');
      assert.equal(records[0]?.state, 'settled', 'settled at command settlement (stream termination)');
      assert.match(records[0]?.commandId ?? '', /:s\d+$/, 'command ids are epoch-scoped per instance');
      assert.ok(mode.providerCalls >= 1, 'the turn really executed');

      assert.equal(internals(engine).currentP11Owner(), null, 'no live claim after settlement');
    } finally {
      globalThis.fetch = originalFetch;
      engine?.closeAdmissionStore();
      store.close();
    }
    assert.equal(getOpenAdmissionStoreCount(), 0, 'headless-style run end releases the handle');
  });
});

test('resume: reopen store → recover owner of record → hydrate applies; install honors that owner', async () => {
  await withRunsDir(async () => {
    const runId = 'p11-resume-owner';
    const projectRoot = makeProjectRoot();

    // ── Session 1: admit, install, settle, then the session ends. ──
    const first = requireStore(runId);
    let ownerOfRecord: OwnerRecordV1 | null = null;
    try {
      const engine1 = staticEngine(runId, projectRoot, first);
      try {
        internals(engine1).admitCurrentSubmission(1, 'session one command');
        assert.equal(await internals(engine1).installP11ContextCheckpoint(ROUTE), true);
        internals(engine1).settleActiveAdmissionClaim();
        // Captured AFTER settlement so the durable record (including the
        // settled-at stamp) is exactly what a restart must recover.
        const durable = first.readOwner(runId);
        assert.ok(durable);
        ownerOfRecord = durable;
      } finally {
        engine1.closeAdmissionStore();
      }
    } finally {
      first.close();
    }
    assert.equal(getOpenAdmissionStoreCount(), 0);
    assert.ok(ownerOfRecord);

    // ── Session 2 (restart): reopen the existing store, recover the owner. ──
    const second = requireStore(runId);
    let engine2: ChatEngine | undefined;
    try {
      const recovered = second.readOwner(runId);
      assert.deepEqual(recovered, ownerOfRecord, 'the durable owner of record survives restart');

      engine2 = new ChatEngine({
        task: 'Prove the durable owner wiring',
        projectRoot,
        runId,
        admissionStore: second,
        resumeExisting: true,
        model: STATIC_MODEL,
      });
      // Hydration validates the EXISTING checkpoint against the durable owner
      // of record — before any new admission can mint a newer generation.
      const hydrated = engine2.hydrateInstalledContextAuthority();
      assert.equal(hydrated.applied, true, `expected applied, issues: ${hydrated.issues.join('; ')}`);

      // The first post-resume command ADOPTS the owner of record (no new
      // generation) and install keeps honoring that same owner. (`leaseId`
      // legitimately reflects the new lease holder after re-admission, so the
      // fencing key — generation + token — is what must stay identical.)
      internals(engine2).admitCurrentSubmission(1, 'session two command');
      const afterAdoption = second.readOwner(runId);
      assert.equal(afterAdoption?.generation, ownerOfRecord.generation, 'resume adopts, never mints');
      assert.equal(afterAdoption?.token, ownerOfRecord.token, 'resume adopts, never mints');
      assert.deepEqual(internals(engine2).currentP11Owner(), {
        threadId: runId,
        generation: ownerOfRecord.generation,
        token: ownerOfRecord.token,
      });
      assert.equal(await internals(engine2).installP11ContextCheckpoint(ROUTE), true);
    } finally {
      engine2?.closeAdmissionStore();
      second.close();
    }
    assert.equal(getOpenAdmissionStoreCount(), 0);
  });
});

test('cancellation settles the admitted claim as aborted and withholds install authority', async () => {
  await withRunsDir(async () => {
    const runId = 'p11-cancelled-claim';
    const projectRoot = makeProjectRoot();
    const store = requireStore(runId);
    const mode: ProviderMode = { providerCalls: 0, abort: false };
    const originalFetch = globalThis.fetch;
    stubProvider(mode);
    let engine: ChatEngine | undefined;
    try {
      engine = submittingEngine(runId, projectRoot, store);
      const seen = [];
      for await (const event of engine.submitMessageStream('cancel this turn')) {
        seen.push(event);
        if (event.type === 'thinking') {
          // Cancel while the command is admitted and in flight.
          mode.abort = true;
          engine.abortTurn();
        }
        if (event.type === 'done' || event.type === 'failed' || event.type === 'cancelled') break;
      }
      assert.equal(seen.at(-1)?.type, 'cancelled', 'fixture must terminate as cancelled');

      const records = store.listAdmissions(runId).records;
      assert.equal(records.length, 1);
      assert.equal(records[0]?.state, 'aborted', 'cancellation settles the claim as aborted');
      const outcome = records[0]?.outcome as { finalOutcome?: string } | undefined;
      assert.equal(outcome?.finalOutcome, 'CANCELLED');
      assert.equal(internals(engine).currentP11Owner(), null, 'a cancelled command holds no authority');
    } finally {
      globalThis.fetch = originalFetch;
      engine?.closeAdmissionStore();
      store.close();
    }
    assert.equal(getOpenAdmissionStoreCount(), 0);
  });
});

test('task replacement advances the owner generation and aborts the superseded claim', async () => {
  await withRunsDir(async () => {
    const runId = 'p11-task-replacement';
    const projectRoot = makeProjectRoot();
    const store = requireStore(runId);
    const mode: ProviderMode = { providerCalls: 0, abort: false };
    const originalFetch = globalThis.fetch;
    stubProvider(mode);
    let engine: ChatEngine | undefined;
    try {
      engine = submittingEngine(runId, projectRoot, store);

      // Start a submission and stop at the first yield: its claim is admitted
      // and still unsettled.
      const firstStream = engine.submitMessageStream('first task');
      const iterator = firstStream[Symbol.asyncIterator]();
      const first = await iterator.next();
      assert.equal(first.done, false);
      assert.equal(first.value.type, 'thinking', 'pre-provider yield is the cancel/replace point');
      const firstOwner = store.readOwner(runId);
      assert.equal(firstOwner?.generation, 1);

      // A replacement submission arrives while claim 1 is in flight.
      const replacementEvents = [];
      for await (const event of engine.submitMessageStream('replacement task')) {
        replacementEvents.push(event);
      }
      assert.equal(replacementEvents.at(-1)?.type, 'done', 'replacement turn completes');

      // Task replacement advanced ownership by exactly one generation with a
      // fresh lease token...
      const secondOwner = store.readOwner(runId);
      assert.ok(secondOwner);
      assert.equal(secondOwner.generation, 2, 'task replacement advances the owner generation');
      assert.notEqual(secondOwner.token, firstOwner?.token, 'advancement mints a fresh lease token');
      // ...the superseded claim is durably aborted, the replacement settled.
      const records = store.listAdmissions(runId).records;
      assert.equal(records.length, 2);
      const superseded = records.find((record) => record.ownerGeneration === 1);
      const replacement = records.find((record) => record.ownerGeneration === 2);
      assert.equal(superseded?.state, 'aborted');
      assert.equal(
        (superseded?.outcome as { finalOutcome?: string } | undefined)?.finalOutcome,
        'SUPERSEDED_BY_SUBMISSION',
      );
      assert.equal(replacement?.state, 'settled');

      // Release the abandoned stream; it must not touch the new owner.
      await iterator.return?.();
      assert.deepEqual(store.readOwner(runId), secondOwner);
    } finally {
      globalThis.fetch = originalFetch;
      engine?.closeAdmissionStore();
      store.close();
    }
    assert.equal(getOpenAdmissionStoreCount(), 0);
  });
});

test('fencing negatives: missing/stale/cross-thread/cross-session/wrong-token stay non-authoritative', async () => {
  await withRunsDir(async () => {
    const projectRoot = makeProjectRoot();

    // (a) missing owner: a durable checkpoint with NO owner row → owner_missing.
    {
      const runId = 'p11-neg-missing';
      writeCheckpointFixture(runId, { threadId: runId, generation: 1, token: 'token-a' });
      const store = requireStore(runId);
      let engine: ChatEngine | undefined;
      try {
        engine = staticEngine(runId, projectRoot, store);
        const result = engine.hydrateInstalledContextAuthority();
        assert.equal(result.applied, false, 'no owner row → checkpoint inert');
        assert.ok(result.issues.some((issue) => issue.includes('owner_missing')), result.issues.join('; '));
        assert.equal(internals(engine).currentP11Owner(), null, 'no admission → no install authority');
      } finally {
        engine?.closeAdmissionStore();
        store.close();
      }
    }

    // (b) stale owner: the durable row moved to a successor generation after
    // the checkpoint recorded the old owner — hydrate AND install both fail.
    {
      const runId = 'p11-neg-stale';
      const store = requireStore(runId);
      let engine: ChatEngine | undefined;
      try {
        engine = staticEngine(runId, projectRoot, store);
        internals(engine).admitCurrentSubmission(1, 'stale fixture command');
        const gen1Owner = store.readOwner(runId);
        assert.equal(gen1Owner?.generation, 1);
        // Durable checkpoint recorded under generation 1, then a successor
        // takes over the thread (exactly one generation up, proving the token).
        writeCheckpointFixture(runId, { threadId: runId, generation: 1, token: gen1Owner!.token });
        const takeover = store.admitCommand({
          digestInput: {
            threadId: runId,
            taskId: 'task-successor',
            commandId: 'cmd-successor',
            mode: 'chat',
            resolvedOperationPolicy: { mutation: 'normal' },
            taskShapeClass: 'general',
            targetRoot: projectRoot,
            offeredToolSchemaVersion: 'tools-v1',
            contextSnapshotId: 'ctx-successor',
            payload: { command: 'takeover' },
          },
          ownerGeneration: 2,
          ownerToken: 'successor-token',
          previousOwnerToken: gen1Owner!.token,
          effectClass: 'read_only',
          operationId: 'op-successor',
        });
        assert.equal(takeover.kind, 'admitted');

        // Hydration: the gen-1 checkpoint is STALE against the gen-2 owner.
        const hydrated = engine.hydrateInstalledContextAuthority();
        assert.equal(hydrated.applied, false, 'stale owner → checkpoint inert');
        assert.ok(hydrated.issues.some((issue) => issue.includes('stale_owner')), hydrated.issues.join('; '));

        // Install: the engine's admitted identity (gen 1) no longer matches
        // the durable row — it must fail closed, never adopt the winner's owner.
        assert.equal(internals(engine).currentP11Owner(), null);
        assert.equal(await internals(engine).installP11ContextCheckpoint(ROUTE), false);
      } finally {
        engine?.closeAdmissionStore();
        store.close();
      }
    }

    // (c) cross-thread owner: a checkpoint owned by a DIFFERENT thread.
    {
      const runId = 'p11-neg-thread';
      const store = requireStore(runId);
      let engine: ChatEngine | undefined;
      try {
        engine = staticEngine(runId, projectRoot, store);
        internals(engine).admitCurrentSubmission(1, 'cross-thread fixture');
        writeCheckpointFixture(runId, { threadId: 'some-other-thread', generation: 1, token: 'foreign-token' });
        const result = engine.hydrateInstalledContextAuthority();
        assert.equal(result.applied, false, 'cross-thread owner → checkpoint inert');
        assert.ok(
          result.issues.some((issue) => issue.includes('expected_thread_mismatch') || issue.includes('stale_owner')),
          result.issues.join('; '),
        );
      } finally {
        engine?.closeAdmissionStore();
        store.close();
      }
    }

    // (d) cross-session owner: a checkpoint whose owner was minted in ANOTHER
    // session's store, validated here where this session has its own owner.
    {
      const runId = 'p11-neg-session';
      const foreignSession = 'p11-neg-session-source';
      const store = requireStore(runId);
      let engine: ChatEngine | undefined;
      try {
        engine = staticEngine(runId, projectRoot, store);
        internals(engine).admitCurrentSubmission(1, 'cross-session fixture');
        writeCheckpointFixture(runId, { threadId: foreignSession, generation: 7, token: 'foreign-session-token' });
        const result = engine.hydrateInstalledContextAuthority();
        assert.equal(result.applied, false, 'cross-session owner → checkpoint inert');
        assert.ok(
          result.issues.some((issue) => issue.includes('expected_thread_mismatch') || issue.includes('stale_owner')),
          result.issues.join('; '),
        );
      } finally {
        engine?.closeAdmissionStore();
        store.close();
      }
    }

    // (e) wrong owner token: same thread and generation, but the token does
    // not match the durable owner row.
    {
      const runId = 'p11-neg-token';
      const store = requireStore(runId);
      let engine: ChatEngine | undefined;
      try {
        engine = staticEngine(runId, projectRoot, store);
        internals(engine).admitCurrentSubmission(1, 'wrong-token fixture');
        const owner = store.readOwner(runId);
        assert.equal(owner?.generation, 1);
        writeCheckpointFixture(runId, { threadId: runId, generation: 1, token: 'wrong-owner-token' });
        const result = engine.hydrateInstalledContextAuthority();
        assert.equal(result.applied, false, 'wrong owner token → checkpoint inert');
        assert.ok(result.issues.some((issue) => issue.includes('stale_owner')), result.issues.join('; '));
      } finally {
        engine?.closeAdmissionStore();
        store.close();
      }
    }

    assert.equal(getOpenAdmissionStoreCount(), 0, 'every fencing fixture released its handle');
  });
});
