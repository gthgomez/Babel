/**
 * Installed-lineage CURRENCY regression suite (Task 4 — R1/P11 closure).
 *
 * Invariant under test: an accepted checkpoint lineage must name EXACTLY the
 * latest relevant committed compaction for the session's context generation —
 * the `compaction_committed` event with the maximum canonical session-event
 * `seq` (commit id + capsule digest + boundary sequence). Historical validity
 * alone ("this capsule was once committed") never proves current authority.
 *
 * Required 5-case matrix:
 *   1. A only                         → A valid
 *   2. A committed + B fully committed → A invalid (`lineage_superseded`), B current
 *   3. A committed + B staged, uncommitted → A remains valid (staged ≠ current)
 *   4. A committed + malformed B       → fail closed (explicit durability
 *                                        semantics: never silently ignored)
 *   5. cross-generation B              → existing owner/thread fences apply
 *                                        (`stale_owner` / `expected_thread_mismatch`)
 *
 * Plus: agent-11's M3 mutation ("lineage capsule-content digest neutered")
 * must make this suite RED, and the stale-A-after-B case must fail on the
 * PRODUCTION hydrate path (`ChatEngine.restore` →
 * `hydrateInstalledContextAuthority`), not only in a unit call.
 *
 * Ordering is durable event `seq` only — never wall-clock.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { commitCompaction } from '../agent/compactionCommit.js';
import { ChatEngine } from '../agent/chatEngine.js';
import { CONTEXT_CHECKPOINT_FILENAME } from '../agent/chatEngineParityBridge.js';
import {
  persistLiveSessionAuthority,
  resolveLiveSessionAuthority,
} from '../agent/liveSessionBridge.js';
import {
  SESSION_EVENTS_FILENAME,
  createSessionEventLog,
  recordCompactionCommitted,
  recordCompactionStarted,
  recordCompactionSummary,
  recordTurnEnded,
  recordUserSubmitted,
  serializeSessionEventLog,
  type SessionEventLog,
} from '../agent/sessionEvents.js';
import {
  THREAD_EVENT_LOG_FILENAME,
  appendThreadEvent,
  createThreadEventLog,
  rebuildProviderMessagesFromEvents,
  serializeThreadEventLog,
  startTurn,
  type ThreadEventLog,
} from '../agent/threadEventLog.js';
import { chatSessionDir, openSessionAdmissionStore } from '../cli/runsLayout.js';
import type { AdmissionStore } from '../runtime/admission.js';
import type { ObservationRefV1 } from '../evidence/observationStore.js';
import {
  prepareContextCheckpoint,
  validateColdResume,
  validateContextCheckpoint,
  type ContextCheckpointInstalledLineageV1,
  type ContextCheckpointLineageEvidenceV1,
  type ContextCheckpointOwnerV1,
  type ContextCheckpointV1,
  type LiveOperationalSourcesV1,
} from './contextCheckpoints.js';

const ALPHA = 'ALPHA_MARKER capsule A';
const BETA = 'BETA_MARKER capsule B';

const OBS_ID = `obs:${'1'.repeat(64)}`;
const PAYLOAD_SHA = '2'.repeat(64);

function observationManifest(): ObservationRefV1 {
  return {
    schema_version: 1,
    observation_id: OBS_ID,
    invocation: {
      operation_id: 'op-1',
      task_id: 'task-1',
      run_id: 'run-1',
      turn_id: 'turn-1',
      attempt_id: 'attempt-1',
    },
    payloads: [
      {
        payload_id: `sha256:${PAYLOAD_SHA}`,
        sha256: PAYLOAD_SHA,
        byte_length: 11,
        representation: 'text',
        encoding: 'utf8',
        channel: 'stdout',
        media_type: 'text/plain',
        capture_policy_version: 'p11-capture-policy-v1',
        redaction_policy_version: 'p11-redaction-policy-v1',
        capture_completeness: 'complete',
        object_key: `objects/${PAYLOAD_SHA.slice(0, 2)}/${PAYLOAD_SHA}.bin`,
      },
    ],
    execution_status: 'succeeded',
    snapshot_ref: 'snapshot-current',
    coverage_ref: 'coverage-1',
    capture_completeness: 'complete',
    permitted_principals: ['agent:main'],
    capture_policy_version: 'p11-capture-policy-v1',
    redaction_policy_version: 'p11-redaction-policy-v1',
    captured_at: '2026-09-20T00:00:00.000Z',
  };
}

function sources(): LiveOperationalSourcesV1 {
  return {
    resumed: false,
    task_contract: {
      goal: 'prove the installed context root is current',
      acceptance_clause_ids: ['clause-1'],
      contract_hash: 'contract-hash-1',
    },
    working_state: {
      current_hypothesis: 'a capsule is inert until its lineage is current',
      unresolved_failures: [],
      next_experiment: 'validate lineage currency',
    },
    workspace: {
      current_snapshot_revision: 'snapshot-current',
      capture_complete: true,
      coverage_ref: 'coverage-1',
      capture_provenance: 'current_capture',
      capture_epoch: 'capture-epoch-1',
    },
    receipts: [
      {
        receipt_id: 'receipt-1',
        identity: 'npm test',
        scope: 'unit',
        stale: false,
        bound_revision: 'snapshot-historical',
      },
    ],
    budget: {
      owner: 'task-budget-owner',
      remaining_allowance: 120_000,
      cancellation_owner: 'task-budget-owner',
    },
    pending: [{ handle_id: 'op-pending-1', kind: 'operation', state: 'pending' }],
    route: {
      compiled_request_identity: 'request-identity-1',
      tool_profile: 'chat-tools-v1',
      model_route: 'deepseek-v4-flash',
    },
    observations: [{ observation_id: OBS_ID, payload_sha256: PAYLOAD_SHA, authorized: true }],
    observation_manifest: [observationManifest()],
    legacy_observation_refs: [],
  };
}

function evidenceOf(
  threadLog: ThreadEventLog,
  sessionLog: SessionEventLog,
): ContextCheckpointLineageEvidenceV1 {
  return { threadEvents: threadLog.events, sessionEvents: sessionLog.events };
}

/** Mirrors chatEngine.currentInstalledContextLineage (install-time rule). */
function lineageFromLatestCommit(
  threadLog: ThreadEventLog,
  sessionLog: SessionEventLog,
  checkpointId: string,
): ContextCheckpointInstalledLineageV1 {
  const committed = [...sessionLog.events]
    .reverse()
    .find((event) => event.kind === 'compaction_committed');
  if (!committed || committed.kind !== 'compaction_committed') {
    return {
      checkpoint_id: checkpointId,
      compaction_event_id: null,
      compaction_commit_event_id: null,
      compaction_digest: null,
      thread_event_boundary_seq: null,
    };
  }
  const capsule = threadLog.events.find(
    (event) => event.kind === 'compaction_capsule' && event.event_id === committed.thread_event_id,
  );
  return {
    checkpoint_id: checkpointId,
    compaction_event_id: committed.thread_event_id,
    compaction_commit_event_id: committed.event_id,
    compaction_digest: committed.capsule_digest,
    thread_event_boundary_seq: capsule?.seq ?? null,
  };
}

