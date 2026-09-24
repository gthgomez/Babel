import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  captureApprovedObservation,
  resolveObservation,
  type ObservationRefV1,
} from '../evidence/observationStore.js';
import { RevisionManager } from '../evidence/revisionBoundReceipt.js';
import { canonicalizeContained } from '../bridge/workspaceBound.js';
import type { ChatEngineOptions, ChatTaskAllowanceSnapshot } from './chatEngine.js';
import type { ChatExecutionProfile } from './chatEngineServices.js';
import type { ChatTaskClass } from '../config/chatTaskClass.js';
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js';
import type { ChatToolAction } from './chatToolDefinitions.js';
import { chatActionToolName } from './chatToolDefinitions.js';
import {
  installContextCheckpoint,
  prepareContextCheckpoint,
  validateContextCheckpoint,
  type ContextCheckpointLineageEvidenceV1,
  type ContextCheckpointV1,
  type ContextCheckpointInstalledLineageV1,
  type ContextCheckpointOwnerV1,
  type ContextCheckpointPreparationInputV1,
  type ContextCheckpointPreparationResultV1,
  type LiveOperationalSourcesV1,
} from '../runtime/contextCheckpoints.js';
import type { AdmissionStore } from '../runtime/admission.js';
import { ADMISSION_REASONS } from '../runtime/admissionContracts.js';
import type { ParityRuntime } from './chatEngineParityBridge.js';
import { interruptedToolRecoveries, type SessionEventLog } from './sessionEvents.js';
import { checkpointParityEventLogStrict } from './chatEngineParityBridge.js';
import { loadLiveSessionSnapshot } from './liveSessionBridge.js';
import { recordWorkingStateSnapshot } from './sessionEvents.js';
import type { WorkingState } from './codingLoop/workingState.js';
import type { RecoveryCandidateBinding } from './codingLoop/index.js';
import { repoRootFingerprint } from './threadEventLog.js';
import { recoveryWorkspaceRevision } from './codingLoop/recoveryIdentity.js';

const CHAT_ADMISSION_TOOL_SCHEMA_VERSION = 'chat-tools-v1';
const PENDING_COMPILED_REQUEST_IDENTITY = 'pending-compiled-request-identity';

export interface ChatEngineAdmissionClaim {
  threadId: string;
  commandId: string;
  generation: number;
  token: string;
  submissionGeneration: number;
  settled: boolean;
}

export interface ChatEngineP11Host {
  readonly _cancelled: boolean;
  readonly _turnIndex: number;
  activeAdmissionClaim: ChatEngineAdmissionClaim | null;
  readonly activeSubmissionGeneration: number;
  readonly admissionEpoch: string;
  admissionLease: { generation: number; token: string } | null;
  readonly engineRunDir: string;
  readonly engineRunId: string;
  readonly executionProfile: ChatExecutionProfile;
  readonly lastVerifierReceipt: BoundChatVerifierReceipt | null;
  readonly options: ChatEngineOptions;
  p11ObservationCaptureIssues: string[];
  p11ObservationRefs: ObservationRefV1[];
  readonly parity: ParityRuntime;
  readonly taskAllowance: ChatTaskAllowanceSnapshot | null;
  readonly taskClass: ChatTaskClass;
  readonly toolCallLog: ReadonlyArray<{ index: number; tool: string; exit_code?: number }>;
  readonly workingState: WorkingState;
  isSubmissionCurrent(generation: number): boolean;
  shouldUseTextTools(): boolean;
  buildP11Sources(routeOverride?: NonNullable<LiveOperationalSourcesV1['route']>): LiveOperationalSourcesV1 | null;
}

export class ChatEngineP11Authority {
  constructor(private readonly host: ChatEngineP11Host) {}

  currentP11Owner(): ContextCheckpointOwnerV1 | null {
    try {
      const store = this.host.parity.admissionStore;
      const claim = this.host.activeAdmissionClaim;
      // A live admitted claim is required: install authority is bounded to an
      // admitted command in flight, never to a settled owner row alone.
      if (!store || !claim || claim.settled) return null;
      // The reference is this engine's OWN admitted identity (from
      // admitCommand), verified against the durable owner row — not a fresh
      // read validated against itself (A5 self-referential fence).
      const durable = store.readOwner(claim.threadId);
      if (!durable) return null;
      if (durable.generation !== claim.generation || durable.token !== claim.token) return null;
      return {
        threadId: durable.threadId,
        generation: durable.generation,
        token: durable.token,
      };
    } catch {
      // A1: owner reads fail closed to null, never out of the install path.
      return null;
    }
  }

