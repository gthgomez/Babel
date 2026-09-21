import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  installContextCheckpoint,
  prepareContextCheckpoint,
  validateColdResume,
  validateContextCheckpoint,
  validateContextCheckpointInstalledLineage,
  type ContextCheckpointInstalledLineageV1,
  type ContextCheckpointLineageEvidenceV1,
  type ContextCheckpointOwnerV1,
  type ContextCheckpointV1,
  type LiveOperationalSourcesV1,
} from './contextCheckpoints.js';
import type { ObservationRefV1 } from '../evidence/observationStore.js';
import {
  appendThreadEvent,
  createThreadEventLog,
  rebuildProviderMessagesFromEvents,
  startTurn,
} from '../agent/threadEventLog.js';

const OWNER: ContextCheckpointOwnerV1 = {
  threadId: 'thread-installed-authority',
  generation: 4,
  token: 'owner-token-4',
};

const OBS_ID = `obs:${'1'.repeat(64)}`;
const OTHER_OBS_ID = `obs:${'9'.repeat(64)}`;
const PAYLOAD_SHA = '2'.repeat(64);
const CAPSULE_BODY = 'controller compaction capsule body';
const CAPSULE_DIGEST = createHash('sha256').update(CAPSULE_BODY).digest('hex');
const COMPACTION_EVENT_ID = 'thread-event-compaction-1';
const COMPACTION_COMMIT_EVENT_ID = 'session-event-commit-1';
const BOUNDARY_SEQ = 7;

const MATCHING_LINEAGE: ContextCheckpointInstalledLineageV1 = {
  checkpoint_id: 'checkpoint-installed-1',
  compaction_event_id: COMPACTION_EVENT_ID,
  compaction_commit_event_id: COMPACTION_COMMIT_EVENT_ID,
  compaction_digest: CAPSULE_DIGEST,
  thread_event_boundary_seq: BOUNDARY_SEQ,
};