function scenario(): { threadLog: ThreadEventLog; sessionLog: SessionEventLog; owner: ContextCheckpointOwnerV1 } {
  const threadLog = createThreadEventLog('task4-lineage-currency');
  const sessionLog = createSessionEventLog('task4-lineage-currency');
  const owner: ContextCheckpointOwnerV1 = {
    threadId: threadLog.thread_id,
    generation: 1,
    token: 'owner-token-1',
  };
  return { threadLog, sessionLog, owner };
}

function newTurn(threadLog: ThreadEventLog, task: string): string {
  return startTurn(threadLog, {
    task,
    model: 'm',
    provider: 'p',
    projectRoot: process.cwd(),
    policyPreset: 'default',
  });
}

async function commitCapsule(
  threadLog: ThreadEventLog,
  sessionLog: SessionEventLog,
  turnId: string,
  task: string,
): Promise<{ capsuleContent: string; capsuleDigest: string }> {
  const result = await commitCompaction({
    strategyMessages: [
      { role: 'system', content: 'controller policy' },
      { role: 'user', content: `continue ${task}` },
    ],
    priorConversation: [{ role: 'user', content: `task for ${task}` }],
    strategy: 'llm-summarize',
    tokensBefore: 100,
    tokensAfter: 40,
    operational: { task },
    threadLog,
    sessionLog,
    turnId,
    modelId: 'test-model',
  });
  assert.equal(result.status, 'committed');
  const capsuleContent = result.capsuleText;
  return {
    capsuleContent,
    capsuleDigest: createHash('sha256').update(capsuleContent).digest('hex'),
  };
}

