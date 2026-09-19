import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sanitizeSpillId } from '../agent/codingLoop/observationCompiler.js';
import {
  OBSERVATION_CAPTURE_POLICY_DEFAULTS_V1,
  captureApprovedObservation,
  createInMemoryObservationBudget,
  createNodeObservationFs,
  deriveObservationId,
  listStoredPayloadObjects,
  resolveObservation,
  type CaptureApprovedObservationInputV1,
  type ObservationInvocationV1,
  type ObservationStorageContextV1,
  type ObservationStorageFsV1,
} from './observationStore.js';

const FIXED_CLOCK = (): string => '2026-09-19T00:00:00.000Z';

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `babel-obs-${label}-`));
  mkdirSync(root, { recursive: true });
  return root;
}

function storage(root: string, overrides: Partial<ObservationStorageContextV1> = {}): ObservationStorageContextV1 {
  return { storage_root: root, clock: FIXED_CLOCK, ...overrides };
}

function invocation(overrides: Partial<ObservationInvocationV1> = {}): ObservationInvocationV1 {
  return {
    operation_id: 'op-1',
    task_id: 'task-1',
    run_id: 'run-1',
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<CaptureApprovedObservationInputV1> = {},
): CaptureApprovedObservationInputV1 {
  return {
    invocation: invocation(),
    sections: [{ channel: 'stdout', content: 'hello world' }],
    execution_status: 'succeeded',
    permitted_principals: ['agent:main'],
    data_policy: {
      approved: true,
      policy_version: 'policy-v1',
      redaction_policy_version: 'redaction-v1',
    },
    ...overrides,
  };
}

test('identical payload bytes dedupe while distinct invocations stay distinct', () => {
  const root = tempRoot('dedupe');
  try {
    const first = captureApprovedObservation(
      baseInput({ invocation: invocation({ operation_id: 'op-a', run_id: 'run-a' }) }),
      storage(root),
    );
    assert.equal(first.status, 'captured');
    const second = captureApprovedObservation(
      baseInput({ invocation: invocation({ operation_id: 'op-b', run_id: 'run-b' }) }),
      storage(root),
    );
    assert.equal(second.status, 'captured');
    if (first.status !== 'captured' || second.status !== 'captured') return;

    assert.notEqual(first.observation.observation_id, second.observation.observation_id);
    assert.equal(
      first.observation.payloads[0]!.payload_id,
      second.observation.payloads[0]!.payload_id,
    );
    assert.deepEqual(second.duplicate_payloads, [first.observation.payloads[0]!.payload_id]);
    assert.equal(listStoredPayloadObjects(storage(root)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retrying the same invocation is identity-stable and idempotent', () => {
  const root = tempRoot('retry');
  try {
    const input = baseInput({ invocation: invocation({ operation_id: 'op-retry', attempt_id: 'attempt-1' }) });
    const first = captureApprovedObservation(input, storage(root));
    const second = captureApprovedObservation(input, storage(root));
    assert.equal(first.status, 'captured');
    assert.equal(second.status, 'captured');
    if (first.status !== 'captured' || second.status !== 'captured') return;
    assert.equal(first.observation.observation_id, second.observation.observation_id);
    assert.equal(deriveObservationId(input.invocation), first.observation.observation_id);
    assert.equal(listStoredPayloadObjects(storage(root)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retry identity is stable under a real advancing clock', () => {
  const root = tempRoot('retry-clock');
  try {
    let tick = 0;
    const advancingClock = (): string =>
      new Date(Date.UTC(2026, 8, 19, 0, 0, tick++)).toISOString();
    const input = baseInput({
      invocation: invocation({ operation_id: 'op-clock', attempt_id: 'attempt-1' }),
    });
    const first = captureApprovedObservation(input, {
      storage_root: root,
      clock: advancingClock,
    });
    const second = captureApprovedObservation(input, {
      storage_root: root,
      clock: advancingClock,
    });
    assert.equal(first.status, 'captured');
    assert.equal(second.status, 'captured');
    if (first.status !== 'captured' || second.status !== 'captured') return;
    assert.equal(first.observation.observation_id, second.observation.observation_id);
    // The retry keeps the original identity; it is not degraded for its timestamp.
    assert.equal(second.observation.captured_at, first.observation.captured_at);
    assert.equal(listStoredPayloadObjects({ storage_root: root, clock: advancingClock }).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-capturing already-stored bytes is not blocked by a full budget', () => {
  const root = tempRoot('dedupe-budget');
  try {
    const content = 'dedupe-under-pressure';
    const byteLength = Buffer.byteLength(content, 'utf8');
    const policy = { max_run_bytes: byteLength, max_total_bytes: byteLength };
    const first = captureApprovedObservation(
      baseInput({ sections: [{ channel: 'stdout', content }] }),
      storage(root, { policy }),
    );
    assert.equal(first.status, 'captured');
    // Budget is now exactly full for this run and total; a duplicate capture
    // writes zero new bytes and must still succeed via dedupe.
    const second = captureApprovedObservation(
      baseInput({ sections: [{ channel: 'stdout', content }] }),
      storage(root, { policy }),
    );
    assert.equal(second.status, 'captured');
    if (second.status !== 'captured') return;
    assert.deepEqual(second.duplicate_payloads.length, 1);
    assert.equal(listStoredPayloadObjects(storage(root)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('control: legacy spill path aliases a/b and a_b; the store keeps them distinct', () => {
  const controlDir = tempRoot('control-spill');
  const storeDir = tempRoot('control-store');
  try {
    // Control path: the old sanitized filename aliases both ids and a second
    // non-exclusive writeFileSync overwrites the first record.
    assert.equal(sanitizeSpillId('a/b'), sanitizeSpillId('a_b'));
    const legacyName = `tool-output-${sanitizeSpillId('call/a/b')}.log`;
    const legacyPath = join(controlDir, legacyName);
    writeFileSync(legacyPath, 'first-record');
    writeFileSync(legacyPath, 'second-record');
    assert.equal(readFileSync(legacyPath, 'utf8'), 'second-record');
    assert.notEqual(sanitizeSpillId('call-1'), sanitizeSpillId('call-2'));

    // Candidate path: invocation-derived ids do not alias and both remain
    // retrievable with their original bytes.
    const firstInput = baseInput({
      invocation: invocation({ operation_id: 'a/b' }),
      sections: [{ channel: 'stdout', content: 'first-record' }],
    });
    const secondInput = baseInput({
      invocation: invocation({ operation_id: 'a_b' }),
      sections: [{ channel: 'stdout', content: 'second-record' }],
    });
    const first = captureApprovedObservation(firstInput, storage(storeDir));
    const second = captureApprovedObservation(secondInput, storage(storeDir));
    assert.equal(first.status, 'captured');
    assert.equal(second.status, 'captured');
    if (first.status !== 'captured' || second.status !== 'captured') return;
    assert.notEqual(first.observation.observation_id, second.observation.observation_id);
    assert.equal(listStoredPayloadObjects(storage(storeDir)).length, 2);

    const caller = {
      principal_id: 'agent:main',
      authorized_observation_ids: [
        first.observation.observation_id,
        second.observation.observation_id,
      ],
    };
    const readFirst = resolveObservation(first.observation.observation_id, caller, storage(storeDir));
    const readSecond = resolveObservation(second.observation.observation_id, caller, storage(storeDir));
    assert.equal(readFirst.status, 'resolved');
    assert.equal(readSecond.status, 'resolved');
  } finally {
    rmSync(controlDir, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});

test('invalid invocation identity blocks capture', () => {
  const root = tempRoot('invalid-invocation');
  try {
    const result = captureApprovedObservation(
      baseInput({ invocation: invocation({ operation_id: '   ' }) }),
      storage(root),
    );
    assert.equal(result.status, 'blocked');
    if (result.status === 'blocked') assert.equal(result.policy, 'invalid_invocation');
    assert.equal(listStoredPayloadObjects(storage(root)).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('credential denial on stdout is not archived either', () => {
  const root = tempRoot('deny-stdout');
  try {
    const result = captureApprovedObservation(
      baseInput({
        sections: [{ channel: 'stdout', content: 'DENY_CREDENTIAL_READ .env contents' }],
      }),
      storage(root),
    );
    assert.equal(result.status, 'blocked');
    if (result.status === 'blocked') assert.equal(result.policy, 'data_policy');
    assert.equal(listStoredPayloadObjects(storage(root)).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sanitization collisions, long ids and unicode ids never alias', () => {
  const ids = ['a/b', 'a_b', 'a b', '../../etc/passwd', 'x'.repeat(900), '🙂/子', '🙂_子'];
  const derived = ids.map((operation_id) =>
    deriveObservationId(invocation({ operation_id, run_id: 'run-collide' })),
  );
  assert.equal(new Set(derived).size, ids.length);
  for (const id of derived) {
    assert.match(id, /^obs:[0-9a-f]{64}$/);
    assert.ok(!id.includes('/'));
  }

  const root = tempRoot('collide');
  try {
    for (const operation_id of ids) {
      const result = captureApprovedObservation(
        baseInput({ invocation: invocation({ operation_id, run_id: 'run-collide' }) }),
        storage(root),
      );
      assert.equal(result.status, 'captured');
    }
    assert.equal(new Set(listStoredPayloadObjects(storage(root))).size, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('data policy denial writes nothing and never archives denied contents', () => {
  const root = tempRoot('policy');
  try {
    const denied = captureApprovedObservation(
      baseInput({
        data_policy: {
          approved: false,
          policy_version: 'policy-v1',
          redaction_policy_version: 'redaction-v1',
          reason: 'denied by policy',
        },
      }),
      storage(root),
    );
    assert.equal(denied.status, 'blocked');
    if (denied.status === 'blocked') assert.equal(denied.policy, 'data_policy');
    assert.equal(listStoredPayloadObjects(storage(root)).length, 0);

    const credential = captureApprovedObservation(
      baseInput({
        sections: [
          { channel: 'stderr', content: '[AUTONOMY_DENIED:CLASS_D] credential store .env' },
        ],
      }),
      storage(root),
    );
    assert.equal(credential.status, 'blocked');
    if (credential.status === 'blocked') assert.equal(credential.policy, 'data_policy');
    assert.equal(listStoredPayloadObjects(storage(root)).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('per-object limit blocks without writing', () => {
  const root = tempRoot('object-limit');
  try {
    const result = captureApprovedObservation(
      baseInput({ sections: [{ channel: 'stdout', content: 'x'.repeat(64) }] }),
      storage(root, { policy: { max_object_bytes: 16 } }),
    );
    assert.equal(result.status, 'blocked');
    if (result.status === 'blocked') assert.equal(result.policy, 'storage_limit');
    assert.equal(listStoredPayloadObjects(storage(root)).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('per-run and total limits block and report storage', () => {
  const root = tempRoot('budget');
  try {
    const runLimited = captureApprovedObservation(
      baseInput({ sections: [{ channel: 'stdout', content: 'y'.repeat(32) }] }),
      storage(root, {
        policy: { max_run_bytes: 8 },
        budget: createInMemoryObservationBudget({ run_bytes: 4, total_bytes: 4 }),
      }),
    );
    assert.equal(runLimited.status, 'blocked');
    if (runLimited.status === 'blocked') assert.equal(runLimited.policy, 'storage_limit');

    const totalLimited = captureApprovedObservation(
      baseInput({ sections: [{ channel: 'stdout', content: 'z'.repeat(32) }] }),
      storage(root, {
        policy: { max_total_bytes: 8 },
        budget: createInMemoryObservationBudget({ run_bytes: 0, total_bytes: 4 }),
      }),
    );
    assert.equal(totalLimited.status, 'blocked');
    if (totalLimited.status === 'blocked') assert.equal(totalLimited.policy, 'storage_limit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fault after a successful payload write retains the previous approved observation', () => {
  const root = tempRoot('fault-ref');
  try {
    const previous = captureApprovedObservation(baseInput(), storage(root));
    assert.equal(previous.status, 'captured');
    if (previous.status !== 'captured') return;

    const base = createNodeObservationFs();
    const flaky: ObservationStorageFsV1 = {
      ...base,
      writeFileExclusive(path, bytes, mode) {
        if (path.includes('/refs/')) {
          const error = new Error('injected EACCES') as Error & { code: string };
          error.code = 'EACCES';
          throw error;
        }
        base.writeFileExclusive(path, bytes, mode);
      },
    };
    const result = captureApprovedObservation(
      baseInput({
        invocation: invocation({ operation_id: 'op-second' }),
        sections: [{ channel: 'stdout', content: 'second output' }],
        previous_observation: previous.observation,
      }),
      storage(root, { fs: flaky }),
    );
    assert.equal(result.status, 'evidence_degraded');
    if (result.status !== 'evidence_degraded') return;
    assert.equal(result.retained_observation?.observation_id, previous.observation.observation_id);
    assert.equal(result.durable_observation, null);
    assert.equal(result.effect_replay_authorized, false);
    assert.match(result.reason, /EACCES/);
    // A completed effect is never replayed by a failed archive.
    assert.equal(existsSync(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ENOSPC on payload write degrades and never replays the effect', () => {
  const root = tempRoot('enospc');
  try {
    const base = createNodeObservationFs();
    const full: ObservationStorageFsV1 = {
      ...base,
      writeFileExclusive(path, bytes, mode) {
        if (path.includes('/objects/')) {
          const error = new Error('injected ENOSPC') as Error & { code: string };
          error.code = 'ENOSPC';
          throw error;
        }
        base.writeFileExclusive(path, bytes, mode);
      },
    };
    const result = captureApprovedObservation(baseInput(), storage(root, { fs: full }));
    assert.equal(result.status, 'evidence_degraded');
    if (result.status !== 'evidence_degraded') return;
    assert.equal(result.retained_observation, null);
    assert.equal(result.durable_observation, null);
    assert.match(result.reason, /ENOSPC|storage limit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing object with mismatching bytes fails integrity and is left untouched', () => {
  const root = tempRoot('integrity');
  try {
    const content = 'trusted bytes';
    const sha = createHash('sha256').update(content, 'utf8').digest('hex');
    const objectPath = join(root, 'objects', sha.slice(0, 2), `${sha}.bin`);
    mkdirSync(join(root, 'objects', sha.slice(0, 2)), { recursive: true });
    const tampered = 'Z'.repeat(content.length);
    writeFileSync(objectPath, tampered, 'utf8');

    const result = captureApprovedObservation(
      baseInput({ sections: [{ channel: 'stdout', content }] }),
      storage(root),
    );
    assert.equal(result.status, 'evidence_degraded');
    if (result.status === 'evidence_degraded') assert.match(result.reason, /hash mismatch/);
    assert.equal(readFileSync(objectPath, 'utf8'), tampered);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ancestor and root symlinks are rejected, not advertised as containment', () => {
  const root = tempRoot('symlink');
  const outside = tempRoot('symlink-outside');
  try {
    symlinkSync(outside, join(root, 'objects'));
    const throughAncestor = captureApprovedObservation(baseInput(), storage(root));
    assert.equal(throughAncestor.status, 'blocked');
    if (throughAncestor.status === 'blocked') assert.equal(throughAncestor.policy, 'containment');

    const realRoot = tempRoot('symlink-real');
    const linkedRoot = join(realRoot, 'link');
    symlinkSync(root, linkedRoot);
    const linked = captureApprovedObservation(baseInput(), storage(linkedRoot));
    assert.equal(linked.status, 'blocked');
    if (linked.status === 'blocked') assert.equal(linked.policy, 'containment');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('relative storage root fails as an unsupported guarantee', () => {
  const result = captureApprovedObservation(baseInput(), {
    storage_root: 'relative/root',
    clock: FIXED_CLOCK,
  });
  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') assert.equal(result.policy, 'unsupported_guarantee');
});

test('policy defaults remain explicit and bounded', () => {
  assert.equal(OBSERVATION_CAPTURE_POLICY_DEFAULTS_V1.max_object_bytes > 0, true);
  assert.equal(
    OBSERVATION_CAPTURE_POLICY_DEFAULTS_V1.max_run_bytes >=
      OBSERVATION_CAPTURE_POLICY_DEFAULTS_V1.max_object_bytes,
    true,
  );
  assert.equal(
    OBSERVATION_CAPTURE_POLICY_DEFAULTS_V1.max_total_bytes >=
      OBSERVATION_CAPTURE_POLICY_DEFAULTS_V1.max_run_bytes,
    true,
  );
});
