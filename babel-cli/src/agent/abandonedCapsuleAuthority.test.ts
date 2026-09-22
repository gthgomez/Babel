/**
 * R1 Task 6b-1 — an abandoned/staged persistence artifact is NEVER current
 * authority (cell5c promotion).
 *
 * Durability rule under test: an interrupted checkpoint batch must be
 * recovered — or fail closed — BEFORE `ChatEngine.restore` reads any durable
 * artifact. A crash between two fixed-order renames leaves the uncommitted
 * capsule readable on disk while the journal is still `prepared`; before this
 * fix the restore loaded `thread_events.json` first, so the abandoned capsule
 * entered the engine's memory and (with no published `context-checkpoint.json`)
 * became provider system context. With no valid published checkpoint the
 * restore must end non-authoritative: the capsule is inert, the checkpoint
 * stays unapplied (`lineage_not_committed` / `lineage_missing` /
 * `owner_missing` vocabulary, as used by the agent7 matrix).
 *
 * This is the promoted `repro/agent7/matrix.test.ts` cell5c probe: it drives
 * the REAL `ChatEngine.restore` (the witness only demonstrates the disk
 * state) plus the mandatory negative controls (journal-less state untouched,
 * orphan staged tmp inert, malformed journal still fails closed).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ChatEngine } from './chatEngine.js';
import { CONTEXT_CHECKPOINT_FILENAME } from './chatEngineParityBridge.js';
import {
  CHECKPOINT_JOURNAL_FILENAME,
  persistLiveSessionAuthority,
  resolveLiveSessionAuthority,
  writeCheckpointJournal,
} from './liveSessionBridge.js';
import {
  THREAD_EVENT_LOG_FILENAME,
  appendThreadEvent,
  createThreadEventLog,
  endTurn,
  loadThreadEventLogFromDir,
  rebuildProviderMessagesFromEvents,
  serializeThreadEventLog,
  startTurn,
  type ThreadEventLog,
} from './threadEventLog.js';
import {
  SESSION_EVENTS_FILENAME,
  createSessionEventLog,
  inspectSessionEventLogFromDir,
  loadSessionEventLogForResume,
  recordCompactionCommitted,
  recordCompactionStarted,
  recordCompactionSummary,
  recordTurnEnded,
  recordUserSubmitted,
  serializeSessionEventLog,
  type SessionEventLog,
} from './sessionEvents.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import {
  prepareContextCheckpoint,
  type ContextCheckpointInstalledLineageV1,
} from '../runtime/contextCheckpoints.js';

const CAPSULE_B = 'agent7 capsule B body — uncommitted until lineage proves it';
const BATCH_ID = 'batch-6b1';

async function withRunsDir(fn: () => Promise<void>): Promise<void> {
  const previous = process.env['BABEL_RUNS_DIR'];
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-6b1-'));
  process.env['BABEL_RUNS_DIR'] = runsRoot;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = previous;
    rmSync(runsRoot, { recursive: true, force: true });
  }
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-6b1-proj-'));
  writeFileSync(join(root, 'README.md'), 'fixture repository\n', 'utf8');
  return root;
}

function appendCapsuleB(log: ThreadEventLog, turnId: string) {
  return appendThreadEvent(log, {
    kind: 'compaction_capsule',
    turn_id: turnId,
    content: CAPSULE_B,
    preserved_tool_call_ids: [],
    raw_observation_refs: [],
    ownership_generation: 1,
  });
}

function appendCommitB(sessionLog: SessionEventLog, turnId: string, threadEventId: string, digest: string): void {
  recordCompactionStarted(sessionLog, turnId, {
    operation_id: 'op-b',
    strategy: 'llm-summarize',
    replaces_thread_seq_start: 0,
    replaces_thread_seq_end: 1,
    replaces_message_count: 2,
  });
  recordCompactionSummary(sessionLog, turnId, {
    operation_id: 'op-b',
    capsule_digest: digest,
    raw_observation_refs: [],
    preserved_tool_call_ids: [],
  });
  recordCompactionCommitted(sessionLog, turnId, {
    operation_id: 'op-b',
    thread_event_id: threadEventId,
    capsule_digest: digest,
    replaces_thread_seq_start: 0,
    replaces_thread_seq_end: 1,
    replaces_message_count: 2,
    preserved_tool_call_ids: [],
  });
}

function digestOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Coherent durable generation A: thread log (one ordinary turn), session
 * events, live-session authority (required by the `resumeExisting` restore
 * branch), and the legacy transcript. No journal, no checkpoint.
 */