function buildCheckpoint(
  checkpointId: string,
  owner: ContextCheckpointOwnerV1,
  lineage: ContextCheckpointInstalledLineageV1,
  sourcesOverride?: LiveOperationalSourcesV1,
): ContextCheckpointV1 {
  const prepared = prepareContextCheckpoint({
    checkpointId,
    owner,
    sources: sourcesOverride ?? sources(),
    installedLineage: lineage,
  });
  assert.equal(
    prepared.status,
    'prepared',
    prepared.status === 'blocked' ? prepared.reasons.join(', ') : '',
  );
  if (prepared.status !== 'prepared') throw new Error('preparation blocked');
  return prepared.checkpoint;
}

function validateFull(
  checkpoint: ContextCheckpointV1,
  owner: ContextCheckpointOwnerV1 | null,
  threadLog: ThreadEventLog,
  sessionLog: SessionEventLog,
  extra: { expectedThreadId?: string } = {},
) {
  return validateContextCheckpoint(checkpoint, {
    ...(owner ? { expectedThreadId: extra.expectedThreadId ?? owner.threadId, currentOwner: owner } : { currentOwner: null }),
    requireInstalledLineage: true,
    authorizedObservationIds: [OBS_ID],
    lineageEvidence: evidenceOf(threadLog, sessionLog),
  });
}

function resumeFull(
  checkpoint: ContextCheckpointV1,
  owner: ContextCheckpointOwnerV1 | null,
  threadLog: ThreadEventLog,
  sessionLog: SessionEventLog,
) {
  return validateColdResume({
    checkpoint,
    currentOwner: owner,
    authorizedObservationIds: [OBS_ID],
    lineageEvidence: evidenceOf(threadLog, sessionLog),
  });
}

function capsuleShown(
  messages: ReturnType<typeof rebuildProviderMessagesFromEvents>,
  marker: string,
): boolean {
  return messages.some(
    (message) => message.name === 'compaction_capsule' && (message.content ?? '').includes(marker),
  );
}

// ── Matrix case 1: A only → A valid ────────────────────────────────────────
test('matrix 1: with only capsule A committed, installed lineage A is valid', async () => {
  const { threadLog, sessionLog, owner } = scenario();
  const turnA = newTurn(threadLog, 'task A');
  await commitCapsule(threadLog, sessionLog, turnA, ALPHA);
  const cpA = buildCheckpoint('checkpoint-A', owner, lineageFromLatestCommit(threadLog, sessionLog, 'checkpoint-A'));

  const valid = validateFull(cpA, owner, threadLog, sessionLog);
  assert.equal(valid.status, 'valid', valid.reasons.join('; '));
  const resume = resumeFull(cpA, owner, threadLog, sessionLog);
  assert.equal(resume.status, 'ready', resume.reasons.join('; '));
});

