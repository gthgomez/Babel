import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_CHECKPOINT_INSTALL_BLOCKED_ON,
  buildRetentionOracleFixtureV1,
  checkpointPopulationAllowsInstall,
  evaluateRetentionOracle,
  mapCheckpointRequiredState,
  type LiveOperationalSourcesV1,
  type RetentionOracleInputV1,
} from './contextCheckpoints.js';

function completeSources(
  overrides: Partial<LiveOperationalSourcesV1> = {},
): LiveOperationalSourcesV1 {
  return {
    resumed: false,
    task_contract: {
      goal: 'ship P11 shadow helpers',
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
    legacy_observation_refs: ['obs:deadbeef'],
    ...overrides,
  };
}

test('complete live sources map to a populated contract with install still blocked', () => {
  const population = mapCheckpointRequiredState(completeSources());
  assert.equal(population.status, 'populated');
  assert.equal(population.errors.length, 0);
  assert.equal(population.workspace_revision_current, true);
  assert.equal(population.install_authorized, false);
  assert.deepEqual(population.installation_blocked_on, ['P06', 'P07']);
  assert.deepEqual(population.installation_blocked_on, [...CONTEXT_CHECKPOINT_INSTALL_BLOCKED_ON]);
  assert.equal(population.rows.length, 8);
  assert.equal(population.rows.every((row) => row.present), true);
  assert.equal(checkpointPopulationAllowsInstall(population), false);
});

test('a missing frozen task contract blocks rather than deriving authority from text', () => {
  const population = mapCheckpointRequiredState(completeSources({ task_contract: null }));
  assert.equal(population.status, 'blocked');
  assert.ok(population.errors.some((error) => error.startsWith('accepted_goal')));
  assert.equal(checkpointPopulationAllowsInstall(population), false);
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
