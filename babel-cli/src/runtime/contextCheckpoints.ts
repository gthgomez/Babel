/**
 * contextCheckpoints.ts — A11c pure checkpoint-population skeleton.
 *
 * Scope: pure mapping/validation plus a retention-oracle fixture. This module
 * deliberately does NOT install a checkpoint, mutate a control journal, switch
 * an active context window, call the live chat caller, or talk to any provider.
 *
 * Production population/installation remains blocked on P06 (admission and
 * request freeze) and P07 (revision/coverage capture). The mapping below names
 * the real operational source responsibilities from the P11 spec table so the
 * eventual adapter can be validated against this pure contract first (R05).
 *
 * Table rows and the "must not do" constraints they encode:
 *   accepted goal / acceptance clauses  → frozen task contract, never a summary
 *   current step / unresolved failures  → working state, never just `writes=N`
 *   current workspace snapshot/coverage → P08/P07 current capture, never a
 *                                         relabelled historical verifier hash
 *   verification                        → live receipt ids/identity/scope/stale,
 *                                         a summary is never a fresh receipt
 *   budget / cancellation ownership     → task/child budget owner, never reset
 *                                         on compaction or resume
 *   pending operations / children       → P05/P06/P09 handles; pending stays
 *                                         pending, indeterminate is not replayed
 *   instructions / tools / model route  → compiled/prepared request identity,
 *                                         never stored preferences
 *   exact observations                  → authorized durable ref index; legacy
 *                                         `obs:` strings are descriptive only
 */

export const CONTEXT_CHECKPOINT_POPULATION_SCHEMA_VERSION = 1 as const;

/** Production installation is blocked on these dependencies; shadow only. */
export const CONTEXT_CHECKPOINT_INSTALL_BLOCKED_ON = ['P06', 'P07'] as const;

export type CheckpointPopulationStatusV1 = 'populated' | 'degraded' | 'blocked';

export type RequiredStateRowIdV1 =
  | 'accepted_goal'
  | 'current_step'
  | 'workspace_snapshot'
  | 'verification'
  | 'budget'
  | 'pending_operations'
  | 'instructions_route'
  | 'exact_observations';

export interface RequiredStateRowV1 {
  id: RequiredStateRowIdV1;
  present: boolean;
  source: string;
  value_refs: string[];
  /** True when the row does not violate the table's "must not do" rule. */
  constraint_satisfied: boolean;
  gap?: string;
}

export interface LiveOperationalSourcesV1 {
  resumed: boolean;
  task_contract: {
    goal: string;
    acceptance_clause_ids: string[];
    contract_hash: string;
  } | null;
  working_state: {
    current_hypothesis: string;
    unresolved_failures: string[];
    next_experiment: string;
  } | null;
  workspace: {
    current_snapshot_revision: string | null;
    capture_complete: boolean;
    coverage_ref: string | null;
    /**
     * Distinguishes a fresh capture of the current workspace from a historical
     * verifier revision that has merely been relabelled as current. Revision
     * equality with the last verifier revision is not itself a freshness signal.
     */
    capture_provenance: 'current_capture' | 'verifier_relabel';
    /** Opaque capture epoch; null invalidates freshness even with a revision. */
    capture_epoch: string | null;
  } | null;
  receipts: ReadonlyArray<{
    receipt_id: string;
    identity: string;
    scope: string;
    stale: boolean;
    bound_revision: string | null;
  }>;
  budget: {
    owner: string;
    remaining_allowance: number;
    cancellation_owner: string;
    allowance_reset_on_resume?: boolean;
  } | null;
  pending: ReadonlyArray<{
    handle_id: string;
    kind: 'operation' | 'child';
    state: 'pending' | 'indeterminate' | 'settled';
  }>;
  route: {
    compiled_request_identity: string;
    tool_profile: string;
    model_route: string;
  } | null;
  /** Authorized durable observation refs (exact recall index). */
  observations: ReadonlyArray<{
    observation_id: string;
    payload_sha256: string;
    authorized: boolean;
  }>;
  /** Legacy decorative refs; descriptive metadata only, never valid handles. */
  legacy_observation_refs: readonly string[];
}