// ── Matrix case 2: A committed + B fully committed → A invalid, B current ──
test('matrix 2: after B is fully committed, stale A is blocked (lineage_superseded) and B validates', async () => {
  const { threadLog, sessionLog, owner } = scenario();
  const turnA = newTurn(threadLog, 'task A');
  await commitCapsule(threadLog, sessionLog, turnA, ALPHA);

  // Checkpoint A installed while A was the latest committed compaction.
  const cpA = buildCheckpoint('checkpoint-A', owner, lineageFromLatestCommit(threadLog, sessionLog, 'checkpoint-A'));
  const beforeB = validateFull(cpA, owner, threadLog, sessionLog);
  assert.equal(beforeB.status, 'valid', 'precondition: A is valid while A is latest');

  // Capsule B later FULLY committed in the same thread/session generation.
  const turnB = newTurn(threadLog, 'task B');
  await commitCapsule(threadLog, sessionLog, turnB, BETA);
  const commits = sessionLog.events.filter((event) => event.kind === 'compaction_committed');
  assert.equal(commits.length, 2, 'two durable compaction_committed events');

  // The stale checkpoint must fail with the explicit superseded reason — the
  // ONLY reason: owner, thread, and membership fences are all clean here, so
  // currency is what refuses it.
  const staleValidate = validateFull(cpA, owner, threadLog, sessionLog);
  assert.equal(staleValidate.status, 'blocked');
  assert.deepEqual(staleValidate.reasons, ['lineage_superseded']);
  const staleResume = resumeFull(cpA, owner, threadLog, sessionLog);
  assert.equal(staleResume.status, 'blocked');
  assert.ok(staleResume.reasons.includes('lineage_superseded'), staleResume.reasons.join('; '));

  // B (lineage naming the max-seq commit) is the current root and validates.
  const cpB = buildCheckpoint('checkpoint-B', owner, lineageFromLatestCommit(threadLog, sessionLog, 'checkpoint-B'));
  const validB = validateFull(cpB, owner, threadLog, sessionLog);
  assert.equal(validB.status, 'valid', validB.reasons.join('; '));
  const resumeB = resumeFull(cpB, owner, threadLog, sessionLog);
  assert.equal(resumeB.status, 'ready', resumeB.reasons.join('; '));

  // Currency is durable seq order, never wall-clock: the latest commit has
  // the max seq and differs from A's lineage commit.
  const latest = commits.reduce((a, b) => (b.seq > a.seq ? b : a));
  assert.equal(latest.seq > commits[0]!.seq, true, 'seq strictly increases');
  assert.notEqual(latest.event_id, cpA.installed_lineage?.compaction_commit_event_id);

  // Downstream: without the (now inert) stale checkpoint, rebuild roots at B.
  const rebuilt = rebuildProviderMessagesFromEvents(threadLog, { systemPrompt: 'controller policy' });
  assert.equal(capsuleShown(rebuilt, 'BETA_MARKER'), true, 'B is the natural root');
});

// ── Matrix case 3: A committed + B staged but uncommitted → A remains valid ─
test('matrix 3: a staged-but-uncommitted capsule B does not move the current root', async () => {
  const { threadLog, sessionLog, owner } = scenario();
  const turnA = newTurn(threadLog, 'task A');
  await commitCapsule(threadLog, sessionLog, turnA, ALPHA);
  const cpA = buildCheckpoint('checkpoint-A', owner, lineageFromLatestCommit(threadLog, sessionLog, 'checkpoint-A'));

  // Stage capsule B in the thread log WITHOUT any compaction_committed event.
  const turnB = newTurn(threadLog, 'task B staged');
  appendThreadEvent(threadLog, {
    kind: 'compaction_capsule',
    turn_id: turnB,
    content: `Task: ${BETA}\nstaged, not committed`,
    preserved_tool_call_ids: [],
    ownership_generation: 2,
  });
  const commits = sessionLog.events.filter((event) => event.kind === 'compaction_committed');
  assert.equal(commits.length, 1, 'staged capsule must not create a commit event');

  const valid = validateFull(cpA, owner, threadLog, sessionLog);
  assert.equal(valid.status, 'valid', `staged ≠ current; A must remain valid — ${valid.reasons.join('; ')}`);

  // The uncommitted capsule stays inert in rebuild too.
  const rebuilt = rebuildProviderMessagesFromEvents(threadLog, {
    systemPrompt: 'controller policy',
    installedContextCheckpoint: cpA,
  });
  assert.equal(capsuleShown(rebuilt, 'ALPHA_MARKER'), true, 'committed A is the root');
  assert.equal(capsuleShown(rebuilt, 'BETA_MARKER'), false, 'uncommitted B is inert');
});