function buildGenerationA(dir: string, threadId: string, projectRoot: string): void {
  mkdirSync(dir, { recursive: true });
  persistLiveSessionAuthority(
    dir,
    resolveLiveSessionAuthority({ mode: 'chat', projectRoot, task: 'R1 6b-1 fixture' }),
  );
  const thread = createThreadEventLog(threadId);
  const turn = startTurn(thread, {
    task: 'generation A',
    model: 'm',
    provider: 'p',
    projectRoot,
    policyPreset: 'safe_repo',
  });
  endTurn(thread, turn, undefined, 'ok');
  writeFileSync(join(dir, THREAD_EVENT_LOG_FILENAME), serializeThreadEventLog(thread));
  const session = createSessionEventLog(threadId);
  recordUserSubmitted(session, { turn_id: 'turn-1', task: 'generation A', projectRoot });
  recordTurnEnded(session, { turn_id: 'turn-1', status: 'completed' });
  writeFileSync(join(dir, SESSION_EVENTS_FILENAME), serializeSessionEventLog(session));
  writeFileSync(
    join(dir, 'transcript.jsonl'),
    `${JSON.stringify({ role: 'user', content: 'hello' })}\n`,
    'utf8',
  );
}

/**
 * cell5c crash state, built by hand: thread primary already renamed to
 * generation B (carries the uncommitted capsule), session not yet renamed
 * (staged tmp = B, bak = A), context target staged only (P11 never installed →
 * no published checkpoint), journal `prepared` + `backups_ready`.
 */
function stageCell5cCrashState(
  dir: string,
  threadId: string,
  projectRoot: string,
): { threadA: string; sessionA: string } {
  buildGenerationA(dir, threadId, projectRoot);
  const threadA = readFileSync(join(dir, THREAD_EVENT_LOG_FILENAME), 'utf8');
  const sessionA = readFileSync(join(dir, SESSION_EVENTS_FILENAME), 'utf8');

  const threadBLog = loadThreadEventLogFromDir(dir)!;
  appendCapsuleB(threadBLog, 'turn-1');
  const threadB = serializeThreadEventLog(threadBLog);
  const capsule = threadBLog.events.find((e) => e.kind === 'compaction_capsule');
  assert.ok(capsule, 'fixture capsule');
  const sessionBLog = loadSessionEventLogForResume(dir, threadId);
  appendCommitB(sessionBLog, 'turn-1', capsule.event_id, digestOf(CAPSULE_B));
  const sessionB = serializeSessionEventLog(sessionBLog);

  writeCheckpointJournal(dir, {
    schema_version: 1,
    batch_id: BATCH_ID,
    status: 'prepared',
    backups_ready: true,
    targets: [THREAD_EVENT_LOG_FILENAME, SESSION_EVENTS_FILENAME, CONTEXT_CHECKPOINT_FILENAME],
  });
  // thread primary already renamed to B; its tmp consumed, bak = A
  writeFileSync(join(dir, THREAD_EVENT_LOG_FILENAME), threadB, 'utf8');
  writeFileSync(join(dir, `${THREAD_EVENT_LOG_FILENAME}.${BATCH_ID}.bak`), threadA, 'utf8');
  // session primary still A; staged tmp = B, bak = A
  writeFileSync(join(dir, `${SESSION_EVENTS_FILENAME}.${BATCH_ID}.tmp`), sessionB, 'utf8');
  writeFileSync(join(dir, `${SESSION_EVENTS_FILENAME}.${BATCH_ID}.bak`), sessionA, 'utf8');
  // context checkpoint target: never published (P11 not installed) — staged tmp only
  rmSync(join(dir, CONTEXT_CHECKPOINT_FILENAME), { force: true });
  writeFileSync(
    join(dir, `${CONTEXT_CHECKPOINT_FILENAME}.${BATCH_ID}.tmp`),
    '{"staged":"never-committed"}',
    'utf8',
  );
  return { threadA, sessionA };
}