  /**
   * P05: admit the authorized command this submission is about to execute —
   * the production admission site, introduced before any P11 checkpoint
   * installation can succeed (installs run inside the stream loop this
   * wrapper precedes).
   *
   * Owner origin: the durable owner row is written ONLY by real command
   * admission — generation 1 with a fresh random lease token on a thread's
   * first command, the durable owner of record recovered on resume/restart,
   * or exactly one generation up (proving the token this engine still holds)
   * when this submission replaces an in-flight one. Never turn numbers, run
   * ids, or session-dir existence.
   *
   * Fails closed: any rejection (stale/foreign owner, corrupt state) leaves no
   * live claim and drops the lease, so `currentP11Owner` resolves null and no
   * checkpoint can install. Admission is a record, never a permission gate —
   * a rejected admission does not block execution itself.
   *
   * Returns the claim THIS admission created (or null) so the submission
   * wrapper can settle exactly that claim at exit.
   */
  admitCurrentSubmission(
    submissionGeneration: number,
    userInput: string,
  ): ChatEngineAdmissionClaim | null {
    const store = this.host.parity.admissionStore;
    if (!store) return null;
    try {
      const threadId = this.host.parity.eventLog.thread_id;
      const commandId = `${this.host.admissionEpoch}:s${submissionGeneration}`;
      const prior = this.host.activeAdmissionClaim;
      let ownerGeneration: number;
      let ownerToken: string;
      let previousOwnerToken: string | undefined;
      if (prior && !prior.settled) {
        // Task replacement: the in-flight claim is settled as aborted first,
        // then ownership advances by exactly one generation with the old token
        // presented as proof — a stale holder can never prove takeover.
        this.settleAdmissionClaim(prior, 'aborted', { finalOutcome: 'SUPERSEDED_BY_SUBMISSION' });
        ownerGeneration = prior.generation + 1;
        previousOwnerToken = prior.token;
        ownerToken = randomUUID();
      } else if (this.host.admissionLease) {
        ownerGeneration = this.host.admissionLease.generation;
        ownerToken = this.host.admissionLease.token;
      } else {
        // Resume/crash restart: recover the durable owner of record; only a
        // thread with no owner row ever mints generation 1.
        const durable = store.readOwner(threadId);
        if (durable) {
          ownerGeneration = durable.generation;
          ownerToken = durable.token;
        } else {
          ownerGeneration = 1;
          ownerToken = randomUUID();
        }
      }
      const decision = store.admitCommand({
        digestInput: {
          threadId,
          taskId: this.host.parity.liveAuthority?.taskContract.task_id ?? this.host.engineRunId,
          commandId,
          mode: this.host.executionProfile,
          resolvedOperationPolicy: {
            taskClass: this.host.taskClass,
            executionProfile: this.host.executionProfile,
            hardPlanMode: this.host.options.hardPlanMode === true,
          },
          taskShapeClass: this.host.taskClass,
          targetRoot: this.host.options.projectRoot,
          offeredToolSchemaVersion: CHAT_ADMISSION_TOOL_SCHEMA_VERSION,
          contextSnapshotId: commandId,
          payload: {
            kind: 'chat_submission',
            input_sha256: createHash('sha256').update(userInput).digest('hex'),
          },
        },
        ownerGeneration,
        ownerToken,
        ...(previousOwnerToken !== undefined ? { previousOwnerToken } : {}),
        leaseId: this.host.admissionEpoch,
        // A chat command's durable effect is its thread/session event-log
        // append — reconcilable after a crash, never silently replayed as ok.
        effectClass: 'reconcilable_mutation',
        operationId: `chat-submission:${threadId}:${commandId}`,
      });
      if (decision.kind === 'admitted' || decision.kind === 'pending') {
        this.host.admissionLease = { generation: ownerGeneration, token: ownerToken };
        const claim: ChatEngineAdmissionClaim = {
          threadId,
          commandId,
          generation: ownerGeneration,
          token: ownerToken,
          submissionGeneration,
          settled: false,
        };
        this.host.activeAdmissionClaim = claim;
        return claim;
      }
      // Rejected or replayed: fail closed — no live claim, and a rejected
      // admission means this engine is not the durable owner.
      this.host.activeAdmissionClaim = null;
      if (decision.kind === 'rejected') this.host.admissionLease = null;
      return null;
    } catch {
      // Record-only: never break execution, but never keep claim state that
      // admission did not durably prove.
      this.host.activeAdmissionClaim = null;
      this.host.admissionLease = null;
      return null;
    }
  }