export interface CheckpointPopulationV1 {
  schema_version: typeof CONTEXT_CHECKPOINT_POPULATION_SCHEMA_VERSION;
  status: CheckpointPopulationStatusV1;
  rows: RequiredStateRowV1[];
  errors: string[];
  /**
   * True when a fresh current workspace capture exists. This is independent of
   * whether the captured revision happens to equal the last verifier revision.
   */
  workspace_revision_current: boolean;
  /**
   * Informational only: the current workspace revision equals the latest
   * verifier bound revision. Equality never substitutes for capture freshness.
   */
  workspace_matches_verifier_revision: boolean;
  installation_blocked_on: readonly string[];
  /**
   * Shadow population never authorizes installation: P06/P07 wiring plus an
   * atomic commit are required before this can ever be true.
   */
  install_authorized: boolean;
}

function missingRow(
  id: RequiredStateRowIdV1,
  source: string,
  gap: string,
): RequiredStateRowV1 {
  return { id, present: false, source, value_refs: [], constraint_satisfied: false, gap };
}

/**
 * Pure mapping from live operational sources into the checkpoint contract.
 * Never installs a checkpoint and never derives authority from summary text.
 */
export function mapCheckpointRequiredState(
  sources: LiveOperationalSourcesV1,
): CheckpointPopulationV1 {
  const rows: RequiredStateRowV1[] = [];
  const errors: string[] = [];

  // accepted goal / acceptance clauses — frozen contract only.
  if (sources.task_contract && sources.task_contract.contract_hash.length > 0) {
    rows.push({
      id: 'accepted_goal',
      present: true,
      source: 'task_contract',
      value_refs: [
        `contract:${sources.task_contract.contract_hash}`,
        ...sources.task_contract.acceptance_clause_ids.map((id) => `clause:${id}`),
      ],
      constraint_satisfied: true,
    });
  } else {
    rows.push(missingRow('accepted_goal', 'task_contract', 'frozen task contract is unavailable'));
    errors.push('accepted_goal: summary text cannot supply authority');
  }

  // current step / unresolved failures — working state, not just writes=N.
  if (
    sources.working_state &&
    (sources.working_state.current_hypothesis.length > 0 ||
      sources.working_state.unresolved_failures.length > 0)
  ) {
    rows.push({
      id: 'current_step',
      present: true,
      source: 'working_state',
      value_refs: [
        `hypothesis:${sources.working_state.current_hypothesis}`,
        ...sources.working_state.unresolved_failures.map((failure) => `failure:${failure}`),
      ],
      constraint_satisfied: true,
    });
  } else {
    rows.push(
      missingRow(
        'current_step',
        'working_state',
        'only an aggregate write count is available; unresolved failures are not retained',
      ),
    );
    errors.push('current_step: writes=N is not sufficient');
  }

  // current workspace snapshot/coverage — a fresh current capture is required.
  // Revision equality with the last verifier revision is informational, not a
  // freshness signal: an unchanged workspace may still be freshly observed.
  const latestBoundRevision = [...sources.receipts]
    .map((receipt) => receipt.bound_revision)
    .filter((revision): revision is string => typeof revision === 'string' && revision.length > 0)
    .at(-1);
  const workspace = sources.workspace;
  const currentRevision = workspace?.current_snapshot_revision ?? null;
  const captureEpoch = workspace?.capture_epoch ?? null;
  const workspaceCaptureFresh =
    workspace !== null &&
    workspace.capture_complete &&
    currentRevision !== null &&
    workspace.capture_provenance === 'current_capture' &&
    captureEpoch !== null;
  const workspaceMatchesVerifierRevision =
    currentRevision !== null && currentRevision === latestBoundRevision;
  const workspaceRelabelled =
    currentRevision !== null &&
    (workspace?.capture_provenance === 'verifier_relabel' || workspace?.capture_epoch === null);
  if (workspaceCaptureFresh && workspace && currentRevision !== null && captureEpoch !== null) {
    rows.push({
      id: 'workspace_snapshot',
      present: true,
      source: 'P08/P07_current_capture',
      value_refs: [
        `workspace_revision:${currentRevision}`,
        `capture_epoch:${captureEpoch}`,
        ...(workspace.coverage_ref ? [`coverage:${workspace.coverage_ref}`] : []),
        ...(workspaceMatchesVerifierRevision ? ['matches_verifier_revision:true'] : []),
      ],
      constraint_satisfied: true,
    });
  } else if (workspaceRelabelled) {
    rows.push({
      id: 'workspace_snapshot',
      present: false,
      source: 'P08/P07_current_capture',
      value_refs: [`verifier_revision:${String(latestBoundRevision)}`],
      constraint_satisfied: false,
      gap: 'current workspace snapshot is a relabelled historical verifier revision',
    });
    errors.push('workspace_snapshot: historical verifier hash cannot stand in for current coverage');
  } else {
    rows.push(
      missingRow(
        'workspace_snapshot',
        'P08/P07_current_capture',
        'no complete current workspace capture is available',
      ),
    );
    errors.push('workspace_snapshot: current coverage is absent');
  }

  // verification — live receipts, summary never substitutes for a fresh receipt.
  const liveReceipt = sources.receipts.find((receipt) => !receipt.stale);
  if (liveReceipt) {
    rows.push({
      id: 'verification',
      present: true,
      source: 'live_receipt',
      value_refs: [
        `receipt:${liveReceipt.receipt_id}`,
        `identity:${liveReceipt.identity}`,
        `scope:${liveReceipt.scope}`,
      ],
      constraint_satisfied: true,
    });
  } else {
    rows.push(
      missingRow(
        'verification',
        'live_receipt',
        'no current receipt; a summary cannot be promoted to verification',
      ),
    );
    errors.push('verification: no non-stale receipt is available');
  }

  // budget / cancellation ownership — never reset on resume/compaction.
  if (sources.budget && sources.budget.owner.length > 0) {
    // `resumed` only records that a resume happened; it is not itself a reset.
    // Only the authoritative allowance signal marks a reset, so a normal
    // continuation with a preserved allowance is not degraded (T12).
    const reset = sources.budget.allowance_reset_on_resume === true;
    rows.push({
      id: 'budget',
      present: true,
      source: 'task_budget_owner',
      value_refs: [
        `owner:${sources.budget.owner}`,
        `remaining:${sources.budget.remaining_allowance}`,
        `cancel_owner:${sources.budget.cancellation_owner}`,
      ],
      constraint_satisfied: !reset,
      ...(reset
        ? { gap: 'budget allowance was reset across resume/compaction' }
        : {}),
    });
    if (reset) errors.push('budget: allowance must not reset on resume or compaction');
  } else {
    rows.push(missingRow('budget', 'task_budget_owner', 'budget owner/cancellation ownership absent'));
    errors.push('budget: ownership is required');
  }

  // pending operations / children — pending stays pending; no replay.
  const replayAttempt = sources.pending.filter(
    (item) => item.kind === 'operation' && item.state === 'indeterminate',
  );
  if (sources.pending.length > 0) {
    rows.push({
      id: 'pending_operations',
      present: true,
      source: 'P05/P06/P09_handle',
      value_refs: sources.pending.map((item) => `handle:${item.handle_id}:${item.state}`),
      constraint_satisfied: true,
    });
  } else {
    rows.push({
      id: 'pending_operations',
      present: true,
      source: 'P05/P06/P09_handle',
      value_refs: [],
      constraint_satisfied: true,
    });
  }
  if (replayAttempt.length > 0 && sources.resumed) {
    // Indeterminate effects must remain unresolved; they are not replayed to
    // rebuild history. Mapping records them explicitly as indeterminate.
    errors.push('pending_operations: indeterminate effect must remain unresolved, never replayed');
  }

  // instructions / tools / model route — compiled request identity only.
  if (sources.route && sources.route.compiled_request_identity.length > 0) {
    rows.push({
      id: 'instructions_route',
      present: true,
      source: 'compiled_prepared_request',
      value_refs: [
        `request:${sources.route.compiled_request_identity}`,
        `tools:${sources.route.tool_profile}`,
        `route:${sources.route.model_route}`,
      ],
      constraint_satisfied: true,
    });
  } else {
    rows.push(
      missingRow(
        'instructions_route',
        'compiled_prepared_request',
        'effective compiled request identity is absent; stored preferences cannot substitute',
      ),
    );
    errors.push('instructions_route: effective capabilities required');
  }

  // exact observations — authorized durable ref index only.
  const authorizedObservations = sources.observations.filter((item) => item.authorized);
  if (authorizedObservations.length > 0) {
    rows.push({
      id: 'exact_observations',
      present: true,
      source: 'authorized_durable_ref_index',
      value_refs: authorizedObservations.map((item) => `obs:${item.observation_id}`),
      constraint_satisfied: true,
    });
  } else {
    rows.push(
      missingRow(
        'exact_observations',
        'authorized_durable_ref_index',
        sources.legacy_observation_refs.length > 0
          ? 'only legacy obs: strings exist; they are descriptive metadata, not valid handles'
          : 'no authorized durable observation refs',
      ),
    );
    errors.push('exact_observations: first32 obs: strings are not a complete recovery manifest');
  }

  const required = rows.filter((row) => row.id !== 'pending_operations');
  const anyMissing = required.some((row) => !row.present);
  const anyConstraintViolation = rows.some((row) => !row.constraint_satisfied);
  const status: CheckpointPopulationStatusV1 = anyMissing
    ? 'blocked'
    : anyConstraintViolation
      ? 'degraded'
      : 'populated';

  return {
    schema_version: CONTEXT_CHECKPOINT_POPULATION_SCHEMA_VERSION,
    status,
    rows,
    errors,
    workspace_revision_current: workspaceCaptureFresh,
    workspace_matches_verifier_revision: workspaceMatchesVerifierRevision,
    installation_blocked_on: CONTEXT_CHECKPOINT_INSTALL_BLOCKED_ON,
    install_authorized: false,
  };
}