function restoreEngine(threadId: string, projectRoot: string): Promise<ChatEngine> {
  return ChatEngine.restore(threadId, { task: 'R1 6b-1 restore', projectRoot });
}

function capsuleCount(log: ThreadEventLog): number {
  return log.events.filter((e) => e.kind === 'compaction_capsule').length;
}

test('restore() recovers an interrupted checkpoint batch before reading durable state (cell5c)', async () => {
  await withRunsDir(async () => {
    const threadId = 'r1-6b1-cell5c';
    const projectRoot = makeProjectRoot();
    try {
      const dir = chatSessionDir(threadId);
      const { threadA } = stageCell5cCrashState(dir, threadId, projectRoot);

      // ── fixture proof: this is the exact fail-open disk state ──
      const preRecovery = loadThreadEventLogFromDir(dir)!;
      assert.equal(capsuleCount(preRecovery), 1, 'pre-recovery disk carries the uncommitted capsule');
      assert.ok(existsSync(join(dir, CHECKPOINT_JOURNAL_FILENAME)), 'journal still prepared');
      assert.ok(
        !existsSync(join(dir, CONTEXT_CHECKPOINT_FILENAME)),
        'no published context-checkpoint.json (the fail-open window)',
      );

      // ── the fixed production seam ──
      const engine = await restoreEngine(threadId, projectRoot);
      const parity = engine.getParityRuntime();

      // Recovery ran BEFORE the reads: the abandoned capsule is nowhere.
      assert.equal(
        capsuleCount(parity.eventLog),
        0,
        'abandoned capsule must not be loaded into the restored engine',
      );
      const msgs = rebuildProviderMessagesFromEvents(parity.eventLog);
      assert.ok(
        !msgs.some((m) => m.name === 'compaction_capsule' && m.content === CAPSULE_B),
        'abandoned capsule must never become provider system context',
      );
      // With no valid published checkpoint the restore ends non-authoritative.
      assert.equal(parity.contextCheckpoint ?? null, null, 'no published checkpoint → inert');

      // Durable state settled back to generation A and sidecars consumed.
      const postRecovery = loadThreadEventLogFromDir(dir)!;
      assert.equal(capsuleCount(postRecovery), 0, 'disk recovered to generation A');
      assert.equal(readFileSync(join(dir, THREAD_EVENT_LOG_FILENAME), 'utf8'), threadA);
      assert.ok(!existsSync(join(dir, CHECKPOINT_JOURNAL_FILENAME)), 'journal consumed');
      for (const target of [THREAD_EVENT_LOG_FILENAME, SESSION_EVENTS_FILENAME, CONTEXT_CHECKPOINT_FILENAME]) {
        assert.ok(!existsSync(join(dir, `${target}.${BATCH_ID}.bak`)), `bak of ${target} consumed`);
        assert.ok(!existsSync(join(dir, `${target}.${BATCH_ID}.tmp`)), `tmp of ${target} consumed`);
      }

      // Session-event continuity survived the restore.
      assert.ok(parity.sessionEvents.events.length >= 1, 'session events restored');
      assert.equal(parity.sessionEvents.nextSeq, parity.sessionEvents.events.length, 'seq continuity');
      const inspected = inspectSessionEventLogFromDir(dir, threadId);
      assert.equal(inspected.kind, 'valid', 'durable session log stays parseable');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

test('a published checkpoint claiming an uncommitted capsule stays non-authoritative through restore', async () => {
  await withRunsDir(async () => {
    const threadId = 'r1-6b1-lineage-not-committed';
    const projectRoot = makeProjectRoot();
    try {
      const dir = chatSessionDir(threadId);
      buildGenerationA(dir, threadId, projectRoot);

      // The claim: an installed checkpoint that names a compaction capsule
      // which no durable session commit and no durable thread capsule prove
      // (the cell5a premise, now pinned end-to-end through ChatEngine.restore).
      const claimLog = createThreadEventLog(threadId);
      const claimTurn = startTurn(claimLog, {
        task: 'abandoned claim',
        model: 'm',
        provider: 'p',
        projectRoot,
        policyPreset: 'safe_repo',
      });
      endTurn(claimLog, claimTurn, undefined, 'ok');
      const abandonedCapsule = appendCapsuleB(claimLog, 'turn-1');
      const lineage: ContextCheckpointInstalledLineageV1 = {
        checkpoint_id: 'ctx-6b1-claim',
        compaction_event_id: abandonedCapsule.event_id,
        compaction_commit_event_id: '00000000-0000-4000-8000-000000000001',
        compaction_digest: digestOf(CAPSULE_B),
        thread_event_boundary_seq: abandonedCapsule.seq,
      };
      const prepared = prepareContextCheckpoint({
        checkpointId: 'ctx-6b1-claim',
        owner: { threadId, generation: 1, token: 'token-6b1' },
        installedLineage: lineage,
        turnId: 'turn-1',
        contextEpoch: '1:revision-1:capture-epoch-1',
        sources: {
          resumed: false,
          task_contract: { goal: 'abandoned claim inert', acceptance_clause_ids: ['c'], contract_hash: 'h' },
          working_state: { current_hypothesis: 'h', unresolved_failures: [], next_experiment: 'n' },
          workspace: {
            current_snapshot_revision: 'r',
            capture_complete: true,
            coverage_ref: 'cov',
            capture_provenance: 'current_capture',
            capture_epoch: 'e',
          },
          receipts: [{ receipt_id: 'rc', identity: 'i', scope: 's', stale: false, bound_revision: 'r' }],
          budget: { owner: 'b', remaining_allowance: 1, cancellation_owner: 'b' },
          pending: [],
          route: { compiled_request_identity: 'rq', tool_profile: 'tp', model_route: 'mr' },
          observations: [],
          observation_manifest: [],
          legacy_observation_refs: [],
        },
      });
      assert.equal(prepared.status, 'prepared', prepared.status === 'blocked' ? prepared.reasons.join(', ') : '');
      if (prepared.status !== 'prepared') return;
      writeFileSync(
        join(dir, CONTEXT_CHECKPOINT_FILENAME),
        JSON.stringify(prepared.checkpoint, null, 2),
        'utf8',
      );

      const engine = await restoreEngine(threadId, projectRoot);
      const parity = engine.getParityRuntime();

      // The claim cannot prove its lineage (and no durable owner exists), so
      // the checkpoint stays inert and the logs remain the only source.
      const hydration = engine.hydrateInstalledContextAuthority(dir);
      assert.equal(hydration.applied, false, 'checkpoint must not apply');
      assert.ok(
        hydration.issues.some((issue) => issue.includes('lineage_not_committed')),
        `expected lineage_not_committed, got: ${hydration.issues.join('; ')}`,
      );
      assert.ok(
        hydration.issues.some((issue) => issue.includes('owner_missing')),
        `expected owner_missing, got: ${hydration.issues.join('; ')}`,
      );
      assert.equal(parity.contextCheckpoint ?? null, null, 'non-authoritative: checkpoint never promoted');
      const msgs = rebuildProviderMessagesFromEvents(parity.eventLog);
      assert.ok(
        !msgs.some((m) => m.name === 'compaction_capsule'),
        'no capsule exists on disk; nothing to adopt',
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

test('negative control: journal-less coherent state is restored byte-identically (not over-blocking)', async () => {
  await withRunsDir(async () => {
    const threadId = 'r1-6b1-neg-journalless';
    const projectRoot = makeProjectRoot();
    try {
      const dir = chatSessionDir(threadId);
      buildGenerationA(dir, threadId, projectRoot);
      const before = {
        thread: readFileSync(join(dir, THREAD_EVENT_LOG_FILENAME), 'utf8'),
        session: readFileSync(join(dir, SESSION_EVENTS_FILENAME), 'utf8'),
      };

      const engine = await restoreEngine(threadId, projectRoot);
      const parity = engine.getParityRuntime();

      // The ordering fix is a pure no-op without a journal: nothing rewritten,
      // nothing littered, and coherent state still restores normally.
      assert.equal(readFileSync(join(dir, THREAD_EVENT_LOG_FILENAME), 'utf8'), before.thread);
      assert.equal(readFileSync(join(dir, SESSION_EVENTS_FILENAME), 'utf8'), before.session);
      assert.ok(!existsSync(join(dir, CHECKPOINT_JOURNAL_FILENAME)), 'no journal invented');
      assert.equal(capsuleCount(parity.eventLog), 0);
      assert.equal(parity.eventLog.thread_id, threadId);
      assert.ok(parity.sessionEvents.events.length >= 1, 'session events restored');
      assert.equal(parity.contextCheckpoint ?? null, null, 'control: no checkpoint in this fixture');
      assert.ok(engine.getConversation().length > 0, 'control: conversation restored');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

test('negative control: an orphan staged tmp without a journal is never accepted', async () => {
  await withRunsDir(async () => {
    const threadId = 'r1-6b1-neg-orphan';
    const projectRoot = makeProjectRoot();
    try {
      const dir = chatSessionDir(threadId);
      buildGenerationA(dir, threadId, projectRoot);

      // Orphan staged capsule with NO journal: recovery is a no-op and the
      // loader never globs tmp files — inert litter, never adopted.
      const orphanLog = createThreadEventLog(threadId);
      const orphanTurn = startTurn(orphanLog, {
        task: 'orphan',
        model: 'm',
        provider: 'p',
        projectRoot,
        policyPreset: 'safe_repo',
      });
      endTurn(orphanLog, orphanTurn, undefined, 'ok');
      appendCapsuleB(orphanLog, 'turn-1');
      const orphanPath = join(dir, `${THREAD_EVENT_LOG_FILENAME}.00000000-0000-4000-8000-000000000000.tmp`);
      writeFileSync(orphanPath, serializeThreadEventLog(orphanLog), 'utf8');

      const engine = await restoreEngine(threadId, projectRoot);
      const parity = engine.getParityRuntime();

      assert.equal(capsuleCount(parity.eventLog), 0, 'orphan tmp never reaches the engine');
      const msgs = rebuildProviderMessagesFromEvents(parity.eventLog);
      assert.ok(!msgs.some((m) => m.name === 'compaction_capsule'), 'orphan never adopted');
      assert.ok(existsSync(orphanPath), 'orphan tmp remains as inert litter (no journal → no cleanup)');
      assert.equal(parity.contextCheckpoint ?? null, null);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

test('negative control: a malformed checkpoint journal still fails closed before any read', async () => {
  await withRunsDir(async () => {
    const threadId = 'r1-6b1-neg-bad-journal';
    const projectRoot = makeProjectRoot();
    try {
      const dir = chatSessionDir(threadId);
      buildGenerationA(dir, threadId, projectRoot);
      writeFileSync(join(dir, CHECKPOINT_JOURNAL_FILENAME), '{ this is not valid json', 'utf8');

      // Recovery-first ordering must not weaken malformed-state handling:
      // an invalid journal still fails closed (CHECKPOINT_JOURNAL_INVALID),
      // now before any durable artifact is read instead of after.
      await assert.rejects(
        () => restoreEngine(threadId, projectRoot),
        /journal is not valid JSON/,
        'malformed journal must fail closed out of restore()',
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
