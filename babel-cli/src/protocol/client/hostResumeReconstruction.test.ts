/**
 * R1 Task 6b-2 — the protocol materialization path reconstructs the same
 * session lifecycle state as the primary resume entrypoint (agent4 F1/F2/F3
 * promotion of `repro/agent4/sessionRestoreGap.test.ts`).
 *
 * Before this fix, `hydrateEngineFromRestore` (the seam called by protocol
 * `materializeEngine`) rebuilt only the conversation: session events were
 * never restored, so `nextSeq` restarted at 0 and the next terminal flush
 * wrote duplicate sequence numbers — permanently bricking the durable log
 * after one protocol turn. Observation membership and installed context
 * authority hydration were also skipped entirely.
 *
 * The seam now mirrors `createEngineFromEventLog`'s repaired reconstruction
 * sequence in the same ordering — durable observation membership FIRST
 * (session-event restore re-persists the snapshot from it), then session
 * events (seq continuity), then installed context authority validated against
 * the durable owner Task 2 wired into `materializeEngine` (owner missing /
 * stale owner stay fail-closed; no second authority source).
 *
 * Controls (from the brief):
 *  (1) protocol turn → nextSeq continuity, durable log stays valid/resumable;
 *  (2) observation membership restored with payload present; missing payload
 *      and omitted membership source fail closed;
 *  (3) installed checkpoint consumed on protocol restore; wrong/missing owner
 *      → `owner_missing` / `stale_owner`;
 *  (4) hydration-throw path leaks nothing — pinned by the existing
 *      `hostAdmissionStore.test.ts` (re-run in the task verification) plus the
 *      handle-count lifecycle asserted here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatEngine } from '../../agent/chatEngine.js';
import {
  THREAD_EVENT_LOG_FILENAME,
  createThreadEventLog,
  endTurn,
  recordAssistantToolCalls,
  recordToolResult,
  serializeThreadEventLog,
  startTurn,
} from '../../agent/threadEventLog.js';
import {
  SESSION_EVENTS_FILENAME,
  createSessionEventLog,
  flushSessionEventLogStrict,
  inspectSessionEventLogFromDir,
  recordTurnEnded,
  recordUserSubmitted,
} from '../../agent/sessionEvents.js';
import { LIVE_SESSION_SNAPSHOT_FILENAME } from '../../agent/liveSessionBridge.js';
import { chatSessionDir } from '../../cli/runsLayout.js';
import { inspectSessionRestoreState } from '../../services/threadStore/sessionHydration.js';
import {
  captureApprovedObservation,
  type ObservationRefV1,
} from '../../evidence/observationStore.js';
import {
  prepareContextCheckpoint,
  type ContextCheckpointOwnerV1,
  type LiveOperationalSourcesV1,
} from '../../runtime/contextCheckpoints.js';
import { getOpenAdmissionStoreCount } from '../../runtime/admissionTestHooks.js';
import {
  closeProtocolHostState,
  createProtocolHostState,
  handleProtocolRequest,
} from './index.js';

type ProtocolHost = ReturnType<typeof createProtocolHostState>;

function withTempRunsDir() {
  const root = mkdtempSync(join(tmpdir(), 'babel-6b2-'));
  const prev = process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR'] = root;
  return {
    root,
    cleanup() {
      if (prev === undefined) delete process.env['BABEL_RUNS_DIR'];
      else process.env['BABEL_RUNS_DIR'] = prev;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface ProtocolDescriptor {
  threadId: string;
  projectRoot: string;
}

/**
 * Mirror of `defaultEngineFactory` (host.ts) built on the REAL ChatEngine,
 * with only the provider turn stubbed: the runtime adapter's entire surface on
 * the subject is `submitMessageStream` (src/runtime/adapters/chat.ts:33), and
 * replacing it keeps the test provider-free while exercising the real
 * `materializeEngine` → admission attach → `hydrateEngineFromRestore`
 * production path end to end.
 */