// ── Matrix case 4: A committed + malformed B → fail closed ─────────────────
//
// Durability semantics implemented: when the MAX-SEQ committed artifact is
// malformed (capsule missing, or digest disagrees with capsule content), the
// checkpoint is refused with an explicit reason and never silently falls back
// to the older valid A. An interrupted/crashed later transaction therefore
// degrades to "checkpoint inert, durable logs are the only source", never to
// "old checkpoint still fine".
test('matrix 4: a malformed latest committed B fails closed with an explicit reason', async () => {
  // (c1) dangling commit: names a thread event that does not exist.
  {
    const { threadLog, sessionLog, owner } = scenario();
    const turnA = newTurn(threadLog, 'task A');
    await commitCapsule(threadLog, sessionLog, turnA, ALPHA);
    const cpA = buildCheckpoint('checkpoint-A', owner, lineageFromLatestCommit(threadLog, sessionLog, 'checkpoint-A'));

    const turnB = newTurn(threadLog, 'task B malformed dangling');
    const bogusDigest = createHash('sha256').update('never persisted capsule').digest('hex');
    recordCompactionStarted(sessionLog, turnB, {
      operation_id: 'op-malformed-dangling',
      strategy: 'llm-summarize',
      replaces_thread_seq_start: 0,
      replaces_thread_seq_end: threadLog.nextSeq - 1,
      replaces_message_count: 1,
    });
    recordCompactionSummary(sessionLog, turnB, {
      operation_id: 'op-malformed-dangling',
      capsule_digest: bogusDigest,
      raw_observation_refs: [],
      preserved_tool_call_ids: [],
    });
    recordCompactionCommitted(sessionLog, turnB, {
      operation_id: 'op-malformed-dangling',
      thread_event_id: 'thread-event-does-not-exist',
      capsule_digest: bogusDigest,
      replaces_thread_seq_start: 0,
      replaces_thread_seq_end: threadLog.nextSeq - 1,
      replaces_message_count: 1,
      preserved_tool_call_ids: [],
    });

    const staleA = validateFull(cpA, owner, threadLog, sessionLog);
    assert.equal(staleA.status, 'blocked', 'malformed latest commit must never leave stale A valid');
    assert.deepEqual(staleA.reasons, ['lineage_not_committed'], 'explicit fail-closed reason');

    const cpBad = buildCheckpoint(
      'checkpoint-B-malformed',
      owner,
      lineageFromLatestCommit(threadLog, sessionLog, 'checkpoint-B-malformed'),
    );
    const onBad = validateFull(cpBad, owner, threadLog, sessionLog);
    assert.equal(onBad.status, 'blocked');
    assert.ok(onBad.reasons.includes('lineage_not_committed'), onBad.reasons.join('; '));
  }

  // (c2) digest mismatch: commit names a real capsule but a different digest.
  {
    const { threadLog, sessionLog, owner } = scenario();
    const turnA = newTurn(threadLog, 'task A');
    await commitCapsule(threadLog, sessionLog, turnA, ALPHA);
    const cpA = buildCheckpoint('checkpoint-A', owner, lineageFromLatestCommit(threadLog, sessionLog, 'checkpoint-A'));

    const turnB = newTurn(threadLog, 'task B malformed digest');
    const capsuleB = appendThreadEvent(threadLog, {
      kind: 'compaction_capsule',
      turn_id: turnB,
      content: `Task: ${BETA}\ndigest will not match`,
      preserved_tool_call_ids: [],
      ownership_generation: 2,
    });
    const wrongDigest = createHash('sha256').update('a different capsule body').digest('hex');
    recordCompactionStarted(sessionLog, turnB, {
      operation_id: 'op-malformed-digest',
      strategy: 'llm-summarize',
      replaces_thread_seq_start: 0,
      replaces_thread_seq_end: capsuleB.seq - 1,
      replaces_message_count: 1,
    });
    recordCompactionSummary(sessionLog, turnB, {
      operation_id: 'op-malformed-digest',
      capsule_digest: wrongDigest,
      raw_observation_refs: [],
      preserved_tool_call_ids: [],
    });
    recordCompactionCommitted(sessionLog, turnB, {
      operation_id: 'op-malformed-digest',
      thread_event_id: capsuleB.event_id,
      capsule_digest: wrongDigest,
      replaces_thread_seq_start: 0,
      replaces_thread_seq_end: capsuleB.seq - 1,
      replaces_message_count: 1,
      preserved_tool_call_ids: [],
    });

    const staleA = validateFull(cpA, owner, threadLog, sessionLog);
    assert.equal(staleA.status, 'blocked', 'digest-mismatched latest commit must never leave stale A valid');
    assert.deepEqual(staleA.reasons, ['lineage_invalid'], 'explicit fail-closed reason');
  }
});

