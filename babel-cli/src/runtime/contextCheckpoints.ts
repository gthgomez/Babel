/**
 * contextCheckpoints.ts — P11 context checkpoint preparation and fencing.
 *
 * Scope: pure mapping/validation plus a checkpoint port. This module does not
 * own durable state: callers supply the existing atomic checkpoint transaction
 * as the install port. It therefore cannot create a second store or journal,
 * switch an active context window, call the live chat caller, or talk to a
 * provider.
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
 *   exact observations                  → complete authorized durable ref
 *                                         manifest; legacy `obs:` strings are
 *                                         descriptive only
 */

import { sha256Canonical } from '../acceptance/canonical.js';
import type { ObservationRefV1 } from '../evidence/observationStore.js';
import type { OwnerRecordV1 } from './admissionContracts.js';

export const CONTEXT_CHECKPOINT_POPULATION_SCHEMA_VERSION = 1 as const;
export const CONTEXT_CHECKPOINT_SCHEMA_VERSION = 1 as const;

/** P06/P07 are now consumed by the preparation contract, not blockers. */
export const CONTEXT_CHECKPOINT_INSTALL_BLOCKED_ON = [] as const;

export type ContextCheckpointOwnerV1 = Pick<OwnerRecordV1, 'threadId' | 'generation' | 'token'>;

export type ContextCheckpointValidationReasonV1 =
  | 'invalid_schema'
  | 'invalid_checkpoint_id'
  | 'invalid_thread_id'
  | 'invalid_owner'
  | 'generation_mismatch'
  | 'owner_missing'
  | 'stale_owner'
  | 'population_incomplete'
  | 'observation_manifest_incomplete'
  | 'manifest_digest_mismatch'
  | 'expected_thread_mismatch'
  | 'requested_owner_mismatch'
  | 'invalid_context_epoch'
  | 'install_failed';

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
  /** Full immutable observation refs; ids and payload hashes alone are not a manifest. */
  observation_manifest?: ReadonlyArray<ObservationRefV1>;
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
  /** Detached full observation refs retained by the prepared checkpoint. */
  observation_manifest: readonly ObservationRefV1[];
  /**
   * Population authorizes preparation only when every required row is present,
   * constraint-safe, and the observation manifest is complete. Atomic commit
   * remains the install port's responsibility.
   */
  install_authorized: boolean;
}

export interface ContextCheckpointV1 {
  schema_version: typeof CONTEXT_CHECKPOINT_SCHEMA_VERSION;
  checkpointId: string;
  threadId: string;
  sessionId: string;
  turnId: string | null;
  contextEpoch: string;
  generation: number;
  owner: ContextCheckpointOwnerV1;
  preparedAt: string;
  taskContractReference: string | null;
  workingStateSnapshot: {
    state: LiveOperationalSourcesV1['working_state'];
    provenance: 'mixed';
    authoritative: false;
  };
  workspace: LiveOperationalSourcesV1['workspace'];
  receipts: LiveOperationalSourcesV1['receipts'];
  budget: LiveOperationalSourcesV1['budget'];
  pending: LiveOperationalSourcesV1['pending'];
  route: LiveOperationalSourcesV1['route'];
  population: CheckpointPopulationV1;
  observation_manifest: readonly ObservationRefV1[];
  observation_manifest_digest: string;
}

export interface ContextCheckpointPreparationInputV1 {
  checkpointId: string;
  owner: ContextCheckpointOwnerV1;
  sources: LiveOperationalSourcesV1;
  sessionId?: string;
  turnId?: string | null;
  contextEpoch?: string;
  now?: () => string;
}

export type ContextCheckpointPreparationResultV1 =
  | {
      status: 'prepared';
      checkpoint: ContextCheckpointV1;
      population: CheckpointPopulationV1;
    }
  | {
      status: 'blocked';
      population: CheckpointPopulationV1;
      reasons: ContextCheckpointValidationReasonV1[];
    };

export interface ContextCheckpointValidationInputV1 {
  currentOwner?: ContextCheckpointOwnerV1 | null;
  expectedThreadId?: string;
}

export interface ContextCheckpointValidationResultV1 {
  status: 'valid' | 'blocked';
  checkpoint: ContextCheckpointV1;
  reasons: ContextCheckpointValidationReasonV1[];
}

