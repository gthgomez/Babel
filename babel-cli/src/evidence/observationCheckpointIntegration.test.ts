import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  captureApprovedObservation,
  resolveObservation,
  type CaptureApprovedObservationInputV1,
  type ObservationStorageContextV1,
} from './observationStore.js';
import {
  installContextCheckpoint,
  prepareContextCheckpoint,
  type ContextCheckpointOwnerV1,
  type LiveOperationalSourcesV1,
} from '../runtime/contextCheckpoints.js';

const OWNER: ContextCheckpointOwnerV1 = {
  threadId: 'thread-observation-integration',
  generation: 7,
  token: 'owner-token-7',
};

function storage(root: string): ObservationStorageContextV1 {
  return {
    storage_root: root,
    clock: () => '2026-09-20T00:00:00.000Z',
    policy: { durability: 'none' },
  };
}

function captureInput(): CaptureApprovedObservationInputV1 {
  return {
    invocation: {
      operation_id: 'op-observation-integration',
      task_id: 'task-observation-integration',
      run_id: 'run-observation-integration',
      turn_id: 'turn-observation-integration',
      attempt_id: 'attempt-1',
    },
    sections: [{ channel: 'stdout', content: 'durable observation bytes' }],
    execution_status: 'succeeded',
    permitted_principals: ['agent:main'],
    data_policy: {
      approved: true,
      policy_version: 'policy-v1',
      redaction_policy_version: 'redaction-v1',
    },
    snapshot_ref: 'snapshot-observation-integration',
    coverage_ref: 'coverage-observation-integration',
  };
}

function sourcesFor(
  observation: NonNullable<Extract<ReturnType<typeof captureApprovedObservation>, { status: 'captured' }>['observation']>,
  includeManifest: boolean,
): LiveOperationalSourcesV1 {
  return {
    resumed: false,
    task_contract: {
      goal: 'retain exact observations',
      acceptance_clause_ids: ['observation-manifest'],
      contract_hash: 'contract-observation-integration',
    },
    working_state: {
      current_hypothesis: 'the durable observation ref is complete',
      unresolved_failures: [],
      next_experiment: 'install through the existing checkpoint transaction',
    },
    workspace: {
      current_snapshot_revision: 'snapshot-observation-integration',
      capture_complete: true,
      coverage_ref: 'coverage-observation-integration',
      capture_provenance: 'current_capture',
      capture_epoch: 'capture-observation-integration',
    },
    receipts: [
      {
        receipt_id: 'receipt-observation-integration',
        identity: 'focused-test',
        scope: 'observation-store',
        stale: false,
        bound_revision: 'snapshot-observation-integration',
      },
    ],
    budget: {
      owner: 'task-budget-observation-integration',
      remaining_allowance: 10_000,
      cancellation_owner: 'task-budget-observation-integration',
    },
    pending: [],
    route: {
      compiled_request_identity: 'request-observation-integration',
      tool_profile: 'chat-tools-v1',
      model_route: 'test-model',
    },
    observations: [
      {
        observation_id: observation.observation_id,
        payload_sha256: observation.payloads[0]!.sha256,
        authorized: true,
      },
    ],
    ...(includeManifest ? { observation_manifest: [observation] } : {}),
    legacy_observation_refs: [observation.observation_id],
  };
}

test('A11a capture supplies the complete manifest used by P11 install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-p11-observation-checkpoint-'));
  try {
    const captured = captureApprovedObservation(captureInput(), storage(root));
    assert.equal(captured.status, 'captured');
    if (captured.status !== 'captured') return;

    const resolved = resolveObservation(
      captured.observation.observation_id,
      {
        principal_id: 'agent:main',
        authorized_observation_ids: [captured.observation.observation_id],
      },
      storage(root),
    );
    assert.equal(resolved.status, 'resolved');

    const prepared = prepareContextCheckpoint({
      checkpointId: 'checkpoint-observation-integration',
      owner: OWNER,
      sources: sourcesFor(captured.observation, true),
    });
    assert.equal(prepared.status, 'prepared');
    if (prepared.status !== 'prepared') return;
    assert.deepEqual(
      prepared.checkpoint.observation_manifest[0],
      captured.observation,
    );

    let commits = 0;
    const installed = await installContextCheckpoint(prepared, {
      currentOwner: OWNER,
      install: async (checkpoint) => {
        commits += 1;
        assert.equal(checkpoint.observation_manifest[0]?.observation_id, captured.observation.observation_id);
      },
    });
    assert.equal(installed.status, 'installed');
    assert.equal(commits, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A11a id-only observation summaries cannot authorize P11 preparation', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-p11-observation-summary-'));
  try {
    const captured = captureApprovedObservation(captureInput(), storage(root));
    assert.equal(captured.status, 'captured');
    if (captured.status !== 'captured') return;

    const prepared = prepareContextCheckpoint({
      checkpointId: 'checkpoint-observation-summary',
      owner: OWNER,
      sources: sourcesFor(captured.observation, false),
    });
    assert.equal(prepared.status, 'blocked');
    if (prepared.status === 'blocked') {
      assert.ok(prepared.reasons.includes('population_incomplete'));
      assert.ok(prepared.reasons.includes('observation_manifest_incomplete'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