// ── Matrix case 5: cross-generation B → existing owner/thread fences ───────
test('matrix 5: cross-generation/thread/session scoping uses the existing fences, not a duplicate rule', async () => {
  const { threadLog, sessionLog, owner } = scenario();
  const turnA = newTurn(threadLog, 'task A');
  await commitCapsule(threadLog, sessionLog, turnA, ALPHA);
  const cpA = buildCheckpoint('checkpoint-A', owner, lineageFromLatestCommit(threadLog, sessionLog, 'checkpoint-A'));

  // Capsule B committed under a later ownership generation (turn B = gen 2).
  const turnB = newTurn(threadLog, 'task B next generation');
  await commitCapsule(threadLog, sessionLog, turnB, BETA);
  const genB = threadLog.events.find(
    (event) => event.kind === 'turn_started' && event.turn_id === turnB,
  );
  assert.ok(genB && genB.kind === 'turn_started');
  assert.ok(
    (genB.ownership_generation ?? 0) > owner.generation,
    'fixture: B belongs to a later generation',
  );

  // (i) Same owner of record: currency is the rule that fires — exactly one
  // reason, computed from the durable max-seq commit, no generation logic
  // duplicated into the lineage check.
  const sameOwner = validateFull(cpA, owner, threadLog, sessionLog);
  assert.deepEqual(sameOwner.reasons, ['lineage_superseded']);

  // (ii) Bumped durable owner: the EXISTING owner fence applies.
  const bumpedOwner: ContextCheckpointOwnerV1 = {
    threadId: owner.threadId,
    generation: owner.generation + 1,
    token: 'owner-token-2',
  };
  const bumped = validateFull(cpA, bumpedOwner, threadLog, sessionLog);
  assert.equal(bumped.status, 'blocked');
  assert.ok(bumped.reasons.includes('stale_owner'), bumped.reasons.join('; '));

  // (iii) Cross-thread expectation: the EXISTING thread fence applies.
  const crossThread = validateFull(cpA, owner, threadLog, sessionLog, {
    expectedThreadId: 'some-other-thread',
  });
  assert.equal(crossThread.status, 'blocked');
  assert.ok(crossThread.reasons.includes('expected_thread_mismatch'), crossThread.reasons.join('; '));

  // (iv) Cross-session evidence (a log without A's commit): fails closed on
  // the existing existence check — currency is computed per authoritative log.
  const otherSession = createSessionEventLog('task4-other-session');
  const crossSession = validateContextCheckpoint(cpA, {
    expectedThreadId: owner.threadId,
    currentOwner: owner,
    requireInstalledLineage: true,
    authorizedObservationIds: [OBS_ID],
    lineageEvidence: evidenceOf(threadLog, otherSession),
  });
  assert.equal(crossSession.status, 'blocked');
  assert.ok(crossSession.reasons.includes('lineage_not_committed'), crossSession.reasons.join('; '));
});