  /** Settle an admitted claim at command settlement (terminal/replacement/close). */
  settleAdmissionClaim(
    claim: ChatEngineAdmissionClaim,
    state: 'settled' | 'aborted' | 'indeterminate',
    outcome: unknown,
  ): void {
    if (claim.settled) return;
    try {
      const store = this.host.parity.admissionStore;
      if (store) {
        const input = {
          threadId: claim.threadId,
          commandId: claim.commandId,
          ownerGeneration: claim.generation,
          ownerToken: claim.token,
          state,
          outcome,
        } as const;
        const decision = store.settleAdmission(input);
        // A1: a gen-N command superseded before settlement can no longer
        // prove success under current authority — record it as indeterminate
        // instead of leaving it 'claimed' forever.
        if (
          !decision.settled &&
          state === 'settled' &&
          decision.reasonCode === ADMISSION_REASONS.STALE_OWNER
        ) {
          store.settleAdmission({ ...input, state: 'indeterminate' });
        }
      }
    } catch {
      // Record-only: a failed settle leaves the claim 'claimed' for recovery
      // (fail-closed manual review) and never blocks the caller.
    } finally {
      claim.settled = true;
    }
  }

  /**
   * Exit settlement for a CAPTURED claim — never the mutable
   * `activeAdmissionClaim`, which during task replacement already belongs to
   * the successor. A claim already settled by the replacement's admission is
   * a correct no-op here. Cancellation is derived PER CLAIM: `this.host._cancelled`
   * only describes the submission that owns `activeSubmissionGeneration`, so a
   * successor's reset of that flag can never re-label this claim.
   */
  settleClaimOnExit(claim: ChatEngineAdmissionClaim | null): void {
    if (!claim || claim.settled) return;
    const isCurrent =
      this.host.activeAdmissionClaim === claim ||
      claim.submissionGeneration === this.host.activeSubmissionGeneration;
    if (!isCurrent) {
      // Superseded while still live: a command that no longer executes can
      // never record success (the replacement's admission normally settled it
      // as aborted already — this covers paths that did not).
      this.settleAdmissionClaim(claim, 'indeterminate', {
        finalOutcome: 'SUPERSEDED_BY_SUBMISSION',
      });
      return;
    }
    this.settleAdmissionClaim(claim, this.host._cancelled ? 'aborted' : 'settled', {
      finalOutcome: this.host._cancelled ? 'CANCELLED' : 'CHAT_SUBMISSION_TERMINAL',
    });
  }

  /** Terminal settlement for the engine's currently-active claim. */
  settleActiveAdmissionClaim(): void {
    this.settleClaimOnExit(this.host.activeAdmissionClaim);
  }

  private currentInstalledContextLineage(
    checkpointId: string,
  ): ContextCheckpointInstalledLineageV1 {
    const committed = [...this.host.parity.sessionEvents.events]
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
    const capsule = this.host.parity.eventLog.events.find(
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

  /**
   * R1/T5: id of the latest durable `compaction_committed` session event, or
   * null when this session has committed no compaction at all.
   */
  private latestDurableCompactionCommitId(): string | null {
    const events = this.host.parity.sessionEvents.events;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.kind === 'compaction_committed') return event.event_id;
    }
    return null;
  }