/**
 * A failed required-state validation keeps the old window active. In this
 * shadow skeleton installation is never authorized (P06/P07 not landed), so
 * this always returns false while still expressing the gate condition.
 */
export function checkpointPopulationAllowsInstall(
  population: CheckpointPopulationV1,
): boolean {
  return population.status === 'populated' && population.install_authorized;
}

// ---------------------------------------------------------------------------
// Retention oracle (T12/T13 shape), pure fixture
// ---------------------------------------------------------------------------

export interface RetentionOracleObservationV1 {
  observation_id: string;
  invocation_id: string;
  text: string;
  payload_sha256: string;
  availability: 'durable' | 'missing';
}

export interface RetentionOracleToolCycleV1 {
  cycle_id: string;
  tool_call_ids: readonly string[];
  result_ids: readonly string[];
  state: 'complete' | 'pending';
}

export interface RetentionOraclePendingOperationV1 {
  handle_id: string;
  state: 'pending' | 'settled' | 'indeterminate';
  /**
   * True when this operation was pending in the previous window. A pending
   * operation that is no longer pending is a preservation violation; without
   * this prior-state marker a silent settle is undetectable.
   */
  was_pending?: boolean;
}

export interface RetentionOracleInputV1 {
  removed_observation_count: number;
  /**
   * Independently known expected observation identity set. Completeness is
   * validated against this, never inferred from the supplied records alone.
   */
  expected_observation_ids: readonly string[];
  observations: readonly RetentionOracleObservationV1[];
  tool_cycles: readonly RetentionOracleToolCycleV1[];
  pending_operations: readonly RetentionOraclePendingOperationV1[];
  /** Historic decorative cap that must not silently bound exact recovery. */
  legacy_cap?: number;
}