export interface ContextCheckpointInstallInputV1 {
  currentOwner: ContextCheckpointOwnerV1 | null;
  /** Re-read the P05 owner immediately before the atomic commit when available. */
  readCurrentOwner?: () => ContextCheckpointOwnerV1 | null;
  /** Adapter for the existing atomic checkpoint transaction; no second journal. */
  install: (
    checkpoint: ContextCheckpointV1,
    owner: ContextCheckpointOwnerV1,
  ) => void | Promise<void>;
}

export type ContextCheckpointInstallResultV1 =
  | { status: 'installed'; checkpointId: string }
  | {
      status: 'blocked';
      checkpointId: string | null;
      reasons: ContextCheckpointValidationReasonV1[];
    };

export interface ColdResumeValidationInputV1 {
  checkpoint: ContextCheckpointV1;
  currentOwner: ContextCheckpointOwnerV1 | null;
  requestedOwner?: ContextCheckpointOwnerV1;
}

export interface ColdResumeValidationResultV1 {
  status: 'ready' | 'blocked';
  resumable: boolean;
  checkpoint: ContextCheckpointV1;
  reasons: ContextCheckpointValidationReasonV1[];
}

function missingRow(
  id: RequiredStateRowIdV1,
  source: string,
  gap: string,
): RequiredStateRowV1 {
  return { id, present: false, source, value_refs: [], constraint_satisfied: false, gap };
}

function cloneObservationRef(observation: ObservationRefV1): ObservationRefV1 {
  const cloned: ObservationRefV1 = {
    schema_version: observation.schema_version,
    observation_id: observation.observation_id,
    invocation: { ...observation.invocation },
    payloads: observation.payloads.map((payload) => ({ ...payload })),
    execution_status: observation.execution_status,
    capture_completeness: observation.capture_completeness,
    permitted_principals: [...observation.permitted_principals],
    capture_policy_version: observation.capture_policy_version,
    redaction_policy_version: observation.redaction_policy_version,
    captured_at: observation.captured_at,
  };
  if (observation.snapshot_ref !== undefined) cloned.snapshot_ref = observation.snapshot_ref;
  if (observation.coverage_ref !== undefined) cloned.coverage_ref = observation.coverage_ref;
  return cloned;
}

function cloneObservationManifest(
  manifest: ReadonlyArray<ObservationRefV1>,
): ObservationRefV1[] {
  return manifest.map(cloneObservationRef);
}

function observationManifestIssues(
  manifest: ReadonlyArray<ObservationRefV1>,
  sourceObservations?: LiveOperationalSourcesV1['observations'],
): string[] {
  const issues: string[] = [];
  // An empty authorized set is a valid first-turn manifest. Once an
  // authorized observation exists, the manifest must be non-empty and exact.
  if (manifest.length === 0 && (sourceObservations === undefined || sourceObservations.some((item) => item.authorized))) {
    issues.push('observation manifest is empty');
  }
  const ids = new Set<string>();

  for (const observation of manifest) {
    if (!/^obs:[0-9a-f]{64}$/.test(observation.observation_id)) {
      issues.push(`observation id is invalid: ${observation.observation_id}`);
    }
    if (ids.has(observation.observation_id)) {
      issues.push(`observation id is duplicated: ${observation.observation_id}`);
    }
    ids.add(observation.observation_id);
    if (observation.schema_version !== 1) issues.push('observation schema is unsupported');
    if (
      observation.invocation.operation_id.length === 0 ||
      observation.invocation.task_id.length === 0 ||
      observation.invocation.run_id.length === 0
    ) {
      issues.push(`observation invocation identity is incomplete: ${observation.observation_id}`);
    }
    if (observation.payloads.length === 0) {
      issues.push(`observation has no payload manifest: ${observation.observation_id}`);
    }
    if (observation.permitted_principals.length === 0) {
      issues.push(`observation has no permitted principal: ${observation.observation_id}`);
    }
    if (
      observation.capture_policy_version.length === 0 ||
      observation.redaction_policy_version.length === 0 ||
      observation.captured_at.length === 0
    ) {
      issues.push(`observation provenance is incomplete: ${observation.observation_id}`);
    }
    for (const payload of observation.payloads) {
      if (!/^[0-9a-f]{64}$/.test(payload.sha256)) {
        issues.push(`payload hash is invalid: ${observation.observation_id}`);
      }
      if (payload.payload_id !== `sha256:${payload.sha256}`) {
        issues.push(`payload identity is not content-bound: ${observation.observation_id}`);
      }
      if (!payload.object_key.includes(payload.sha256)) {
        issues.push(`payload object is not content-bound: ${observation.observation_id}`);
      }
    }
  }

  if (sourceObservations !== undefined) {
    const authorized = sourceObservations.filter((observation) => observation.authorized);
    const authorizedIds = new Set(authorized.map((observation) => observation.observation_id));
    if (authorizedIds.size !== ids.size || [...authorizedIds].some((id) => !ids.has(id))) {
      issues.push('observation manifest does not exactly match authorized observation refs');
    }
    for (const source of authorized) {
      const manifestObservation = manifest.find(
        (observation) => observation.observation_id === source.observation_id,
      );
      if (
        manifestObservation &&
        !manifestObservation.payloads.some((payload) => payload.sha256 === source.payload_sha256)
      ) {
        issues.push(`observation payload hash is not present in its manifest: ${source.observation_id}`);
      }
    }
  }
  return issues;
}