  /**
   * R1/T5: true while a durable compaction commit exists that the in-memory
   * installed context root does not name — the exact "stale root silently
   * suppresses the newer capsule" window (routed Task-4 trace). False on
   * capsule-less turns and on turns whose promoted root already names the
   * latest commit, which keeps the non-compacting path byte-identical to the
   * previous ordering.
   */
  hasPendingCompactionAuthority(): boolean {
    const latestCommit = this.latestDurableCompactionCommitId();
    if (latestCommit === null) return false;
    const installedCommit =
      this.host.parity.contextCheckpoint?.installed_lineage?.compaction_commit_event_id ?? null;
    return latestCommit !== installedCommit;
  }

  /**
   * Shared preparation input for the R1/T5 candidate prepare and the installing
   * prepare: identical checkpoint id, epoch, and lineage (derived AFTER the
   * capsule commit, so both name the same current capsule). Only
   * `sources.route.compiled_request_identity` differs between the two, and the
   * route identity is never an input to the rebuild or to the lineage — so the
   * candidate-rooted rebuild and the installed-authority rebuild are the same
   * message sequence by construction.
   */
  private p11CheckpointPreparationInput(
    owner: ContextCheckpointOwnerV1,
    sources: LiveOperationalSourcesV1,
  ): ContextCheckpointPreparationInputV1 {
    const checkpointId = `context:${this.host.parity.turnId ?? this.host._turnIndex}:${this.host.workingState.revision}`;
    return {
      checkpointId,
      sessionId: this.host.engineRunId,
      turnId: this.host.parity.turnId,
      contextEpoch: `${owner.generation}:${this.host.workingState.revision}:${sources.workspace?.capture_epoch ?? 'unknown'}`,
      owner,
      sources,
      installedLineage: this.currentInstalledContextLineage(checkpointId),
    };
  }

  /**
   * R1/T5: side-effect-free candidate of THIS turn's context checkpoint.
   * `prepareContextCheckpoint` is documented as detached — preparation never
   * installs — so the candidate only roots the pre-install rebuild that
   * computes this turn's compiled request identity. It never dispatches on its
   * own: only `installP11ContextCheckpoint` swaps the durable authority, and it
   * re-prepares from the live sources with the REAL identity (the candidate's
   * pending marker can therefore never become durable authority). Blocked or
   * unavailable candidate ⇒ null ⇒ the turn falls back to the in-memory root
   * and the dispatch guard refuses when authority stays pending.
   */
  prepareP11ContextCheckpointCandidate(route: {
    tool_profile: string;
    model_route: string;
  }): ContextCheckpointPreparationResultV1 | null {
    // A5 fence (same as install): the candidate is rooted in THIS engine's own
    // admitted identity — never a synthetic owner.
    const owner = this.currentP11Owner();
    if (!owner || !this.host.parity.admissionStore) return null;
    const sources = this.host.buildP11Sources({
      ...route,
      compiled_request_identity: PENDING_COMPILED_REQUEST_IDENTITY,
    });
    if (!sources) return null;
    const prepared = prepareContextCheckpoint(this.p11CheckpointPreparationInput(owner, sources));
    return prepared.status === 'prepared' ? prepared : null;
  }

  currentRecoveryBinding(): RecoveryCandidateBinding | null {
    try {
      const root = canonicalizeContained(this.host.options.projectRoot);
      const revision = recoveryWorkspaceRevision(root);
      if (!revision) return null;
      const fingerprint = repoRootFingerprint(root);
      const ownerId = this.host.taskAllowance?.taskOwnerId ?? this.host.engineRunId;
      return {
        schemaVersion: 1,
        taskId: this.host.parity.liveAuthority?.taskContract.task_id ?? ownerId,
        contractHash: this.host.parity.liveAuthority?.taskContract.contract_hash ?? `uncontracted:${ownerId}`,
        repositoryIdentity: JSON.stringify([root, fingerprint]),
        workspaceRevision: revision,
      };
    } catch {
      return null;
    }
  }

  private currentP11Workspace(): ReturnType<typeof RevisionManager.computeRevisionSync> | null {
    try {
      return RevisionManager.computeRevisionSync(this.host.options.projectRoot, [], {
        scope_kind: 'repository',
        git_binding: 'optional',
      });
    } catch {
      return null;
    }
  }

