import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_CHECKPOINT_INSTALL_BLOCKED_ON,
  buildRetentionOracleFixtureV1,
  checkpointPopulationAllowsInstall,
  evaluateRetentionOracle,
  mapCheckpointRequiredState,
  prepareContextCheckpoint,
  validateColdResume,
  validateContextCheckpoint,
  installContextCheckpoint,
  type LiveOperationalSourcesV1,
  type ContextCheckpointOwnerV1,
  type RetentionOracleInputV1,
} from './contextCheckpoints.js';
import type { ObservationRefV1 } from '../evidence/observationStore.js';

const OWNER: ContextCheckpointOwnerV1 = {
  threadId: 'thread-p11',
  generation: 4,
  token: 'owner-token-4',
};

function observationManifest(
  observation_id: string = `obs:${'1'.repeat(64)}`,
  payloadSha256: string = '2'.repeat(64),
): ObservationRefV1 {
  return {
    schema_version: 1,
    observation_id,
    invocation: {
      operation_id: 'op-1',
      task_id: 'task-1',
      run_id: 'run-1',
      turn_id: 'turn-1',
      attempt_id: 'attempt-1',
    },
    payloads: [
      {
        payload_id: `sha256:${payloadSha256}`,
        sha256: payloadSha256,
        byte_length: 11,
        representation: 'text',
        encoding: 'utf8',
        channel: 'stdout',
        media_type: 'text/plain',
        capture_policy_version: 'p11-capture-policy-v1',
        redaction_policy_version: 'p11-redaction-policy-v1',
        capture_completeness: 'complete',
        object_key: `objects/${payloadSha256.slice(0, 2)}/${payloadSha256}.bin`,
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

function completeSources(
  overrides: Partial<LiveOperationalSourcesV1> = {},
): LiveOperationalSourcesV1 {
  return {
    resumed: false,
    task_contract: {
      goal: 'ship P11 checkpoint helpers',
      acceptance_clause_ids: ['clause-1'],
      contract_hash: 'contract-hash-1',
    },
    working_state: {
      current_hypothesis: 'payload/ref separation is sound',
      unresolved_failures: ['typecheck pending'],
      next_experiment: 'run focused tests',
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
      {
        observation_id: `obs:${'1'.repeat(64)}`,
        payload_sha256: '2'.repeat(64),
        authorized: true,
      },
    ],
    observation_manifest: [observationManifest()],
    legacy_observation_refs: ['obs:deadbeef'],
    ...overrides,
  };
}

test('complete live sources map to a populated contract ready for install', () => {
  const population = mapCheckpointRequiredState(completeSources());
  assert.equal(population.status, 'populated');
  assert.equal(population.errors.length, 0);
  assert.equal(population.workspace_revision_current, true);
  assert.equal(population.install_authorized, true);
  assert.deepEqual(population.installation_blocked_on, []);
  assert.deepEqual(population.installation_blocked_on, [...CONTEXT_CHECKPOINT_INSTALL_BLOCKED_ON]);
  assert.equal(population.rows.length, 8);
  assert.equal(population.rows.every((row) => row.present), true);
  assert.equal(checkpointPopulationAllowsInstall(population), true);
});

test('a missing frozen task contract blocks rather than deriving authority from text', () => {
  const population = mapCheckpointRequiredState(completeSources({ task_contract: null }));
  assert.equal(population.status, 'blocked');
  assert.ok(population.errors.some((error) => error.startsWith('accepted_goal')));
  assert.equal(checkpointPopulationAllowsInstall(population), false);
});

test('prepares a detached checkpoint with a complete observation manifest', () => {
  const prepared = prepareContextCheckpoint({
    checkpointId: 'checkpoint-1',
    owner: OWNER,
    sources: completeSources(),
    now: () => '2026-09-20T01:00:00.000Z',
  });
  assert.equal(prepared.status, 'prepared');
  if (prepared.status !== 'prepared') return;
  assert.equal(prepared.checkpoint.schema_version, 1);
  assert.equal(prepared.checkpoint.checkpointId, 'checkpoint-1');
  assert.equal(prepared.checkpoint.threadId, OWNER.threadId);
  assert.equal(prepared.checkpoint.generation, OWNER.generation);
  assert.equal(prepared.checkpoint.owner.token, OWNER.token);
  assert.equal(prepared.checkpoint.observation_manifest.length, 1);
  assert.match(prepared.checkpoint.observation_manifest_digest, /^[0-9a-f]{64}$/);
  assert.equal(prepared.checkpoint.population.install_authorized, true);
});

test('preparation rejects an incomplete observation manifest', () => {
  const prepared = prepareContextCheckpoint({
    checkpointId: 'checkpoint-incomplete',
    owner: OWNER,
    sources: completeSources({ observation_manifest: [] }),
  });
  assert.equal(prepared.status, 'blocked');
  if (prepared.status === 'blocked') {
    assert.ok(prepared.reasons.includes('observation_manifest_incomplete'));
  }
});

test('checkpoint validation fences a stale owner generation', () => {
  const prepared = prepareContextCheckpoint({
    checkpointId: 'checkpoint-fence',
    owner: OWNER,
    sources: completeSources(),
  });
  assert.equal(prepared.status, 'prepared');
  if (prepared.status !== 'prepared') return;

  const current = validateContextCheckpoint(prepared.checkpoint, {
    currentOwner: OWNER,
  });
  assert.equal(current.status, 'valid');

  const stale = validateContextCheckpoint(prepared.checkpoint, {
    currentOwner: { ...OWNER, generation: OWNER.generation + 1, token: 'owner-token-5' },
  });
  assert.equal(stale.status, 'blocked');
  assert.ok(stale.reasons.includes('stale_owner'));
});

test('install commits once only after the owner fence passes', async () => {
  const prepared = prepareContextCheckpoint({
    checkpointId: 'checkpoint-install',
    owner: OWNER,
    sources: completeSources(),
  });
  assert.equal(prepared.status, 'prepared');
  if (prepared.status !== 'prepared') return;

  let commits = 0;
  const installed = await installContextCheckpoint(prepared, {
    currentOwner: OWNER,
    install: async (checkpoint, owner) => {
      commits += 1;
      assert.equal(checkpoint.checkpointId, 'checkpoint-install');
      assert.deepEqual(owner, OWNER);
    },
  });
  assert.equal(installed.status, 'installed');
  assert.equal(commits, 1);

  const blocked = await installContextCheckpoint(prepared, {
    currentOwner: { ...OWNER, generation: OWNER.generation + 1, token: 'owner-token-5' },
    install: async () => {
      commits += 1;
    },
  });
  assert.equal(blocked.status, 'blocked');
  assert.ok(blocked.reasons.includes('stale_owner'));
  assert.equal(commits, 1);
});

test('cold resume rejects a tampered manifest and stale owner', () => {
  const prepared = prepareContextCheckpoint({
    checkpointId: 'checkpoint-resume',
    owner: OWNER,
    sources: completeSources(),
  });
  assert.equal(prepared.status, 'prepared');
  if (prepared.status !== 'prepared') return;

  const tampered = {
    ...prepared.checkpoint,
    observation_manifest: prepared.checkpoint.observation_manifest.map((observation) => ({
      ...observation,
      execution_status: 'failed' as const,
    })),
  };
  const tamperedResult = validateColdResume({
    checkpoint: tampered,
    currentOwner: OWNER,
  });
  assert.equal(tamperedResult.status, 'blocked');
  assert.ok(tamperedResult.reasons.includes('manifest_digest_mismatch'));

  const staleResult = validateColdResume({
    checkpoint: prepared.checkpoint,
    currentOwner: { ...OWNER, generation: OWNER.generation + 1, token: 'owner-token-5' },
  });
  assert.equal(staleResult.status, 'blocked');
  assert.ok(staleResult.reasons.includes('stale_owner'));
});

test('a relabelled verifier revision never counts as current workspace coverage', () => {
  const population = mapCheckpointRequiredState(
    completeSources({
      workspace: {
        current_snapshot_revision: 'snapshot-historical',
        capture_complete: true,
        coverage_ref: 'coverage-1',
        capture_provenance: 'verifier_relabel',
        capture_epoch: 'capture-epoch-relabelled',
      },
    }),
  );
  assert.equal(population.status, 'blocked');
  assert.equal(population.workspace_revision_current, false);
  const row = population.rows.find((item) => item.id === 'workspace_snapshot');
  assert.equal(row?.present, false);
  assert.match(row?.gap ?? '', /relabelled/);
});

test('a fresh capture of the unchanged verifier revision is still current coverage', () => {
  const population = mapCheckpointRequiredState(
    completeSources({
      workspace: {
        current_snapshot_revision: 'snapshot-historical',
        capture_complete: true,
        coverage_ref: 'coverage-1',
        capture_provenance: 'current_capture',
        capture_epoch: 'capture-epoch-same-revision',
      },
    }),
  );
  assert.equal(population.status, 'populated');
  assert.equal(population.workspace_revision_current, true);
  assert.equal(population.workspace_matches_verifier_revision, true);
  assert.equal(
    population.errors.some((error) => error.startsWith('workspace_snapshot')),
    false,
  );
  const row = population.rows.find((item) => item.id === 'workspace_snapshot');
  assert.equal(row?.present, true);
  assert.equal(row?.constraint_satisfied, true);
  assert.ok(row?.value_refs.includes('matches_verifier_revision:true'));
  assert.ok(row?.value_refs.includes('capture_epoch:capture-epoch-same-revision'));
});

test('a fresh capture of a changed revision reports no verifier match', () => {
  const population = mapCheckpointRequiredState(completeSources());
  assert.equal(population.status, 'populated');
  assert.equal(population.workspace_revision_current, true);
  assert.equal(population.workspace_matches_verifier_revision, false);
});

test('a revision with a null capture epoch is relabelled, not a fresh capture', () => {
  const population = mapCheckpointRequiredState(
    completeSources({
      workspace: {
        current_snapshot_revision: 'snapshot-current',
        capture_complete: true,
        coverage_ref: 'coverage-1',
        capture_provenance: 'current_capture',
        capture_epoch: null,
      },
    }),
  );
  assert.equal(population.status, 'blocked');
  assert.equal(population.workspace_revision_current, false);
  const row = population.rows.find((item) => item.id === 'workspace_snapshot');
  assert.equal(row?.present, false);
  assert.match(row?.gap ?? '', /relabelled/);
});

test('resume with a fresh unchanged-revision capture stays populated', () => {
  const population = mapCheckpointRequiredState(
    completeSources({
      resumed: true,
      workspace: {
        current_snapshot_revision: 'snapshot-historical',
        capture_complete: true,
        coverage_ref: 'coverage-1',
        capture_provenance: 'current_capture',
        capture_epoch: 'capture-epoch-resumed',
      },
    }),
  );
  assert.equal(population.status, 'populated');
  assert.equal(population.workspace_revision_current, true);
});

test('writes-only progress and legacy obs: strings are degraded, not success', () => {
  const population = mapCheckpointRequiredState(
    completeSources({
      working_state: {
        current_hypothesis: '',
        unresolved_failures: [],
        next_experiment: '',
      },
      observations: [],
      legacy_observation_refs: Array.from({ length: 40 }, (_, index) => `obs:${index}`),
    }),
  );
  assert.equal(population.status, 'blocked');
  const step = population.rows.find((item) => item.id === 'current_step');
  assert.equal(step?.present, false);
  assert.match(step?.gap ?? '', /write count/);
  const observations = population.rows.find((item) => item.id === 'exact_observations');
  assert.equal(observations?.present, false);
  assert.match(observations?.gap ?? '', /legacy obs:/);
});

test('a normal continuation with a preserved allowance stays populated', () => {
  const population = mapCheckpointRequiredState(completeSources({ resumed: true }));
  assert.equal(population.status, 'populated');
  const budget = population.rows.find((item) => item.id === 'budget');
  assert.equal(budget?.present, true);
  assert.equal(budget?.constraint_satisfied, true);
  assert.equal(budget?.gap, undefined);
});

test('a budget reset across resume degrades the capsule', () => {
  const population = mapCheckpointRequiredState(
    completeSources({
      resumed: true,
      budget: {
        owner: 'task-budget-owner',
        remaining_allowance: 120_000,
        cancellation_owner: 'task-budget-owner',
        allowance_reset_on_resume: true,
      },
    }),
  );
  assert.equal(population.status, 'degraded');
  const budget = population.rows.find((item) => item.id === 'budget');
  assert.equal(budget?.constraint_satisfied, false);
  assert.match(budget?.gap ?? '', /reset/);
  assert.equal(checkpointPopulationAllowsInstall(population), false);
});

test('an indeterminate pending effect is never replayed to rebuild history', () => {
  const population = mapCheckpointRequiredState(
    completeSources({
      resumed: true,
      pending: [{ handle_id: 'op-1', kind: 'operation', state: 'indeterminate' }],
    }),
  );
  assert.ok(
    population.errors.some((error) => error.startsWith('pending_operations')),
  );
  // The handle is still surfaced as indeterminate, not converted to settled.
  const row = population.rows.find((item) => item.id === 'pending_operations');
  assert.deepEqual(row?.value_refs, ['handle:op-1:indeterminate']);
});

test('retention oracle fixture proves native pairing and state population', () => {
  const fixture = buildRetentionOracleFixtureV1();
  const result = evaluateRetentionOracle(fixture);
  assert.equal(fixture.removed_observation_count, 40);
  assert.ok(fixture.removed_observation_count > 32);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.unresolved_invocation_roots, []);
  assert.equal(result.duplicate_text_distinct_invocations, true);
  assert.equal(result.native_cycles_paired, true);
  assert.equal(result.pending_preserved, true);
  assert.equal(result.silently_capped, false);
});

test('retention oracle fixture is deterministic', () => {
  assert.deepEqual(buildRetentionOracleFixtureV1(), buildRetentionOracleFixtureV1());
});

test('retention oracle fails aliased invocations, fabricated results and silent caps', () => {
  const fixture = buildRetentionOracleFixtureV1();

  const aliased: RetentionOracleInputV1 = {
    ...fixture,
    observations: fixture.observations.map((observation, index) =>
      index === 39
        ? { ...observation, observation_id: fixture.observations[38]!.observation_id }
        : observation,
    ),
  };
  assert.equal(evaluateRetentionOracle(aliased).status, 'fail');

  const fabricated: RetentionOracleInputV1 = {
    ...fixture,
    tool_cycles: fixture.tool_cycles.map((cycle) =>
      cycle.state === 'pending' ? { ...cycle, result_ids: ['call-3'] } : cycle,
    ),
  };
  const fabricatedResult = evaluateRetentionOracle(fabricated);
  assert.equal(fabricatedResult.status, 'fail');
  assert.equal(fabricatedResult.native_cycles_paired, false);

  const capped: RetentionOracleInputV1 = {
    ...fixture,
    observations: fixture.observations.slice(0, 32),
    legacy_cap: 32,
  };
  const cappedResult = evaluateRetentionOracle(capped);
  assert.equal(cappedResult.status, 'fail');
  assert.equal(cappedResult.silently_capped, true);

  const missing: RetentionOracleInputV1 = {
    ...fixture,
    observations: fixture.observations.map((observation, index) =>
      index === 0 ? { ...observation, availability: 'missing' } : observation,
    ),
  };
  assert.equal(evaluateRetentionOracle(missing).status, 'fail');
});

test('retention oracle detects a pending operation silently becoming settled', () => {
  const fixture = buildRetentionOracleFixtureV1();
  const settled: RetentionOracleInputV1 = {
    ...fixture,
    pending_operations: [{ handle_id: 'op-pending-1', state: 'settled', was_pending: true }],
  };
  const result = evaluateRetentionOracle(settled);
  assert.equal(result.status, 'fail');
  assert.equal(result.pending_preserved, false);
  assert.ok(result.violations.some((violation) => /silently settled/.test(violation)));

  // An operation that was never pending is not a preservation violation.
  const unrelated: RetentionOracleInputV1 = {
    ...fixture,
    pending_operations: [{ handle_id: 'op-old', state: 'settled', was_pending: false }],
  };
  assert.equal(evaluateRetentionOracle(unrelated).status, 'pass');
});

test('retention oracle requires the complete expected identity set', () => {
  const fixture = buildRetentionOracleFixtureV1();

  const omitted: RetentionOracleInputV1 = {
    ...fixture,
    observations: fixture.observations.slice(0, 39),
  };
  const omittedResult = evaluateRetentionOracle(omitted);
  assert.equal(omittedResult.status, 'fail');
  assert.equal(omittedResult.coverage_complete, false);
  assert.equal(omittedResult.missing_expected_ids.length, 1);
  assert.deepEqual(omittedResult.unexpected_observation_ids, []);
  assert.ok(
    omittedResult.violations.some((violation) =>
      /expected observations missing from retention set: 1/.test(violation),
    ),
  );

  const replaced: RetentionOracleInputV1 = {
    ...fixture,
    observations: fixture.observations.map((observation, index) =>
      index === 0 ? { ...observation, observation_id: `obs:${'f'.repeat(64)}` } : observation,
    ),
  };
  const replacedResult = evaluateRetentionOracle(replaced);
  assert.equal(replacedResult.status, 'fail');
  assert.equal(replacedResult.coverage_complete, false);
  assert.equal(replacedResult.missing_expected_ids.length, 1);
  assert.equal(replacedResult.unexpected_observation_ids.length, 1);

  const duplicated: RetentionOracleInputV1 = {
    ...fixture,
    observations: fixture.observations.map((observation, index) =>
      index === 39
        ? { ...observation, observation_id: fixture.observations[0]!.observation_id }
        : observation,
    ),
  };
  assert.equal(duplicated.observations.length, 40);
  assert.equal(
    new Set(duplicated.observations.map((observation) => observation.observation_id)).size,
    39,
  );
  const duplicatedResult = evaluateRetentionOracle(duplicated);
  assert.equal(duplicatedResult.status, 'fail');
  assert.equal(duplicatedResult.coverage_complete, false);
  assert.equal(duplicatedResult.missing_expected_ids.length, 1);
});

test('an expected observation that is missing stays unresolved and incomplete', () => {
  const fixture = buildRetentionOracleFixtureV1();
  const missing: RetentionOracleInputV1 = {
    ...fixture,
    observations: fixture.observations.map((observation, index) =>
      index === 0 ? { ...observation, availability: 'missing' } : observation,
    ),
  };
  const result = evaluateRetentionOracle(missing);
  assert.equal(result.status, 'fail');
  // The identity is still accounted for; only its payload is unresolvable.
  assert.equal(result.coverage_complete, true);
  assert.equal(result.missing_expected_ids.length, 0);
  assert.deepEqual(result.unresolved_invocation_roots, [
    fixture.observations[0]!.observation_id,
  ]);
});

test('a claimed removed count that disagrees with the expected set fails', () => {
  const fixture = buildRetentionOracleFixtureV1();
  const mismatched: RetentionOracleInputV1 = {
    ...fixture,
    removed_observation_count: fixture.expected_observation_ids.length + 1,
  };
  const result = evaluateRetentionOracle(mismatched);
  assert.equal(result.status, 'fail');
  assert.ok(
    result.violations.some((violation) => /disagrees with expected set size/.test(violation)),
  );
});

test('a padded expected identity set (duplicate ids) cannot manufacture coverage', () => {
  const fixture = buildRetentionOracleFixtureV1();
  const padded: RetentionOracleInputV1 = {
    ...fixture,
    // 41 expected entries but only 40 unique identities: de-duplication would
    // otherwise hide the padding behind an equal removed count.
    expected_observation_ids: [
      ...fixture.expected_observation_ids,
      fixture.expected_observation_ids[0]!,
    ],
    removed_observation_count: fixture.expected_observation_ids.length + 1,
  };
  const result = evaluateRetentionOracle(padded);
  assert.equal(result.status, 'fail');
  assert.equal(result.coverage_complete, false);
  assert.ok(
    result.violations.some((violation) => /duplicate ids/.test(violation)),
  );
});

test('an omitted expected identity set degrades explicitly instead of throwing', () => {
  const fixture = buildRetentionOracleFixtureV1();
  const malformed = { ...fixture } as Record<string, unknown>;
  delete malformed['expected_observation_ids'];
  const result = evaluateRetentionOracle(malformed as unknown as RetentionOracleInputV1);
  assert.equal(result.status, 'fail');
  assert.equal(result.coverage_complete, false);
  assert.ok(result.violations.some((violation) => /identity set is required/.test(violation)));
});