export interface RetentionOracleResultV1 {
  status: 'pass' | 'fail';
  removed_observation_count: number;
  unresolved_invocation_roots: string[];
  aliased_invocations: string[];
  duplicate_text_distinct_invocations: boolean;
  native_cycles_paired: boolean;
  pending_preserved: boolean;
  silently_capped: boolean;
  /** True when the received id set exactly matches the expected id set. */
  coverage_complete: boolean;
  missing_expected_ids: string[];
  unexpected_observation_ids: string[];
  violations: string[];
}

/**
 * Proves that exact invocation roots survive a compaction window (T12/T13):
 * duplicate text from distinct invocations is not aliased, >32 removed
 * observations remain resolvable, native cycles stay paired and a pending
 * operation is never converted into a fabricated result.
 */
export function evaluateRetentionOracle(input: RetentionOracleInputV1): RetentionOracleResultV1 {
  const violations: string[] = [];
  const unresolved: string[] = [];
  const byText = new Map<string, Set<string>>();
  const seenIds = new Set<string>();

  for (const observation of input.observations) {
    if (seenIds.has(observation.observation_id)) {
      violations.push(`observation id is not unique: ${observation.observation_id}`);
    }
    seenIds.add(observation.observation_id);
    if (observation.availability === 'missing') {
      unresolved.push(observation.observation_id);
    }
    const invocations = byText.get(observation.text) ?? new Set<string>();
    invocations.add(observation.invocation_id);
    byText.set(observation.text, invocations);
  }

  // Coverage is validated against the independently known expected identity
  // set. Internal validity of each supplied record is necessary but not
  // sufficient: an omitted, replaced or duplicated observation must fail.
  // The set is required at runtime too; a JS/`as any` caller that omits it must
  // degrade to an explicit failure, never throw or silently pass.
  const expectedList: readonly string[] = Array.isArray(input.expected_observation_ids)
    ? input.expected_observation_ids
    : [];
  if (!Array.isArray(input.expected_observation_ids)) {
    violations.push('expected observation identity set is required');
  }
  const expectedIds = new Set(expectedList);
  if (expectedIds.size !== expectedList.length) {
    violations.push('expected observation identity set contains duplicate ids');
  }
  const receivedIds = new Set(input.observations.map((observation) => observation.observation_id));
  const missingExpectedIds = [...expectedIds].filter((id) => !receivedIds.has(id));
  const unexpectedObservationIds = [...receivedIds].filter((id) => !expectedIds.has(id));
  if (missingExpectedIds.length > 0) {
    violations.push(
      `expected observations missing from retention set: ${missingExpectedIds.length}`,
    );
  }
  if (unexpectedObservationIds.length > 0) {
    violations.push(
      `observation ids present that were not expected: ${unexpectedObservationIds.length}`,
    );
  }
  if (input.removed_observation_count !== expectedList.length) {
    violations.push(
      `removed observation count (${input.removed_observation_count}) disagrees with expected set size (${expectedList.length})`,
    );
  }
  const coverageComplete =
    missingExpectedIds.length === 0 &&
    unexpectedObservationIds.length === 0 &&
    expectedIds.size === expectedList.length;

  const aliased: string[] = [];
  let duplicatesDistinct = true;
  for (const [text, invocations] of byText) {
    if (invocations.size <= 1) continue;
    const ids = [...invocations]
      .map((invocationId) =>
        input.observations.find((observation) => observation.invocation_id === invocationId),
      )
      .filter((observation): observation is RetentionOracleObservationV1 => observation !== undefined);
    const uniqueIds = new Set(ids.map((observation) => observation.observation_id));
    if (uniqueIds.size !== invocations.size) {
      duplicatesDistinct = false;
      aliased.push(...invocations);
      violations.push(`duplicate text is aliased across invocations: ${text.slice(0, 32)}`);
    }
  }

  let cyclesPaired = true;
  for (const cycle of input.tool_cycles) {
    const calls = new Set(cycle.tool_call_ids);
    const results = new Set(cycle.result_ids);
    if (cycle.state === 'complete') {
      const paired =
        calls.size === results.size && [...calls].every((id) => results.has(id));
      if (!paired) {
        cyclesPaired = false;
        violations.push(`native tool cycle is unpaired: ${cycle.cycle_id}`);
      }
    } else if (cycle.result_ids.length > 0) {
      // A pending cycle must not carry a fabricated result.
      cyclesPaired = false;
      violations.push(`pending tool cycle must not carry a result: ${cycle.cycle_id}`);
    }
  }

  // A pending operation must stay pending. Detect a silent settle by comparing
  // against the previous window's pending state (`was_pending`).
  const silentlySettled = input.pending_operations.filter(
    (operation) => operation.was_pending === true && operation.state !== 'pending',
  );
  const pendingPreserved = silentlySettled.length === 0;
  if (!pendingPreserved) {
    for (const operation of silentlySettled) {
      violations.push(
        `pending operation was silently settled (${operation.state}): ${operation.handle_id}`,
      );
    }
  }
  if (input.pending_operations.some((operation) => operation.state === 'pending' && operation.handle_id.length === 0)) {
    violations.push('pending operation is missing a stable handle');
  }

  const silentlyCapped =
    input.legacy_cap !== undefined &&
    input.removed_observation_count > input.legacy_cap &&
    input.observations.length <= input.legacy_cap;

  if (silentlyCapped) {
    violations.push(
      `exact recovery is silently capped at ${input.legacy_cap} (< ${input.removed_observation_count} removed)`,
    );
  }
  if (unresolved.length > 0) {
    violations.push(`unresolved invocation roots: ${unresolved.length}`);
  }

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    removed_observation_count: input.removed_observation_count,
    unresolved_invocation_roots: unresolved,
    aliased_invocations: aliased,
    duplicate_text_distinct_invocations: duplicatesDistinct,
    native_cycles_paired: cyclesPaired,
    pending_preserved: pendingPreserved,
    silently_capped: silentlyCapped,
    coverage_complete: coverageComplete,
    missing_expected_ids: missingExpectedIds,
    unexpected_observation_ids: unexpectedObservationIds,
    violations,
  };
}