  captureP11Observation(
    action: ChatToolAction,
    result: { index: number; observation: string },
    meta: { index: number; idempotencyKey: string; ownerGeneration: number },
  ): void {
    if (!result.observation || !this.host.isSubmissionCurrent(meta.ownerGeneration)) return;
    const taskId = this.host.parity.liveAuthority?.taskContract.task_id ?? this.host.engineRunId;
    const operationId = meta.idempotencyKey;
    const turnId = this.host.parity.turnId ?? `turn-${this.host._turnIndex}`;
    const workspace = this.currentP11Workspace();
    const logEntry = [...this.host.toolCallLog]
      .reverse()
      .find((entry) => entry.index === meta.index && entry.tool === chatActionToolName(action));
    const previousObservation = this.host.p11ObservationRefs.find(
      (observation) => observation.invocation.operation_id === operationId,
    );
    const captured = captureApprovedObservation(
      {
        invocation: {
          operation_id: operationId,
          task_id: taskId,
          run_id: this.host.engineRunId,
          turn_id: turnId,
          attempt_id: operationId,
        },
        sections: [{ channel: 'stdout', content: result.observation }],
        execution_status: logEntry?.exit_code === 0 || logEntry?.exit_code === undefined ? 'succeeded' : 'failed',
        permitted_principals: ['agent:main'],
        data_policy: {
          approved: true,
          policy_version: 'babel-chat-model-readable-v1',
          redaction_policy_version: 'babel-chat-redaction-v1',
        },
        ...(workspace
          ? {
              snapshot_ref: workspace.compositeTreeHash,
              coverage_ref: workspace.compositeTreeHash,
            }
          : {}),
        ...(previousObservation ? { previous_observation: previousObservation } : {}),
      },
      {
        storage_root: join(this.host.engineRunDir, 'observations'),
        clock: () => new Date().toISOString(),
        policy: { durability: 'fsync_file_and_dir' },
      },
    );
    if (captured.status === 'captured') {
      this.host.p11ObservationRefs = [
        ...this.host.p11ObservationRefs.filter(
          (observation) => observation.observation_id !== captured.observation.observation_id,
        ),
        captured.observation,
      ];
      (this.host.parity.authorizedObservationIds ??= new Set()).add(captured.observation.observation_id);
    } else {
      this.host.p11ObservationCaptureIssues.push(
        captured.status === 'blocked' ? captured.reason : captured.reason,
      );
    }
  }

  buildP11Sources(
    routeOverride?: NonNullable<LiveOperationalSourcesV1['route']>,
  ): LiveOperationalSourcesV1 | null {
    const authority = this.host.parity.liveAuthority;
    const workspace = this.currentP11Workspace();
    const allowance = this.host.taskAllowance;
    const latestInput = [...this.host.parity.sessionEvents.events]
      .reverse()
      .find((event) => event.kind === 'model_input_receipt');
    const route = routeOverride ?? (
      latestInput && latestInput.kind === 'model_input_receipt'
        ? {
            compiled_request_identity: latestInput.body_digest ?? latestInput.input_digest,
            tool_profile: this.host.shouldUseTextTools() ? 'text-tools' : 'native-tools',
            model_route: `${latestInput.provider}:${latestInput.sent_model_id}`,
          }
        : null
    );
    if (!authority || !workspace || !allowance || !route) {
      return null;
    }
    const interrupted = interruptedToolRecoveries(this.host.parity.sessionEvents).map((item) => ({
      handle_id: item.idempotencyKey,
      kind: item.toolName.includes('sub_agent') || item.toolName.includes('child') ? 'child' as const : 'operation' as const,
      state: item.state === 'TOOL_OUTCOME_UNKNOWN' ? 'indeterminate' as const : 'pending' as const,
    }));
    const workingState = {
      current_hypothesis:
        this.host.workingState.currentHypothesis || this.host.workingState.goal || 'active chat context',
      unresolved_failures: [
        ...(this.host.workingState.failureSurface?.errorSignature
          ? [this.host.workingState.failureSurface.errorSignature]
          : []),
        ...this.host.workingState.openQuestions,
      ],
      next_experiment: this.host.workingState.nextExperiment || 'continue the current controller step',
    };
    const receipts = this.host.lastVerifierReceipt
      ? [{
          receipt_id: this.host.lastVerifierReceipt.receiptId ?? `receipt:${this.host.lastVerifierReceipt.command}`,
          identity: this.host.lastVerifierReceipt.verifierId ?? this.host.lastVerifierReceipt.command,
          scope: this.host.lastVerifierReceipt.scope ?? 'unknown',
          stale: this.host.lastVerifierReceipt.stale === true,
          bound_revision: this.host.lastVerifierReceipt.boundRevision?.compositeTreeHash ?? null,
        }]
      : [];
    const observations = this.host.p11ObservationRefs.map((observation) => ({
      observation_id: observation.observation_id,
      payload_sha256: observation.payloads[0]?.sha256 ?? '',
      authorized: this.host.parity.authorizedObservationIds?.has(observation.observation_id) === true,
    }));
    return {
      resumed: this.host.options.resumeExisting === true,
      task_contract: {
        goal: authority.taskContract.goal,
        acceptance_clause_ids: authority.taskContract.acceptance.map((item) => item.id),
        contract_hash: authority.taskContract.contract_hash,
      },
      working_state: workingState,
      workspace: {
        current_snapshot_revision: workspace.compositeTreeHash,
        capture_complete: true,
        coverage_ref: workspace.compositeTreeHash,
        capture_provenance: 'current_capture',
        capture_epoch: `${workspace.capturedAt}:${workspace.compositeTreeHash}`,
      },
      receipts,
      budget: {
        owner: allowance.taskOwnerId,
        remaining_allowance: Math.max(0, allowance.grant.turnCap - allowance.consumed.turns),
        cancellation_owner: allowance.taskOwnerId,
      },
      pending: interrupted,
      route,
      observations,
      observation_manifest: this.host.p11ObservationRefs,
      authorized_observation_ids: [...(this.host.parity.authorizedObservationIds ?? [])],
      observation_recovery_issues: [...this.host.p11ObservationCaptureIssues],
      legacy_observation_refs: [],
    };
  }