function ownerIssues(owner: unknown): ContextCheckpointValidationReasonV1[] {
  if (typeof owner !== 'object' || owner === null) return ['invalid_owner'];
  const candidate = owner as Partial<ContextCheckpointOwnerV1>;
  const generation = candidate.generation;
  if (
    typeof candidate.threadId !== 'string' ||
    candidate.threadId.length === 0 ||
    !Number.isSafeInteger(generation) ||
    (typeof generation === 'number' && generation < 1) ||
    typeof candidate.token !== 'string' ||
    candidate.token.length === 0
  ) {
    return ['invalid_owner'];
  }
  return [];
}

function ownersMatch(
  left: unknown,
  right: unknown,
): boolean {
  if (ownerIssues(left).length > 0 || ownerIssues(right).length > 0) return false;
  const leftOwner = left as ContextCheckpointOwnerV1;
  const rightOwner = right as ContextCheckpointOwnerV1;
  return (
    leftOwner.threadId === rightOwner.threadId &&
    leftOwner.generation === rightOwner.generation &&
    leftOwner.token === rightOwner.token
  );
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

  // exact observations — complete authorized durable ref manifest only.
  const authorizedObservations = sources.observations.filter((item) => item.authorized);
  const observationManifest = cloneObservationManifest(sources.observation_manifest ?? []);
  const manifestIssues = observationManifestIssues(observationManifest, sources.observations);
  if (manifestIssues.length === 0) {
    rows.push({
      id: 'exact_observations',
      present: true,
      source: 'authorized_durable_ref_index',
      value_refs: authorizedObservations.flatMap((item) => [
        `obs:${item.observation_id}`,
        `payload:${item.payload_sha256}`,
      ]),
      constraint_satisfied: true,
    });
  } else {
    rows.push(
      missingRow(
        'exact_observations',
        'authorized_durable_ref_index',
        sources.legacy_observation_refs.length > 0 && authorizedObservations.length === 0
          ? 'only legacy obs: strings exist; they are descriptive metadata, not valid handles'
          : manifestIssues[0] ?? 'no authorized durable observation refs',
      ),
    );
    errors.push(
      `exact_observations: ${
        manifestIssues[0] ?? 'first32 obs: strings are not a complete recovery manifest'
      }`,
    );
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
    observation_manifest: observationManifest,
    install_authorized:
      status === 'populated' &&
      !anyConstraintViolation &&
      errors.length === 0 &&
      CONTEXT_CHECKPOINT_INSTALL_BLOCKED_ON.length === 0,
  };
}

/**
 * A failed required-state validation keeps the old window active. A populated
 * contract may proceed to the caller's existing atomic checkpoint transaction.
 */
export function checkpointPopulationAllowsInstall(
  population: CheckpointPopulationV1,
): boolean {
  return population.install_authorized && population.status === 'populated';
}

/**
 * Prepare a detached checkpoint from live operational sources. Preparation is
 * side-effect free; it only becomes durable when the caller passes the result
 * to an existing atomic checkpoint transaction through `installContextCheckpoint`.
 */