// ── agent-11 M3 mutation: lineage capsule-content digest must be asserted ──
test('M3: tampered capsule content under a consistent lineage is refused (lineage_invalid)', async () => {
  const { threadLog, sessionLog, owner } = scenario();

  // Commit A is installed as the checkpoint's lineage...
  const turnA = newTurn(threadLog, 'task A for M3');
  await commitCapsule(threadLog, sessionLog, turnA, ALPHA);
  const cpA = buildCheckpoint('checkpoint-m3', owner, lineageFromLatestCommit(threadLog, sessionLog, 'checkpoint-m3'));

  // ...and commit B later supersedes it (so currency alone cannot be the
  // reason A is refused here — a content-tampered A must fail with
  // `lineage_invalid`, never with `lineage_superseded`).
  const turnB = newTurn(threadLog, 'task B for M3');
  await commitCapsule(threadLog, sessionLog, turnB, BETA);

  // Tamper ONLY the durable capsule A CONTENT in the evidence. Event ids,
  // the commit digest, and the boundary seq all stay consistent with the
  // installed lineage — so the content-digest check inside
  // validateContextCheckpointInstalledLineage is the only check that can
  // produce `lineage_invalid`. Neutering it ("digest checked against itself",
  // agent-11 M3) lets the reasons fall through to `lineage_superseded`
  // (currency fires instead) and this assertion goes RED.
  const capsuleAId = cpA.installed_lineage?.compaction_event_id;
  assert.ok(capsuleAId, 'lineage must name capsule A');
  const capsuleA = threadLog.events.find((event) => event.event_id === capsuleAId);
  assert.ok(capsuleA && capsuleA.kind === 'compaction_capsule', 'capsule A fixture');
  const tampered: ContextCheckpointLineageEvidenceV1 = {
    threadEvents: threadLog.events.map((event) =>
      event.event_id === capsuleA.event_id
        ? { ...event, content: 'TAMPERED capsule body that no longer matches the committed digest' }
        : event,
    ),
    sessionEvents: sessionLog.events,
  };
  const valid = validateContextCheckpoint(cpA, {
    requireInstalledLineage: true,
    authorizedObservationIds: [OBS_ID],
    lineageEvidence: tampered,
  });
  assert.equal(valid.status, 'blocked', 'tampered capsule content must not validate');
  assert.ok(
    valid.reasons.includes('lineage_invalid'),
    `expected lineage_invalid (content digest asserted), got: ${valid.reasons.join('; ')}`,
  );
});

// ── Production hydrate path: stale A fails on restore/hydrate, not just unit ─
interface EngineAdmissionInternals {
  admitCurrentSubmission(submissionGeneration: number, userInput: string): void;
}

function internals(engine: ChatEngine): EngineAdmissionInternals {
  return engine as unknown as EngineAdmissionInternals;
}

async function withRunsDir(fn: () => Promise<void>): Promise<void> {
  const previous = process.env['BABEL_RUNS_DIR'];
  const runsRoot = mkdtempSync(join(tmpdir(), 'babel-task4-currency-'));
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
  const root = mkdtempSync(join(tmpdir(), 'babel-task4-currency-proj-'));
  writeFileSync(join(root, 'README.md'), 'fixture repository\n', 'utf8');
  return root;
}

function requireStore(sessionId: string): AdmissionStore {
  const opened = openSessionAdmissionStore(sessionId);
  assert.equal(opened.ok, true, opened.ok ? '' : `${opened.reasonCode}: ${opened.detail}`);
  if (!opened.ok) throw new Error('store unavailable');
  return opened.store;
}