  async installP11ContextCheckpoint(
    routeOverride?: NonNullable<LiveOperationalSourcesV1['route']>,
  ): Promise<boolean> {
    const sources = this.host.buildP11Sources(routeOverride);
    if (!sources) return false;
    // A5 fence: the claimed owner is THIS engine's own admitted identity
    // (admitted ∩ durable, see currentP11Owner) — never a fresh read that
    // would validate itself. A losing/superseded engine resolves null here.
    const owner = this.currentP11Owner();
    if (!owner || !this.host.parity.admissionStore) return false;
    // Same checkpoint id / epoch / lineage derivation as the R1/T5 candidate
    // prepare (p11CheckpointPreparationInput), now with the REAL compiled
    // request identity computed from this turn's rebuilt messages.
    const prepared = prepareContextCheckpoint(this.p11CheckpointPreparationInput(owner, sources));
    if (prepared.status !== 'prepared') return false;
    const previous = this.host.parity.contextCheckpoint;
    // Durable re-read: the installer's claimed (admitted) identity must still
    // match the owner row of record before the checkpoint may install.
    const ownerNow = this.host.parity.admissionStore.readOwner(owner.threadId);
    if (!ownerNow) return false;
    if (ownerNow.generation !== owner.generation || ownerNow.token !== owner.token) return false;
    const installed = await installContextCheckpoint(prepared, {
      currentOwner: {
        threadId: ownerNow.threadId,
        generation: ownerNow.generation,
        token: ownerNow.token,
      },
      requireInstalledLineage: true,
      authorizedObservationIds: [...(this.host.parity.authorizedObservationIds ?? [])],
      lineageEvidence: {
        threadEvents: this.host.parity.eventLog.events,
        sessionEvents: this.host.parity.sessionEvents.events,
      },
      readCurrentOwner: () => {
        const current = this.host.parity.admissionStore?.readOwner(owner.threadId) ?? null;
        return current
          ? { threadId: current.threadId, generation: current.generation, token: current.token }
          : null;
      },
      install: async (checkpoint, _owner, assertOwnerCurrent) => {
        this.host.parity.contextCheckpoint = checkpoint;
        const receipt = await checkpointParityEventLogStrict(this.host.parity, this.host.engineRunDir, {
          ...(assertOwnerCurrent ? { assertOwnerCurrent } : {}),
        });
        if (receipt.status !== 'committed') {
          if (previous) this.host.parity.contextCheckpoint = previous;
          else delete this.host.parity.contextCheckpoint;
          throw new Error(receipt.error ?? 'checkpoint persistence blocked');
        }
      },
    });
    return installed.status === 'installed';
  }