function realEngineFactory(descriptor: ProtocolDescriptor): ChatEngine {
  const engine = new ChatEngine({
    task: `R1 6b-2 protocol resume ${descriptor.threadId}`,
    projectRoot: descriptor.projectRoot,
    runtimeMode: 'direct',
    executionProfile: 'chat',
  });
  engine.assignRunId(descriptor.threadId);
  (
    engine as unknown as {
      submitMessageStream: (message: string, intent?: string) => AsyncGenerator<unknown>;
    }
  ).submitMessageStream = async function* () {
    yield { type: 'done', answer: 'ok', usage: {} };
  };
  return engine;
}

function makeHost(): ProtocolHost {
  return createProtocolHostState({
    executeWithoutNotifications: true,
    engineFactory: realEngineFactory,
  });
}

interface EngineInternals {
  admitCurrentSubmission(submissionGeneration: number, userInput: string): void;
  p11ObservationCaptureIssues?: string[];
}

function internals(engine: ChatEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

async function createThread(host: ProtocolHost, projectRoot: string): Promise<string> {
  const response = await handleProtocolRequest(
    { jsonrpc: '2.0', id: 1, method: 'thread.create', params: { project_root: projectRoot } },
    host,
  );
  assert.ok('result' in response, JSON.stringify(response));
  return (response as { result: { thread_id: string } }).result.thread_id;
}

async function submitTurn(
  host: ProtocolHost,
  threadId: string,
  message: string,
  id = 2,
): Promise<Awaited<ReturnType<typeof handleProtocolRequest>>> {
  return handleProtocolRequest(
    { jsonrpc: '2.0', id, method: 'turn.submit', params: { thread_id: threadId, message } },
    host,
  );
}

/**
 * Durable fixture exactly shaped like the agent4 witness: a typed thread event
 * log (source of truth for the conversation) plus a valid session-events.jsonl
 * holding seq 0..2 — the artifact the protocol path never used to reload.
 */
function seedDurableLogs(threadId: string, projectRoot: string): void {
  const sessionDir = chatSessionDir(threadId);
  mkdirSync(sessionDir, { recursive: true });
  const log = createThreadEventLog(threadId);
  const first = startTurn(log, {
    task: 'remember the protocol sentinel',
    model: 'm',
    provider: 'p',
    projectRoot,
    policyPreset: 'safe_repo',
  });
  recordAssistantToolCalls(log, first, '', [
    { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
  ] as unknown as Parameters<typeof recordAssistantToolCalls>[3]);
  recordToolResult(log, first, {
    tool_call_id: 'call-1',
    tool_name: 'read_file',
    content: 'protocol-sentinel',
  });
  endTurn(log, first, undefined, 'ok');
  writeFileSync(join(sessionDir, THREAD_EVENT_LOG_FILENAME), serializeThreadEventLog(log));

  const durable = createSessionEventLog(threadId);
  recordUserSubmitted(durable, { turn_id: 'turn-1', task: 'remember the protocol sentinel', projectRoot });
  recordTurnEnded(durable, { turn_id: 'turn-1', status: 'completed' });
  recordUserSubmitted(durable, { turn_id: 'turn-2', task: 'second protocol turn', projectRoot });
  flushSessionEventLogStrict(sessionDir, durable);
}

interface ObservationFixture {
  observationId: string;
  ref: ObservationRefV1;
  payloadPath: string;
}

function captureObservation(sessionDir: string, suffix: string): ObservationFixture {
  const storageRoot = join(sessionDir, 'observations');
  const captured = captureApprovedObservation(
    {
      invocation: {
        operation_id: `op-${suffix}`,
        task_id: `task-${suffix}`,
        run_id: `run-${suffix}`,
        turn_id: 'turn-1',
        attempt_id: 'attempt-1',
      },
      sections: [{ channel: 'stdout', content: 'exact observation payload' }],
      execution_status: 'succeeded',
      permitted_principals: ['agent:main'],
      data_policy: {
        approved: true,
        policy_version: 'babel-chat-model-readable-v1',
        redaction_policy_version: 'babel-chat-redaction-v1',
      },
    },
    {
      storage_root: storageRoot,
      clock: () => new Date().toISOString(),
      policy: { durability: 'fsync_file_and_dir' },
    },
  );
  assert.equal(captured.status, 'captured');
  if (captured.status !== 'captured') throw new Error('capture failed');
  const payload = captured.observation.payloads[0];
  assert.ok(payload, 'captured observation must carry a payload');
  return {
    observationId: captured.observation.observation_id,
    ref: captured.observation,
    payloadPath: join(storageRoot, payload.object_key),
  };
}

function writeMembershipSnapshot(threadId: string, authorizedIds: readonly string[]): void {
  writeFileSync(
    join(chatSessionDir(threadId), LIVE_SESSION_SNAPSHOT_FILENAME),
    JSON.stringify({ schema_version: 1, session_id: threadId, authorized_observation_ids: [...authorizedIds] }),
    'utf8',
  );
}

function sources(manifest: readonly ObservationRefV1[]): LiveOperationalSourcesV1 {
  return {
    resumed: false,
    task_contract: {
      goal: 'protocol restore reconstructs durable session state',
      acceptance_clause_ids: ['clause-1'],
      contract_hash: 'contract-hash-1',
    },
    working_state: {
      current_hypothesis: 'the protocol seam must mirror the primary resume sequence',
      unresolved_failures: [],
      next_experiment: 'resume over protocol',
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
      model_route: 'mimo-v2.5',
    },
    observations: manifest.map((entry) => ({
      observation_id: entry.observation_id,
      payload_sha256: entry.payloads[0]?.sha256 ?? '',
      authorized: true,
    })),
    observation_manifest: manifest,
    legacy_observation_refs: [],
  };
}

function writeCheckpointFixture(
  threadId: string,
  owner: ContextCheckpointOwnerV1,
  manifest: readonly ObservationRefV1[] = [],
): void {
  const dir = chatSessionDir(threadId);
  mkdirSync(dir, { recursive: true });
  const prepared = prepareContextCheckpoint({
    checkpointId: `cp-${threadId}`,
    owner,
    sources: sources(manifest),
    turnId: 'turn-1',
    contextEpoch: '1:revision-1:capture-epoch-1',
  });
  assert.equal(prepared.status, 'prepared', prepared.status === 'blocked' ? prepared.reasons.join(', ') : '');
  if (prepared.status !== 'prepared') return;
  writeFileSync(join(dir, 'context-checkpoint.json'), JSON.stringify(prepared.checkpoint, null, 2), 'utf8');
}

/**
 * Phase 1 of the "installed checkpoint" fixtures: materialize over the
 * protocol path and admit a REAL command through the production admission
 * wrapper so a durable owner row exists (never a synthetic owner). The host
 * handle is released; the row survives on disk.
 */
async function admitDurableOwner(threadId: string, projectRoot: string): Promise<ContextCheckpointOwnerV1> {
  const host = makeHost();
  try {
    const response = await submitTurn(host, threadId, 'materialize for durable admission');
    assert.ok('result' in response, JSON.stringify(response));
    const engine = host.engines.get(threadId);
    assert.ok(engine, 'materialized engine');
    internals(engine).admitCurrentSubmission(1, 'durable owner fixture command');
    const owner = host.admissionStores.get(threadId)?.readOwner(threadId);
    assert.ok(owner, 'real admission must have written the durable owner row');
    return { threadId: owner.threadId, generation: owner.generation, token: owner.token };
  } finally {
    closeProtocolHostState(host);
  }
}

test('control 1: a protocol turn keeps durable session-event continuity (no duplicate seqs, thread stays resumable)', async () => {
  const fixture = withTempRunsDir();
  const hosts: ProtocolHost[] = [];
  try {
    assert.equal(getOpenAdmissionStoreCount(), 0, 'no leaked handles before the test');
    const creator = createProtocolHostState();
    const threadId = await createThread(creator, fixture.root);
    seedDurableLogs(threadId, fixture.root);
    const sessionDir = chatSessionDir(threadId);

    const before = inspectSessionRestoreState(threadId, 'chat', { currentRoot: fixture.root });
    assert.equal(before.resumable, true, 'fixture must start resumable');
    assert.equal(before.source, 'thread_event_log');

    const host = makeHost();
    hosts.push(host);
    const submitted = await submitTurn(host, threadId, 'continue the protocol thread');
    assert.ok('result' in submitted, JSON.stringify(submitted));

    const engine = host.engines.get(threadId);
    assert.ok(engine, 'materialized engine cached after hydration');
    const parity = engine.getParityRuntime();

    // Hydration rebuilt the conversation from the durable thread event log...
    assert.ok(
      engine.getConversation().some((m) => (m.content ?? '').includes('protocol sentinel')),
      'conversation hydrated from the durable log',
    );
    // ...AND reconstructed the session lifecycle state the seam used to skip.
    assert.equal(
      parity.sessionEvents.events.length,
      3,
      'durable session events must be restored on the protocol path (pre-fix: 0)',
    );
    assert.equal(parity.sessionEvents.nextSeq, 3, 'seq counter continues from the durable log (pre-fix: 0)');
    assert.equal(getOpenAdmissionStoreCount(), 1, 'materialization attached exactly one admission handle');

    // The next protocol turn's terminal flush appends into the existing seq
    // space instead of restarting at 0 and duplicating 0..2.
    recordUserSubmitted(parity.sessionEvents, {
      turn_id: 'turn-3',
      task: 'post-resume protocol turn',
      projectRoot: fixture.root,
    });
    flushSessionEventLogStrict(sessionDir, parity.sessionEvents);

    const after = inspectSessionEventLogFromDir(sessionDir, threadId);
    assert.equal(after.kind, 'valid', 'durable session log must stay parseable after a protocol turn');
    if (after.kind === 'valid') {
      assert.equal(after.log.events.length, 4, '3 durable + 1 new');
      assert.deepEqual(
        after.log.events.map((event) => event.seq),
        [0, 1, 2, 3],
        'contiguous seqs, no duplicates',
      );
    }
    const reReport = inspectSessionRestoreState(threadId, 'chat', { currentRoot: fixture.root });
    assert.equal(reReport.resumable, true, 'the thread must remain resumable (pre-fix: bricked by SESSION_EVENT_LOG_INVALID)');
    assert.equal(reReport.reason, undefined);

    closeProtocolHostState(host);
    assert.equal(getOpenAdmissionStoreCount(), 0, 'teardown drains the handle');
  } finally {
    for (const host of hosts) closeProtocolHostState(host);
    fixture.cleanup();
  }
});

test('control 2+3: protocol restore restores membership and consumes the installed checkpoint under the real durable owner', async () => {
  const fixture = withTempRunsDir();
  const hosts: ProtocolHost[] = [];
  try {
    assert.equal(getOpenAdmissionStoreCount(), 0);
    const creator = createProtocolHostState();
    const threadId = await createThread(creator, fixture.root);
    seedDurableLogs(threadId, fixture.root);
    const sessionDir = chatSessionDir(threadId);

    // Real durable owner: admitted through the production wrapper on a first
    // protocol materialization (Task 2's wiring), never synthesized.
    const owner = await admitDurableOwner(threadId, fixture.root);
    assert.equal(owner.generation, 1);

    // Installed checkpoint + durable membership + payload present.
    const observation = captureObservation(sessionDir, 'present');
    writeMembershipSnapshot(threadId, [observation.observationId]);
    writeCheckpointFixture(threadId, owner, [observation.ref]);

    const host = makeHost();
    hosts.push(host);
    const submitted = await submitTurn(host, threadId, 'resume and consume the checkpoint');
    assert.ok('result' in submitted, JSON.stringify(submitted));
    const engine = host.engines.get(threadId);
    assert.ok(engine, 'materialized engine');
    const parity = engine.getParityRuntime();

    // Seam effects, observed BEFORE any manual revalidation below.
    assert.ok(
      parity.contextCheckpoint,
      'installed checkpoint consumed on protocol restore (pre-fix: never hydrated)',
    );
    assert.ok(
      parity.authorizedObservationIds?.has(observation.observationId),
      'durable observation membership restored before session-event restore',
    );
    assert.ok(parity.sessionEvents.events.length === 3, 'session events restored alongside authority');

    // Independent revalidation through the same seam agrees: applies cleanly.
    const recheck = engine.hydrateInstalledContextAuthority();
    assert.equal(recheck.applied, true, `expected applied, issues: ${recheck.issues.join('; ')}`);
    assert.deepEqual(recheck.issues, []);

    closeProtocolHostState(host);
    assert.equal(getOpenAdmissionStoreCount(), 0, 'teardown drains the handle');
  } finally {
    for (const host of hosts) closeProtocolHostState(host);
    fixture.cleanup();
  }
});

test('control 2: missing observation payload fails closed while membership stays restored', async () => {
  const fixture = withTempRunsDir();
  const hosts: ProtocolHost[] = [];
  try {
    assert.equal(getOpenAdmissionStoreCount(), 0);
    const creator = createProtocolHostState();
    const threadId = await createThread(creator, fixture.root);
    seedDurableLogs(threadId, fixture.root);
    const sessionDir = chatSessionDir(threadId);

    const owner = await admitDurableOwner(threadId, fixture.root);
    const observation = captureObservation(sessionDir, 'missing-payload');
    writeMembershipSnapshot(threadId, [observation.observationId]);
    writeCheckpointFixture(threadId, owner, [observation.ref]);
    // The durable membership and the manifest entry exist; the payload object
    // does not. The checkpoint must stay inert rather than reconstruct partial
    // trusted context.
    rmSync(observation.payloadPath, { force: true });

    const host = makeHost();
    hosts.push(host);
    const submitted = await submitTurn(host, threadId, 'resume with a missing payload');
    assert.ok('result' in submitted, JSON.stringify(submitted));
    const engine = host.engines.get(threadId);
    assert.ok(engine, 'materialized engine');
    const parity = engine.getParityRuntime();

    // Membership WAS restored (the seam ran), but the payload cannot resolve.
    assert.ok(
      parity.authorizedObservationIds?.has(observation.observationId),
      'membership restored from the durable snapshot',
    );
    assert.equal(parity.contextCheckpoint ?? null, null, 'payload loss keeps the checkpoint inert');
    const seamIssues = internals(engine).p11ObservationCaptureIssues ?? [];
    assert.ok(
      seamIssues.some((issue) => issue.includes('unavailable')),
      `seam must have recorded the payload failure (pre-fix: seam never ran), got: ${seamIssues.join('; ')}`,
    );

    const recheck = engine.hydrateInstalledContextAuthority();
    assert.equal(recheck.applied, false, 'missing payload must fail closed');
    assert.ok(
      recheck.issues.some((issue) => issue.includes('unavailable')),
      recheck.issues.join('; '),
    );
    assert.ok(
      !recheck.issues.some((issue) => issue.includes('observation_membership_unavailable')),
      `membership was restored; the failure is the payload, not membership: ${recheck.issues.join('; ')}`,
    );

    closeProtocolHostState(host);
    assert.equal(getOpenAdmissionStoreCount(), 0);
  } finally {
    for (const host of hosts) closeProtocolHostState(host);
    fixture.cleanup();
  }
});

test('control 2: an omitted membership source blocks the checkpoint with observation_membership_unavailable', async () => {
  const fixture = withTempRunsDir();
  const hosts: ProtocolHost[] = [];
  try {
    assert.equal(getOpenAdmissionStoreCount(), 0);
    const creator = createProtocolHostState();
    const threadId = await createThread(creator, fixture.root);
    seedDurableLogs(threadId, fixture.root);
    const sessionDir = chatSessionDir(threadId);

    // Manifest present; the durable membership snapshot source is omitted and
    // no owner row exists. A checkpoint can never grant its own membership.
    const observation = captureObservation(sessionDir, 'no-membership');
    writeCheckpointFixture(
      threadId,
      { threadId, generation: 1, token: 'never-admitted-token' },
      [observation.ref],
    );

    const host = makeHost();
    hosts.push(host);
    const submitted = await submitTurn(host, threadId, 'resume without a membership source');
    assert.ok('result' in submitted, JSON.stringify(submitted));
    const engine = host.engines.get(threadId);
    assert.ok(engine, 'materialized engine');
    const parity = engine.getParityRuntime();

    assert.equal(parity.contextCheckpoint ?? null, null, 'checkpoint stays non-authoritative');

    const recheck = engine.hydrateInstalledContextAuthority();
    assert.equal(recheck.applied, false, 'omitted membership source must fail closed');
    assert.ok(
      recheck.issues.some((issue) => issue.includes('observation_membership_unavailable')),
      `expected observation_membership_unavailable, got: ${recheck.issues.join('; ')}`,
    );

    closeProtocolHostState(host);
    assert.equal(getOpenAdmissionStoreCount(), 0);
  } finally {
    for (const host of hosts) closeProtocolHostState(host);
    fixture.cleanup();
  }
});

test('control 3: wrong/missing durable owner stays fail-closed on the protocol path (owner_missing / stale_owner)', async () => {
  const fixture = withTempRunsDir();
  const hosts: ProtocolHost[] = [];
  try {
    assert.equal(getOpenAdmissionStoreCount(), 0);
    const projectRoot = fixture.root;
    const creator = createProtocolHostState();

    // (a) missing owner: a durable checkpoint whose owner row never existed.
    {
      const threadId = await createThread(creator, projectRoot);
      seedDurableLogs(threadId, projectRoot);
      writeCheckpointFixture(threadId, { threadId, generation: 1, token: 'missing-owner-token' });

      const host = makeHost();
      hosts.push(host);
      const submitted = await submitTurn(host, threadId, 'resume with a missing owner');
      assert.ok('result' in submitted, JSON.stringify(submitted));
      const engine = host.engines.get(threadId);
      assert.ok(engine, 'materialized engine');
      assert.equal(engine.getParityRuntime().contextCheckpoint ?? null, null, 'no owner row → inert');

      const recheck = engine.hydrateInstalledContextAuthority();
      assert.equal(recheck.applied, false, 'missing owner must fail closed');
      assert.ok(
        recheck.issues.some((issue) => issue.includes('owner_missing')),
        `expected owner_missing, got: ${recheck.issues.join('; ')}`,
      );
      closeProtocolHostState(host);
      assert.equal(getOpenAdmissionStoreCount(), 0);
    }

    // (b) wrong owner: the row exists (real admission) but the checkpoint
    // recorded a different lease token — stale_owner, never adopted.
    {
      const threadId = await createThread(creator, projectRoot);
      seedDurableLogs(threadId, projectRoot);
      await admitDurableOwner(threadId, projectRoot);
      writeCheckpointFixture(threadId, {
        threadId,
        generation: 1,
        token: 'wrong-lease-token',
      });

      const host = makeHost();
      hosts.push(host);
      const submitted = await submitTurn(host, threadId, 'resume with a stale owner');
      assert.ok('result' in submitted, JSON.stringify(submitted));
      const engine = host.engines.get(threadId);
      assert.ok(engine, 'materialized engine');
      assert.equal(engine.getParityRuntime().contextCheckpoint ?? null, null, 'wrong owner → inert');

      const recheck = engine.hydrateInstalledContextAuthority();
      assert.equal(recheck.applied, false, 'wrong owner must fail closed');
      assert.ok(
        recheck.issues.some((issue) => issue.includes('stale_owner')),
        `expected stale_owner, got: ${recheck.issues.join('; ')}`,
      );
      closeProtocolHostState(host);
      assert.equal(getOpenAdmissionStoreCount(), 0);
    }
  } finally {
    for (const host of hosts) closeProtocolHostState(host);
    fixture.cleanup();
  }
});