export function prepareContextCheckpoint(
  input: ContextCheckpointPreparationInputV1,
): ContextCheckpointPreparationResultV1 {
  const population = mapCheckpointRequiredState(input.sources);
  const reasons: ContextCheckpointValidationReasonV1[] = [];
  if (input.checkpointId.trim().length === 0) reasons.push('invalid_checkpoint_id');
  if (ownerIssues(input.owner).length > 0) reasons.push('invalid_owner');
  if (!checkpointPopulationAllowsInstall(population)) reasons.push('population_incomplete');
  if (
    observationManifestIssues(
      population.observation_manifest,
      input.sources.observations,
    ).length > 0
  ) {
    reasons.push('observation_manifest_incomplete');
  }

  if (reasons.length > 0) return { status: 'blocked', population, reasons };

  const manifest = cloneObservationManifest(population.observation_manifest);
  return {
    status: 'prepared',
    population,
    checkpoint: {
      schema_version: CONTEXT_CHECKPOINT_SCHEMA_VERSION,
      checkpointId: input.checkpointId,
      threadId: input.owner.threadId,
      sessionId: input.sessionId ?? input.owner.threadId,
      turnId: input.turnId ?? null,
      contextEpoch: input.contextEpoch ?? `${input.owner.generation}:${input.checkpointId}`,
      generation: input.owner.generation,
      owner: { ...input.owner },
      preparedAt: input.now?.() ?? new Date().toISOString(),
      taskContractReference: input.sources.task_contract?.contract_hash ?? null,
      workingStateSnapshot: {
        state: input.sources.working_state,
        provenance: 'mixed',
        authoritative: false,
      },
      workspace: input.sources.workspace,
      receipts: input.sources.receipts.map((receipt) => ({ ...receipt })),
      budget: input.sources.budget ? { ...input.sources.budget } : null,
      pending: input.sources.pending.map((pending) => ({ ...pending })),
      route: input.sources.route ? { ...input.sources.route } : null,
      population: {
        ...population,
        rows: population.rows.map((row) => ({ ...row, value_refs: [...row.value_refs] })),
        errors: [...population.errors],
        observation_manifest: cloneObservationManifest(population.observation_manifest),
      },
      observation_manifest: manifest,
      observation_manifest_digest: sha256Canonical(manifest),
    },
  };
}

/** Validate structure, required state, manifest binding, and an optional owner fence. */
export function validateContextCheckpoint(
  checkpoint: ContextCheckpointV1,
  input: ContextCheckpointValidationInputV1 = {},
): ContextCheckpointValidationResultV1 {
  const reasons: ContextCheckpointValidationReasonV1[] = [];
  if (typeof checkpoint !== 'object' || checkpoint === null) {
    return { status: 'blocked', checkpoint, reasons: ['invalid_schema'] };
  }
  if (checkpoint.schema_version !== CONTEXT_CHECKPOINT_SCHEMA_VERSION) {
    reasons.push('invalid_schema');
  }
  if (typeof checkpoint.checkpointId !== 'string' || checkpoint.checkpointId.trim().length === 0) {
    reasons.push('invalid_checkpoint_id');
  }
  if (typeof checkpoint.threadId !== 'string' || checkpoint.threadId.trim().length === 0) {
    reasons.push('invalid_thread_id');
  }
  if (typeof checkpoint.contextEpoch !== 'string' || checkpoint.contextEpoch.trim().length === 0) {
    reasons.push('invalid_context_epoch');
  }
  reasons.push(...ownerIssues(checkpoint.owner));
  if (
    ownerIssues(checkpoint.owner).length === 0 &&
    checkpoint.generation !== (checkpoint.owner as ContextCheckpointOwnerV1).generation
  ) {
    reasons.push('generation_mismatch');
  }
  if (
    ownerIssues(checkpoint.owner).length === 0 &&
    checkpoint.threadId !== (checkpoint.owner as ContextCheckpointOwnerV1).threadId
  ) {
    reasons.push('invalid_thread_id');
  }
  if (
    typeof checkpoint.population !== 'object' ||
    checkpoint.population === null ||
    !checkpointPopulationAllowsInstall(checkpoint.population)
  ) {
    reasons.push('population_incomplete');
  }
  const manifestIsArray = Array.isArray(checkpoint.observation_manifest);
  if (!manifestIsArray) {
    reasons.push('observation_manifest_incomplete');
  } else {
    try {
      if (observationManifestIssues(checkpoint.observation_manifest).length > 0) {
        reasons.push('observation_manifest_incomplete');
      }
    } catch {
      reasons.push('observation_manifest_incomplete');
    }
  }
  try {
    if (sha256Canonical(checkpoint.observation_manifest) !== checkpoint.observation_manifest_digest) {
      reasons.push('manifest_digest_mismatch');
    }
    if (
      manifestIsArray &&
      typeof checkpoint.population === 'object' &&
      checkpoint.population !== null &&
      sha256Canonical(checkpoint.population.observation_manifest) !==
        checkpoint.observation_manifest_digest
    ) {
      reasons.push('manifest_digest_mismatch');
    }
  } catch {
    reasons.push('manifest_digest_mismatch');
  }

  if (
    input.expectedThreadId !== undefined &&
    checkpoint.threadId !== input.expectedThreadId
  ) {
    reasons.push('expected_thread_mismatch');
  }
  if (input.currentOwner !== undefined) {
    if (input.currentOwner === null) {
      reasons.push('owner_missing');
    } else if (!ownersMatch(input.currentOwner, checkpoint.owner)) {
      reasons.push('stale_owner');
    }
  }

  return {
    status: reasons.length === 0 ? 'valid' : 'blocked',
    checkpoint,
    reasons: [...new Set(reasons)],
  };
}