  /**
   * Execute a batch of tool actions sequentially through the policy gate.
   * Each action emits start/complete callbacks for the ConversationalRenderer.
   */
  loadObservationMembership(sessionDir: string = this.host.engineRunDir): void {
    const liveSnapshot = loadLiveSessionSnapshot(sessionDir);
    this.host.parity.authorizedObservationIds = new Set(
      liveSnapshot?.authorized_observation_ids ?? [],
    );
  }

  /**
   * Authoritative context-authority hydration — the single path used by every
   * resume/construction entrypoint. Loads `context-checkpoint.json`, requires
   * the durable owner and installed lineage to validate, independently
   * re-authorizes the observation manifest against durable session membership,
   * and only then promotes the checkpoint to provider context. A checkpoint
   * that cannot prove ownership, lineage, and observation membership stays
   * advisory/inert and the durable thread/session logs remain the only source.
   */
  hydrateInstalledContextAuthority(sessionDir: string = this.host.engineRunDir): {
    applied: boolean;
    issues: string[];
  } {
    const issues: string[] = [];
    const checkpointPath = join(sessionDir, "context-checkpoint.json");
    if (!existsSync(checkpointPath)) return { applied: false, issues };
    const threadId = this.host.parity.eventLog.thread_id;
    // Durable session membership for model-readable observations is loaded from
    // the live-session snapshot; a checkpoint manifest cannot grant its own.
    this.loadObservationMembership(sessionDir);
    try {
      const checkpoint = JSON.parse(
        readFileSync(checkpointPath, "utf8"),
      ) as ContextCheckpointV1;
      const durableOwner =
        this.host.parity.admissionStore?.readOwner(threadId) ?? null;
      const lineageEvidence: ContextCheckpointLineageEvidenceV1 = {
        threadEvents: this.host.parity.eventLog.events,
        sessionEvents: this.host.parity.sessionEvents.events,
      };
      const coldResume = validateContextCheckpoint(checkpoint, {
        expectedThreadId: threadId,
        currentOwner: durableOwner,
        requireInstalledLineage: true,
        authorizedObservationIds: [
          ...(this.host.parity.authorizedObservationIds ?? []),
        ],
        lineageEvidence,
      });
      if (coldResume.status !== "valid") {
        issues.push(coldResume.reasons.join("; "));
        return { applied: false, issues };
      }
      const authorizedObservationIds = [
        ...(this.host.parity.authorizedObservationIds ?? []),
      ];
      const resolvedObservations = checkpoint.observation_manifest.map(
        (observation) =>
        resolveObservation(
          observation.observation_id,
          {
              principal_id: "agent:main",
            authorized_observation_ids: authorizedObservationIds,
          },
          {
              storage_root: join(this.host.engineRunDir, "observations"),
            clock: () => new Date().toISOString(),
              policy: { durability: "none" },
          },
        ),
      );
      const unavailable = resolvedObservations
        .map((result, index) =>
          result.status === "resolved"
            ? null
            : `observation ${checkpoint.observation_manifest[index]?.observation_id ?? "unknown"} unavailable: ${result.reason}`,
        )
        .filter((issue): issue is string => issue !== null);
      if (unavailable.length > 0) {
        // An authorized id with no durable payload must not silently
        // reconstruct partial trusted context.
        this.host.p11ObservationCaptureIssues = unavailable;
        issues.push(...unavailable);
        return { applied: false, issues };
      }
      this.host.parity.contextCheckpoint = checkpoint;
      this.host.p11ObservationRefs = resolvedObservations
        .map((result) =>
          result.status === "resolved" ? result.observation : null,
        )
        .filter(
          (observation): observation is ObservationRefV1 =>
            observation !== null,
        );
      return { applied: true, issues };
    } catch (err) {
      // A malformed or stale context checkpoint is unavailable evidence;
      // durable thread/session logs remain the only resume source.
      issues.push(err instanceof Error ? err.message : String(err));
      return { applied: false, issues };
    }
  }

}
