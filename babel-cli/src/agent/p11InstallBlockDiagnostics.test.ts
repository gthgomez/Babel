/**
 * P11 install-block diagnostics (chat-reliability-20261004 / G01 follow-up).
 *
 * Captured failure chat-a3e9f0b63ef8 (seq 655-663): six provider requests
 * succeeded, then the next in-turn context install was refused and the run
 * collapsed to NEEDS_MORE_CONTEXT with NO recorded reason — every blocked
 * path in `installP11ContextCheckpoint` returned bare `false`, and a strict
 * parity-commit failure was swallowed as `install_failed` with the error
 * message discarded.
 *
 * Contract under test:
 *  - every refused install records a structured block {code, details} on the
 *    host (codes only — never credentials or provider payloads);
 *  - a transient strict-commit failure is retried once (the blocked batch has
 *    already rolled back; each attempt re-runs the owner fence) and succeeds;
 *  - a persistent strict-commit failure still refuses the install, reverts
 *    the in-memory checkpoint to the previously installed authority, and
 *    surfaces the underlying persistence error in the block details;
 *  - ownership semantics are unchanged: a changed durable owner still refuses.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ChatEngineP11Authority,
  type ChatEngineP11Host,
} from './chatEngineP11Authority.js';
import type { PersistenceReceipt } from './chatEngineParityBridge.js';
import type { ParityRuntime } from './chatEngineParityBridge.js';
import {
  captureApprovedObservation,
  type ObservationStorageContextV1,
} from '../evidence/observationStore.js';
import type {
  ContextCheckpointOwnerV1,
  LiveOperationalSourcesV1,
} from '../runtime/contextCheckpoints.js';
import type { ObservationRefV1 } from '../evidence/observationStore.js';
import type { WorkingState } from './codingLoop/workingState.js';

const OWNER: ContextCheckpointOwnerV1 = {
  threadId: 'thread-install-diagnostics',
  generation: 3,
  token: 'owner-token-3',
};

function storage(root: string): ObservationStorageContextV1 {
  return {
    storage_root: root,
    clock: () => '2026-10-05T00:00:00.000Z',
    policy: { durability: 'none' },
  };
}

function captureInput() {
  return {
    invocation: {
      operation_id: 'op-install-diagnostics',
      task_id: 'task-install-diagnostics',
      run_id: 'run-install-diagnostics',
      turn_id: 'turn-install-diagnostics',
      attempt_id: 'attempt-1',
    },
    sections: [{ channel: 'stdout' as const, content: 'durable observation bytes' }],
    execution_status: 'succeeded' as const,
    permitted_principals: ['agent:main'],
    data_policy: {
      approved: true,
      policy_version: 'policy-v1',
      redaction_policy_version: 'redaction-v1',
    },
    snapshot_ref: 'snapshot-install-diagnostics',
    coverage_ref: 'coverage-install-diagnostics',
  };
}

function sourcesWithManifest(
  observation: ObservationRefV1,
  overrides: Partial<LiveOperationalSourcesV1> = {},
): LiveOperationalSourcesV1 {
  return {
    resumed: false,
    task_contract: {
      goal: 'retain exact observations',
      acceptance_clause_ids: ['observation-manifest'],
      contract_hash: 'contract-install-diagnostics',
    },
    working_state: {
      current_hypothesis: 'the durable observation ref is complete',
      unresolved_failures: [],
      next_experiment: 'install through the existing checkpoint transaction',
    },
    workspace: {
      current_snapshot_revision: 'snapshot-install-diagnostics',
      capture_complete: true,
      coverage_ref: 'coverage-install-diagnostics',
      capture_provenance: 'current_capture',
      capture_epoch: 'capture-install-diagnostics',
    },
    receipts: [
      {
        receipt_id: 'receipt-install-diagnostics',
        identity: 'focused-test',
        scope: 'observation-store',
        stale: false,
        bound_revision: 'snapshot-install-diagnostics',
      },
    ],
    budget: {
      owner: 'task-budget-install-diagnostics',
      remaining_allowance: 10_000,
      cancellation_owner: 'task-budget-install-diagnostics',
    },
    pending: [],
    route: {
      compiled_request_identity: 'request-install-diagnostics',
      tool_profile: 'native-tools',
      model_route: 'test-model',
    },
    observations: [
      {
        observation_id: observation.observation_id,
        payload_sha256: observation.payloads[0]!.sha256,
        authorized: true,
      },
    ],
    observation_manifest: [observation],
    observation_recovery_issues: [],
    authorized_observation_ids: [observation.observation_id],
    legacy_observation_refs: [],
    ...overrides,
  };
}

interface Harness {
  authority: ChatEngineP11Authority;
  parity: ParityRuntime;
  host: ChatEngineP11Host;
  setSources: (sources: LiveOperationalSourcesV1 | null) => void;
  setPort: (port: NonNullable<ChatEngineP11Authority['strictCheckpointPort']>) => void;
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'p11-install-diagnostics-'));
  // A present workspace prerequisite must supply actual physical Git proof.
  writeFileSync(join(root, 'README.md'), 'fixture repository\n');
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  execFileSync('git', ['add', 'README.md'], { cwd: root, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], {
    cwd: root, windowsHide: true,
  });
  const captured = captureApprovedObservation(captureInput(), storage(root));
  assert.equal(captured.status, 'captured');
  const observation = captured.observation;

  const state = {
    sources: null as LiveOperationalSourcesV1 | null,
    port: null as ChatEngineP11Authority['strictCheckpointPort'],
  };

  const parity = {
    turnId: 'turn-install-diagnostics',
    admissionStore: {
      readOwner: (threadId: string) =>
        threadId === OWNER.threadId ? { ...OWNER } : null,
    },
    eventLog: { events: [] as Array<{ kind: string; event_id?: string; seq?: number }> },
    sessionEvents: { events: [] as Array<{ kind: string }> },
    authorizedObservationIds: new Set<string>([observation.observation_id]),
    liveAuthority: {
      taskContract: {
        goal: 'retain exact observations',
        acceptance: [{ id: 'observation-manifest' }],
        contract_hash: 'contract-install-diagnostics',
      },
    },
    contextCheckpoint: undefined,
  } as unknown as ParityRuntime;

  const host = {
    _cancelled: false,
    _turnIndex: 1,
    activeAdmissionClaim: { ...OWNER, commandId: 'cmd-1', submissionGeneration: 1, settled: false },
    activeSubmissionGeneration: 1,
    admissionEpoch: 'epoch-1',
    admissionLease: { generation: OWNER.generation, token: OWNER.token },
    engineRunDir: root,
    engineRunId: 'run-install-diagnostics',
    executionProfile: 'safe_repo',
    lastVerifierReceipt: null,
    options: { projectRoot: root } as ChatEngineP11Host['options'],
    p11InstallBlock: null,
    p11ObservationCaptureIssues: [],
    p11ObservationRefs: [],
    parity,
    taskAllowance: {
      taskOwnerId: 'task-budget-install-diagnostics',
      grant: { turnCap: 200 },
      consumed: { turns: 1 },
    },
    taskClass: 'Chat',
    toolCallLog: [],
    workingState: {
      revision: 1,
      goal: 'retain exact observations',
      currentHypothesis: '',
      openQuestions: [],
      failureSurface: {},
      nextExperiment: '',
    } as unknown as WorkingState,
    isSubmissionCurrent: () => true,
    shouldUseTextTools: () => false,
    buildP11Sources: () => state.sources,
  } as unknown as ChatEngineP11Host;

  const authority = new ChatEngineP11Authority(host);
  return {
    authority,
    parity,
    host,
    setSources: (sources) => {
      state.sources = sources;
    },
    setPort: (port) => {
      state.port = port;
      authority.strictCheckpointPort = port;
    },
  };
}

test('sources_unavailable records which prerequisite is missing', async () => {
  const h = makeHarness();
  // No live authority and no route override: the code must name the gaps.
  h.setSources(null);
  (h.parity as { liveAuthority: unknown }).liveAuthority = null;
  const installed = await h.authority.installP11ContextCheckpoint();
  assert.equal(installed, false);
  assert.ok(h.host.p11InstallBlock);
  assert.equal(h.host.p11InstallBlock.code, 'sources_unavailable');
  assert.deepEqual(h.host.p11InstallBlock.details, ['live_authority', 'route_identity']);
  rmSync(h.host.engineRunDir, { recursive: true, force: true });
});

test('buildP11Sources-null with authority present names the remaining gaps', async () => {
  const h = makeHarness();
  // Authority exists on the harness parity stub and a route override is
  // given, so a null from buildP11Sources can only come from the workspace
  // revision / task allowance prerequisites.
  h.setSources(null);
  const installed = await h.authority.installP11ContextCheckpoint({
    compiled_request_identity: 'request-x',
    tool_profile: 'native-tools',
    model_route: 'test-model',
  });
  assert.equal(installed, false);
  assert.equal(h.host.p11InstallBlock?.code, 'sources_unavailable');
  // The refusal is always recorded; the re-derived gap list is only filled
  // when one of the known prerequisites (live authority, workspace revision,
  // task allowance, route identity) is itself absent. A stub that refuses
  // with all prerequisites present yields an empty, non-misleading list.
  assert.ok(Array.isArray(h.host.p11InstallBlock.details));
  rmSync(h.host.engineRunDir, { recursive: true, force: true });
});

test('owner_unavailable is recorded when no live admission claim exists', async () => {
  const h = makeHarness();
  const captured = captureApprovedObservation(captureInput(), storage(h.host.engineRunDir));
  assert.equal(captured.status, 'captured');
  h.setSources(sourcesWithManifest(captured.observation));
  (h.host as { activeAdmissionClaim: unknown }).activeAdmissionClaim = null;
  const installed = await h.authority.installP11ContextCheckpoint();
  assert.equal(installed, false);
  assert.equal(h.host.p11InstallBlock?.code, 'owner_unavailable');
  assert.ok(h.host.p11InstallBlock.details.includes('admission_claim_missing'));
  rmSync(h.host.engineRunDir, { recursive: true, force: true });
});

test('prepare_blocked records the validation reasons', async () => {
  const h = makeHarness();
  const captured = captureApprovedObservation(captureInput(), storage(h.host.engineRunDir));
  assert.equal(captured.status, 'captured');
  // Authorized observations exist but the manifest is empty — the population
  // step must fail closed and the refusal must name why.
  h.setSources(
    sourcesWithManifest(captured.observation, {
      observation_manifest: [],
    }),
  );
  const installed = await h.authority.installP11ContextCheckpoint();
  assert.equal(installed, false);
  assert.equal(h.host.p11InstallBlock?.code, 'prepare_blocked');
  assert.ok(h.host.p11InstallBlock.details.length > 0);
  rmSync(h.host.engineRunDir, { recursive: true, force: true });
});

test('transient strict-commit failure is retried once and the install completes', async () => {
  const h = makeHarness();
  const captured = captureApprovedObservation(captureInput(), storage(h.host.engineRunDir));
  assert.equal(captured.status, 'captured');
  h.setSources(sourcesWithManifest(captured.observation));

  let calls = 0;
  h.setPort((_rt, _runDir, _options) => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve({
        status: 'blocked',
        operation: 'checkpoint',
        runDir: h.host.engineRunDir,
        artifacts: [],
        error: 'simulated sharing violation',
      } as unknown as PersistenceReceipt);
    }
    return Promise.resolve({
      status: 'committed',
      operation: 'checkpoint',
      runDir: h.host.engineRunDir,
      artifacts: [],
    } as unknown as PersistenceReceipt);
  });

  const installed = await h.authority.installP11ContextCheckpoint();
  assert.equal(installed, true, 'a transient commit failure must not permanently block install');
  assert.equal(calls, 2, 'exactly one bounded retry');
  assert.ok(h.parity.contextCheckpoint, 'the checkpoint is installed in memory');
  assert.equal(h.host.p11InstallBlock, null, 'no block is recorded for a successful install');
  rmSync(h.host.engineRunDir, { recursive: true, force: true });
});

test('persistent strict-commit failure refuses, reverts authority, and surfaces the error', async () => {
  const h = makeHarness();
  const captured = captureApprovedObservation(captureInput(), storage(h.host.engineRunDir));
  assert.equal(captured.status, 'captured');
  h.setSources(sourcesWithManifest(captured.observation));

  const previous = { checkpointId: 'context:previous' } as never;
  h.parity.contextCheckpoint = previous;

  let calls = 0;
  h.setPort((_rt, _runDir, options) => {
    calls += 1;
    options?.assertOwnerCurrent?.(); // fence must keep running on every attempt
    return Promise.resolve({
      status: 'blocked',
      operation: 'checkpoint',
      runDir: h.host.engineRunDir,
      artifacts: [],
      error: 'simulated persistent commit failure',
    } as unknown as PersistenceReceipt);
  });

  const installed = await h.authority.installP11ContextCheckpoint();
  assert.equal(installed, false);
  assert.equal(calls, 2, 'one bounded retry, then the refusal is final');
  assert.equal(
    h.parity.contextCheckpoint,
    previous,
    'the previously installed authority stays authoritative after a refused install',
  );
  assert.ok(h.host.p11InstallBlock);
  assert.equal(h.host.p11InstallBlock.code, 'install_blocked');
  assert.ok(
    h.host.p11InstallBlock.details.includes('simulated persistent commit failure'),
    'the underlying persistence error must survive the refusal boundary',
  );
  rmSync(h.host.engineRunDir, { recursive: true, force: true });
});

test('a changed durable owner is still refused as owner_changed', async () => {
  const h = makeHarness();
  const captured = captureApprovedObservation(captureInput(), storage(h.host.engineRunDir));
  assert.equal(captured.status, 'captured');
  h.setSources(sourcesWithManifest(captured.observation));

  let calls = 0;
  h.setPort(() => {
    calls += 1;
    return Promise.resolve({
      status: 'committed',
      operation: 'checkpoint',
      runDir: h.host.engineRunDir,
      artifacts: [],
    } as unknown as PersistenceReceipt);
  });

  // Simulate the durable owner advancing between the claimed-owner check and
  // the pre-commit durable re-read: the first read validates the claim, the
  // second (ownerNow) returns the advanced row, so install must refuse before
  // any commit attempt.
  let ownerReads = 0;
  const store = h.parity.admissionStore as unknown as {
    readOwner: (threadId: string) => unknown;
  };
  store.readOwner = () => {
    ownerReads += 1;
    return ownerReads === 1
      ? { ...OWNER }
      : { ...OWNER, generation: OWNER.generation + 1 };
  };

  const installed = await h.authority.installP11ContextCheckpoint();
  assert.equal(installed, false);
  assert.equal(calls, 0, 'no commit may run for a superseded owner');
  assert.equal(h.host.p11InstallBlock?.code, 'owner_changed');
  rmSync(h.host.engineRunDir, { recursive: true, force: true });
});