/**
 * Deterministic T12/T13 fixture: more than 32 removed observations, duplicate
 * text from distinct invocations, a complete native cycle and a pending one.
 * P06/P07 production installation remains blocked; this only exercises the
 * pure mapping/oracle shape.
 */
export function buildRetentionOracleFixtureV1(): RetentionOracleInputV1 {
  const observations: RetentionOracleObservationV1[] = [];
  for (let index = 0; index < 40; index++) {
    observations.push({
      observation_id: `obs:${String(index).padStart(2, '0')}${'a'.repeat(62)}`,
      invocation_id: `invocation-${index}`,
      text: index >= 38 ? 'IDENTICAL_DUPLICATE_TEXT' : `removed output ${index}`,
      payload_sha256: `${String(index).padStart(2, '0')}${'b'.repeat(62)}`,
      availability: 'durable',
    });
  }
  return {
    removed_observation_count: observations.length,
    expected_observation_ids: observations.map((observation) => observation.observation_id),
    observations,
    tool_cycles: [
      {
        cycle_id: 'cycle-complete',
        tool_call_ids: ['call-1', 'call-2'],
        result_ids: ['call-1', 'call-2'],
        state: 'complete',
      },
      {
        cycle_id: 'cycle-pending',
        tool_call_ids: ['call-3'],
        result_ids: [],
        state: 'pending',
      },
    ],
    pending_operations: [{ handle_id: 'op-pending-1', state: 'pending', was_pending: true }],
    legacy_cap: 32,
  };
}