function observationManifest(observationId: string = OBS_ID): ObservationRefV1 {
  return {
    schema_version: 1,
    observation_id: observationId,
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

function sources(overrides: Partial<LiveOperationalSourcesV1> = {}): LiveOperationalSourcesV1 {
  return {
    resumed: false,
    task_contract: {
      goal: 'prove the installed context root',
      acceptance_clause_ids: ['clause-1'],
      contract_hash: 'contract-hash-1',
    },
    working_state: {
      current_hypothesis: 'a capsule is inert until its lineage is installed',
      unresolved_failures: [],
      next_experiment: 'validate lineage evidence',
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
    observations: [
      { observation_id: OBS_ID, payload_sha256: PAYLOAD_SHA, authorized: true },
    ],
    observation_manifest: [observationManifest()],
    legacy_observation_refs: [],
    ...overrides,
  };
}

function buildCheckpoint(
  installedLineage?: ContextCheckpointInstalledLineageV1,
): ContextCheckpointV1 {
  const prepared = prepareContextCheckpoint({
    checkpointId: 'checkpoint-installed-1',
    owner: OWNER,
    sources: sources(),
    ...(installedLineage !== undefined ? { installedLineage } : {}),
  });
  if (prepared.status !== 'prepared') {
    throw new Error(`fixture failed: ${prepared.reasons.join(', ')}`);
  }
  return prepared.checkpoint;
}

function lineageEvidence(
  overrides: Partial<ContextCheckpointLineageEvidenceV1> = {},
): ContextCheckpointLineageEvidenceV1 {
  return {
    threadEvents: [
      { event_id: COMPACTION_EVENT_ID, kind: 'compaction_capsule', seq: BOUNDARY_SEQ, content: CAPSULE_BODY },
    ],
    sessionEvents: [
      {
        event_id: COMPACTION_COMMIT_EVENT_ID,
        kind: 'compaction_committed',
        thread_event_id: COMPACTION_EVENT_ID,
        capsule_digest: CAPSULE_DIGEST,
      },
    ],
    ...overrides,
  };
}

test('installed lineage is accepted only against the exact committed capsule', () => {
  const checkpoint = buildCheckpoint(MATCHING_LINEAGE);
  const valid = validateContextCheckpoint(checkpoint, {
    requireInstalledLineage: true,
    lineageEvidence: lineageEvidence(),
  });
  assert.equal(valid.status, 'valid');

  const missingCommit = validateContextCheckpoint(checkpoint, {
    requireInstalledLineage: true,
    lineageEvidence: lineageEvidence({ sessionEvents: [] }),
  });
  assert.equal(missingCommit.status, 'blocked');
  assert.ok(missingCommit.reasons.includes('lineage_not_committed'));

  const wrongDigest = validateContextCheckpoint(checkpoint, {
    requireInstalledLineage: true,
    lineageEvidence: lineageEvidence({
      sessionEvents: [
        {
          event_id: COMPACTION_COMMIT_EVENT_ID,
          kind: 'compaction_committed',
          thread_event_id: COMPACTION_EVENT_ID,
          capsule_digest: 'f'.repeat(64),
        },
      ],
    }),
  });
  assert.equal(wrongDigest.status, 'blocked');
  assert.ok(wrongDigest.reasons.includes('lineage_not_committed'));

  const wrongBoundary = validateContextCheckpoint(checkpoint, {
    requireInstalledLineage: true,
    lineageEvidence: lineageEvidence({
      threadEvents: [
        { event_id: COMPACTION_EVENT_ID, kind: 'compaction_capsule', seq: BOUNDARY_SEQ + 1, content: CAPSULE_BODY },
      ],
    }),
  });
  assert.equal(wrongBoundary.status, 'blocked');
  assert.ok(wrongBoundary.reasons.includes('lineage_invalid'));
});

test('an unproven installed lineage fails closed when evidence is omitted', () => {
  const checkpoint = buildCheckpoint(MATCHING_LINEAGE);
  const unproven = validateContextCheckpoint(checkpoint, { requireInstalledLineage: true });
  assert.equal(unproven.status, 'blocked');
  assert.ok(unproven.reasons.includes('lineage_missing'));

  // A checkpoint with no installed-lineage record at all is refused directly.
  const { installed_lineage: _omitted, ...withoutLineage } = buildCheckpoint();
  assert.deepEqual(validateContextCheckpointInstalledLineage(withoutLineage), ['lineage_missing']);
});

test('a checkpoint cannot mint observation membership by naming observations', async () => {
  const checkpoint = buildCheckpoint();

  const wrong = validateContextCheckpoint(checkpoint, { authorizedObservationIds: [OTHER_OBS_ID] });
  assert.equal(wrong.status, 'blocked');
  assert.ok(wrong.reasons.includes('observation_membership_unavailable'));

  const right = validateContextCheckpoint(checkpoint, { authorizedObservationIds: [OBS_ID] });
  assert.equal(right.status, 'valid');

  let installs = 0;
  const blocked = await installContextCheckpoint(checkpoint, {
    currentOwner: OWNER,
    authorizedObservationIds: [OTHER_OBS_ID],
    install: async () => {
      installs += 1;
    },
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(installs, 0, 'membership failure must not touch the install port');

  const installed = await installContextCheckpoint(checkpoint, {
    currentOwner: OWNER,
    authorizedObservationIds: [OBS_ID],
    install: async () => {
      installs += 1;
    },
  });
  assert.equal(installed.status, 'installed');
  assert.equal(installs, 1);
});

test('cold resume refuses unproven owner, membership, and lineage', () => {
  const checkpoint = buildCheckpoint(MATCHING_LINEAGE);
  const evidence = lineageEvidence();

  const ready = validateColdResume({
    checkpoint,
    currentOwner: OWNER,
    authorizedObservationIds: [OBS_ID],
    lineageEvidence: evidence,
  });
  assert.equal(ready.status, 'ready');

  const noOwner = validateColdResume({
    checkpoint,
    currentOwner: null,
    authorizedObservationIds: [OBS_ID],
    lineageEvidence: evidence,
  });
  assert.equal(noOwner.status, 'blocked');
  assert.ok(noOwner.reasons.includes('owner_missing'));

  const noMembership = validateColdResume({
    checkpoint,
    currentOwner: OWNER,
    lineageEvidence: evidence,
  });
  assert.equal(noMembership.status, 'blocked');
  assert.ok(
    noMembership.reasons.includes('observation_membership_unavailable') ||
      noMembership.reasons.includes('observation_manifest_incomplete'),
  );

  const wrongMembership = validateColdResume({
    checkpoint,
    currentOwner: OWNER,
    authorizedObservationIds: [OTHER_OBS_ID],
    lineageEvidence: evidence,
  });
  assert.equal(wrongMembership.status, 'blocked');

  const noEvidence = validateColdResume({
    checkpoint,
    currentOwner: OWNER,
    authorizedObservationIds: [OBS_ID],
  });
  assert.equal(noEvidence.status, 'blocked');
  assert.ok(noEvidence.reasons.includes('lineage_missing'));
});

test('an explicitly empty authorized set permits a first-turn empty manifest', () => {
  const prepared = prepareContextCheckpoint({
    checkpointId: 'checkpoint-empty',
    owner: OWNER,
    sources: sources({ observations: [], observation_manifest: [] }),
  });
  assert.equal(prepared.status, 'prepared');
  if (prepared.status !== 'prepared') return;

  const valid = validateContextCheckpoint(prepared.checkpoint, { authorizedObservationIds: [] });
  assert.equal(valid.status, 'valid');

  const invalid = validateContextCheckpoint(prepared.checkpoint, {
    authorizedObservationIds: [OBS_ID],
  });
  assert.equal(invalid.status, 'blocked');
  assert.ok(invalid.reasons.includes('observation_manifest_incomplete'));
});

test('cold resume cannot treat an omitted membership source as proven-empty', () => {
  const prepared = prepareContextCheckpoint({
    checkpointId: 'checkpoint-empty-resume',
    owner: OWNER,
    sources: sources({ observations: [], observation_manifest: [] }),
  });
  assert.equal(prepared.status, 'prepared');
  if (prepared.status !== 'prepared') return;

  const omitted = validateColdResume({ checkpoint: prepared.checkpoint, currentOwner: OWNER });
  assert.equal(omitted.status, 'blocked');
  assert.ok(omitted.reasons.includes('observation_manifest_incomplete'));

  const explicitEmpty = validateColdResume({
    checkpoint: prepared.checkpoint,
    currentOwner: OWNER,
    authorizedObservationIds: [],
  });
  assert.equal(explicitEmpty.status, 'ready');
});

test('a capsule becomes provider authority only through a matching installed lineage', () => {
  const log = createThreadEventLog('installed-authority-binding');
  const turn = startTurn(log, {
    task: 'task',
    model: 'm',
    provider: 'p',
    projectRoot: process.cwd(),
    policyPreset: 'default',
  });
  appendThreadEvent(log, {
    kind: 'compaction_capsule',
    turn_id: turn,
    ownership_generation: 1,
    content: CAPSULE_BODY,
    preserved_tool_call_ids: [],
  });
  const capsule = log.events.find((event) => event.kind === 'compaction_capsule');
  assert.ok(capsule, 'capsule fixture must be appended');
  const matchingLineage: ContextCheckpointInstalledLineageV1 = {
    checkpoint_id: 'checkpoint-installed-1',
    compaction_event_id: capsule.event_id,
    compaction_commit_event_id: COMPACTION_COMMIT_EVENT_ID,
    compaction_digest: CAPSULE_DIGEST,
    thread_event_boundary_seq: capsule.seq,
  };

  const included = rebuildProviderMessagesFromEvents(log, {
    systemPrompt: 'controller policy',
    installedContextCheckpoint: buildCheckpoint(matchingLineage),
  });
  assert.ok(
    included.some((message) => message.name === 'compaction_capsule' && message.content === CAPSULE_BODY),
    'a capsule named by the installed lineage is the context root',
  );

  const wrongDigest = rebuildProviderMessagesFromEvents(log, {
    systemPrompt: 'controller policy',
    installedContextCheckpoint: buildCheckpoint({ ...matchingLineage, compaction_digest: 'f'.repeat(64) }),
  });
  assert.equal(
    wrongDigest.some((message) => message.name === 'compaction_capsule'),
    false,
    'a digest mismatch must not expose the capsule',
  );

  const wrongEvent = rebuildProviderMessagesFromEvents(log, {
    systemPrompt: 'controller policy',
    installedContextCheckpoint: buildCheckpoint({ ...matchingLineage, compaction_event_id: 'not-the-event' }),
  });
  assert.equal(
    wrongEvent.some((message) => message.name === 'compaction_capsule'),
    false,
    'an event-id mismatch must not expose the capsule',
  );
});
