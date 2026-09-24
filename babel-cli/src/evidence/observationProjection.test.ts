import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson } from '../acceptance/canonical.js';
import {
  projectObservations,
  type ObservationRefV1,
  type ProjectionSnapshotV1,
} from './observationStore.js';

function observation(observationId: string, byteLength: number): ObservationRefV1 {
  return {
    schema_version: 1,
    observation_id: observationId,
    invocation: {
      operation_id: `op-${observationId}`,
      task_id: 'task-1',
      run_id: 'run-1',
    },
    payloads: [
      {
        payload_id: `sha256:${observationId.slice(4)}`,
        sha256: observationId.slice(4),
        byte_length: byteLength,
        representation: 'text',
        encoding: 'utf8',
        channel: 'stdout',
        media_type: 'text/plain',
        capture_policy_version: 'policy-v1',
        redaction_policy_version: 'redaction-v1',
        capture_completeness: 'complete',
        object_key: `objects/${observationId.slice(4, 6)}/${observationId.slice(4)}.bin`,
      },
    ],
    execution_status: 'succeeded',
    capture_completeness: 'complete',
    permitted_principals: ['agent:main'],
    capture_policy_version: 'policy-v1',
    redaction_policy_version: 'redaction-v1',
    captured_at: '2026-09-19T00:00:00.000Z',
  };
}

function id(seed: string): string {
  const hex = `${seed}${'a'.repeat(64 - seed.length)}`;
  return `obs:${hex.slice(0, 64)}`;
}

function snapshot(overrides: Partial<ProjectionSnapshotV1> = {}): ProjectionSnapshotV1 {
  return {
    schema_version: 1,
    policy_version: 'projection-policy-v1',
    context_epoch: 7,
    logical_request_id: 'request-1',
    observation_ref_set: [],
    exposure_state: {},
    budget_bytes: 4096,
    ...overrides,
  };
}

test('projection is pure and deterministic with no input mutation', () => {
  const history = [observation(id('1'), 10), observation(id('2'), 20)];
  const inputSnapshot = snapshot({ observation_ref_set: [id('2'), id('1')] });
  const before = canonicalJson({ history, inputSnapshot });
  const options = { available_observation_ids: [id('1'), id('2')] };

  const first = projectObservations(history, inputSnapshot, options);
  const second = projectObservations(history, inputSnapshot, options);

  assert.deepEqual(first, second);
  assert.equal(first.mutated, false);
  assert.equal(canonicalJson({ history, inputSnapshot }), before);
  // Deterministic order is independent of the requested array order.
  assert.deepEqual(
    first.selected.map((item) => item.observation_id),
    [id('1'), id('2')],
  );
});

test('budget omission is deterministic and reported, not silent', () => {
  const history = [observation(id('1'), 10), observation(id('2'), 10)];
  const result = projectObservations(
    history,
    snapshot({ observation_ref_set: [id('1'), id('2')], budget_bytes: 15 }),
    { available_observation_ids: [id('1'), id('2')] },
  );
  assert.deepEqual(
    result.selected.map((item) => item.observation_id),
    [id('1')],
  );
  assert.deepEqual(result.omitted, [{ observation_id: id('2'), reason: 'budget_exceeded' }]);
  assert.equal(result.total_bytes, 10);
});

test('unavailable and unknown refs are unresolved, never silently omitted', () => {
  const history = [observation(id('1'), 10)];
  const result = projectObservations(
    history,
    snapshot({ observation_ref_set: [id('1'), id('2')] }),
    { available_observation_ids: [] },
  );
  assert.equal(result.selected.length, 0);
  assert.deepEqual(result.unresolved, [
    { observation_id: id('1'), reason: 'unavailable' },
    { observation_id: id('2'), reason: 'unknown_history' },
  ]);
  assert.equal(result.omitted.length, 0);
});

test('already-exposed refs are omitted without re-exposing', () => {
  const history = [observation(id('1'), 10), observation(id('2'), 10)];
  const result = projectObservations(
    history,
    snapshot({
      observation_ref_set: [id('1'), id('2')],
      exposure_state: { [id('1')]: 'exposed', [id('2')]: 'unexposed' },
    }),
    { available_observation_ids: [id('1'), id('2')] },
  );
  assert.deepEqual(
    result.selected.map((item) => item.observation_id),
    [id('2')],
  );
  assert.deepEqual(result.omitted, [{ observation_id: id('1'), reason: 'already_exposed' }]);
});

test('request fingerprint is stable for retries and changes with the snapshot', () => {
  const history = [observation(id('1'), 10)];
  const options = { available_observation_ids: [id('1')] };
  const base = snapshot({ observation_ref_set: [id('1')] });
  const retry = projectObservations(history, base, options);
  const retryAgain = projectObservations(history, base, options);
  assert.equal(retry.request_fingerprint, retryAgain.request_fingerprint);

  const aged = projectObservations(
    history,
    snapshot({ observation_ref_set: [id('1')], context_epoch: 8 }),
    options,
  );
  assert.notEqual(retry.request_fingerprint, aged.request_fingerprint);

  // A budget change alters the projected selection and therefore the fingerprint.
  const budgetChanged = projectObservations(
    history,
    snapshot({ observation_ref_set: [id('1')], budget_bytes: 1 }),
    options,
  );
  assert.notEqual(retry.request_fingerprint, budgetChanged.request_fingerprint);
});