/**
 * Install a prepared checkpoint through the caller's existing atomic commit
 * port. A stale owner is refused before the port is invoked, and an optional
 * owner re-read closes the normal check-then-commit race at the boundary.
 */
export async function installContextCheckpoint(
  preparation: ContextCheckpointPreparationResultV1 | ContextCheckpointV1,
  input: ContextCheckpointInstallInputV1,
): Promise<ContextCheckpointInstallResultV1> {
  if ('status' in preparation) {
    if (preparation.status !== 'prepared') {
      return {
        status: 'blocked',
        checkpointId: null,
        reasons: preparation.reasons,
      };
    }
  }
  const checkpoint = 'status' in preparation ? preparation.checkpoint : preparation;
  const validation = validateContextCheckpoint(checkpoint, {
    currentOwner: input.currentOwner,
  });
  if (validation.status === 'blocked') {
    return {
      status: 'blocked',
      checkpointId: checkpoint.checkpointId,
      reasons: validation.reasons,
    };
  }

  if (input.readCurrentOwner !== undefined) {
    let currentOwner: ContextCheckpointOwnerV1 | null;
    try {
      currentOwner = input.readCurrentOwner();
    } catch {
      return {
        status: 'blocked',
        checkpointId: checkpoint.checkpointId,
        reasons: ['stale_owner'],
      };
    }
    if (!ownersMatch(currentOwner, checkpoint.owner)) {
      return {
        status: 'blocked',
        checkpointId: checkpoint.checkpointId,
        reasons: ['stale_owner'],
      };
    }
  }

  try {
    await input.install(checkpoint, checkpoint.owner);
  } catch {
    return {
      status: 'blocked',
      checkpointId: checkpoint.checkpointId,
      reasons: ['install_failed'],
    };
  }
  return { status: 'installed', checkpointId: checkpoint.checkpointId };
}

/** Validate that a durable checkpoint may become the cold-resume context. */
export function validateColdResume(
  input: ColdResumeValidationInputV1,
): ColdResumeValidationResultV1 {
  const validation = validateContextCheckpoint(
    input.checkpoint,
    input.currentOwner === null
      ? { currentOwner: null }
      : { currentOwner: input.currentOwner, expectedThreadId: input.currentOwner.threadId },
  );
  const reasons = [...validation.reasons];
  if (
    input.requestedOwner !== undefined &&
    !ownersMatch(input.currentOwner, input.requestedOwner)
  ) {
    reasons.push('requested_owner_mismatch');
  }
  const uniqueReasons = [...new Set(reasons)];
  return {
    status: uniqueReasons.length === 0 ? 'ready' : 'blocked',
    resumable: uniqueReasons.length === 0,
    checkpoint: input.checkpoint,
    reasons: uniqueReasons,
  };
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
 * The fixture only exercises the pure retention oracle; installation remains
 * owned by the checkpoint preparation and install port above.
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