test('production hydrate: a stale historical checkpoint A fails validation after B commits', async () => {
  await withRunsDir(async () => {
    const threadId = 'r1-task4-stale-lineage-hydrate';
    const projectRoot = makeProjectRoot();
    try {
      const dir = chatSessionDir(threadId);
      mkdirSync(dir, { recursive: true });
      persistLiveSessionAuthority(
        dir,
        resolveLiveSessionAuthority({ mode: 'chat', projectRoot, task: 'task 4 currency fixture' }),
      );

      // Durable generation A: turn + capsule A committed (real commit path).
      const threadLog = createThreadEventLog(threadId);
      const sessionLog = createSessionEventLog(threadId);
      recordUserSubmitted(sessionLog, { turn_id: 'turn-1', task: 'generation A', projectRoot });
      const turnA = startTurn(threadLog, {
        task: 'generation A',
        model: 'm',
        provider: 'p',
        projectRoot,
        policyPreset: 'safe_repo',
      });
      await commitCapsule(threadLog, sessionLog, turnA, ALPHA);
      recordTurnEnded(sessionLog, { turn_id: 'turn-1', status: 'completed' });
      writeFileSync(join(dir, THREAD_EVENT_LOG_FILENAME), serializeThreadEventLog(threadLog), 'utf8');
      writeFileSync(join(dir, SESSION_EVENTS_FILENAME), serializeSessionEventLog(sessionLog), 'utf8');
      writeFileSync(join(dir, 'transcript.jsonl'), `${JSON.stringify({ role: 'user', content: 'hello' })}\n`, 'utf8');

      // Phase 1: restore (no checkpoint yet) and admit the durable owner of
      // record through the real production seam.
      const store = requireStore(threadId);
      const engine1 = await ChatEngine.restore(threadId, {
        task: 'task 4 currency fixture',
        projectRoot,
        admissionStore: store,
      });
      internals(engine1).admitCurrentSubmission(1, 'fixture command');
      const ownerRow = store.readOwner(threadId);
      assert.ok(ownerRow, 'durable owner row must exist');
      const owner: ContextCheckpointOwnerV1 = {
        threadId,
        generation: ownerRow.generation,
        token: ownerRow.token,
      };

      // Install checkpoint A (lineage naming commit A) while A is current.
      // Empty observation membership: this fixture isolates the lineage rule.
      const emptySources: LiveOperationalSourcesV1 = { ...sources(), observations: [], observation_manifest: [] };
      const cpA = buildCheckpoint(
        'cp-stale-a',
        owner,
        lineageFromLatestCommit(threadLog, sessionLog, 'cp-stale-a'),
        emptySources,
      );
      writeFileSync(join(dir, CONTEXT_CHECKPOINT_FILENAME), JSON.stringify(cpA, null, 2), 'utf8');

      // Control on the production seam: while A is latest, hydrate applies.
      const control = engine1.hydrateInstalledContextAuthority();
      assert.equal(control.applied, true, `control must apply, issues: ${control.issues.join('; ')}`);
      assert.deepEqual(control.issues, []);

      // Capsule B later FULLY committed, durably (thread + session + owner
      // state all settled — the exact state a resume after a later session
      // would see on disk).
      const turnB = startTurn(threadLog, {
        task: 'generation B',
        model: 'm',
        provider: 'p',
        projectRoot,
        policyPreset: 'safe_repo',
      });
      await commitCapsule(threadLog, sessionLog, turnB, BETA);
      writeFileSync(join(dir, THREAD_EVENT_LOG_FILENAME), serializeThreadEventLog(threadLog), 'utf8');
      writeFileSync(join(dir, SESSION_EVENTS_FILENAME), serializeSessionEventLog(sessionLog), 'utf8');
      engine1.closeAdmissionStore();

      // Phase 2: production cold resume with the stale checkpoint file A.
      const store2 = requireStore(threadId);
      const engine2 = await ChatEngine.restore(threadId, {
        task: 'task 4 currency fixture resume',
        projectRoot,
        admissionStore: store2,
      });
      try {
        const parity = engine2.getParityRuntime();
        assert.equal(
          parity.contextCheckpoint ?? null,
          null,
          'stale A must not be promoted to provider context on restore',
        );

        // Independent revalidation through the same seam: currency is the
        // ONLY blocker — owner, thread, and membership fences are all clean.
        const recheck = engine2.hydrateInstalledContextAuthority();
        assert.equal(recheck.applied, false, `stale A must fail, issues: ${recheck.issues.join('; ')}`);
        assert.deepEqual(recheck.issues, ['lineage_superseded'], recheck.issues.join('; '));

        // Durable logs remain the only source; rebuild roots at committed B.
        const msgs = rebuildProviderMessagesFromEvents(parity.eventLog, {
          systemPrompt: 'controller policy',
        });
        assert.equal(capsuleShown(msgs, 'BETA_MARKER'), true, 'committed B is the context root');
        assert.equal(capsuleShown(msgs, 'ALPHA_MARKER'), false, 'stale A must not suppress B');
      } finally {
        engine2.closeAdmissionStore();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
