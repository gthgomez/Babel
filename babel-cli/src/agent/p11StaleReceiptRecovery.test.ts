/**
 * P11 stale-evidence recovery (chat-reliability-20261004, P1).
 *
 * The compiled-module probe showed the P11 population mapper accepted fresh
 * receipts and the no-verifier state but REJECTED a stale-only receipt set.
 * The provider was therefore blocked before it could rerun verification: no
 * install ⇒ no dispatch ⇒ no verifier rerun ⇒ permanent deadlock.
 *
 * Contract under test (production path, `installP11ContextCheckpoint`):
 *  - a stale-only receipt set still installs the next context generation,
 *    carrying the stale evidence truthfully into the new context;
 *  - staleness continues to close VERIFIED completion: the completion proof
 *    with a stale receipt stays non-compliant (no fresh receipt ⇒ no verified
 *    completion), so recovery never bypasses the completion gate.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ChatEngineP11Authority,
  type ChatEngineP11Host,
} from './chatEngineP11Authority.js';
import type {
  ParityRuntime,
  PersistenceReceipt,
} from './chatEngineParityBridge.js';
import type {
  ContextCheckpointOwnerV1,
  LiveOperationalSourcesV1,
} from '../runtime/contextCheckpoints.js';
import { evaluateChatCompletionProof } from '../evidence/chatRevisionBinding.js';
import type { WorkingState } from './codingLoop/workingState.js';

const OWNER: ContextCheckpointOwnerV1 = {
  threadId: 'thread-stale-recovery',
  generation: 7,
  token: 'owner-token-7',
};

function makeHarness(receiptStale: boolean): {
  authority: ChatEngineP11Authority;
  parity: ParityRuntime;
  root: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'p11-stale-recovery-'));
  const state = {
    sources: null as LiveOperationalSourcesV1 | null,
  };
  const parity = {
    turnId: 'turn-stale-recovery',
    admissionStore: {
      readOwner: (threadId: string) =>
        threadId === OWNER.threadId ? { ...OWNER } : null,
    },
    eventLog: { events: [] as Array<{ kind: string; event_id?: string; seq?: number }> },
    sessionEvents: { events: [] as Array<{ kind: string }> },
    authorizedObservationIds: new Set<string>(),
    liveAuthority: {
      taskContract: {
        goal: 'recover from stale verifier evidence',
        acceptance: [{ id: 'rerun-verifier' }],
        contract_hash: 'contract-stale-recovery',
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
    engineRunId: 'run-stale-recovery',
    executionProfile: 'safe_repo',
    lastVerifierReceipt: null,
    options: { projectRoot: root } as ChatEngineP11Host['options'],
    p11InstallBlock: null,
    p11ObservationCaptureIssues: [],
    p11ObservationRefs: [],
    parity,
    taskAllowance: {
      taskOwnerId: 'task-stale-recovery',
      grant: { turnCap: 50 },
      consumed: { turns: 1 },
    },
    taskClass: 'Chat',
    toolCallLog: [],
    workingState: {
      revision: 1,
      goal: 'recover from stale verifier evidence',
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
  authority.strictCheckpointPort = async (): Promise<PersistenceReceipt> =>
    ({ status: 'committed' }) as PersistenceReceipt;

  state.sources = {
    resumed: false,
    task_contract: {
      goal: 'recover from stale verifier evidence',
      acceptance_clause_ids: ['rerun-verifier'],
      contract_hash: 'contract-stale-recovery',
    },
    working_state: {
      current_hypothesis: 'the receipt is stale; rerun the verifier',
      unresolved_failures: ['verifier receipt is stale'],
      next_experiment: 'rerun the required verifier',
    },
    workspace: {
      current_snapshot_revision: 'snapshot-current',
      capture_complete: true,
      coverage_ref: 'coverage-current',
      capture_provenance: 'current_capture',
      capture_epoch: 'capture-stale-recovery',
    },
    receipts: [
      {
        receipt_id: 'receipt-stale',
        identity: 'npm test',
        scope: 'full_suite',
        stale: receiptStale,
        bound_revision: 'snapshot-historical',
        exit_code: 0,
      },
    ],
    budget: {
      owner: 'task-stale-recovery',
      remaining_allowance: 10_000,
      cancellation_owner: 'task-stale-recovery',
    },
    pending: [],
    route: {
      compiled_request_identity: 'request-stale-recovery',
      tool_profile: 'native-tools',
      model_route: 'test-model',
    },
    observations: [],
    authorized_observation_ids: [],
    observation_recovery_issues: [],
    legacy_observation_refs: [],
  };

  return { authority, parity, root };
}

test('a stale-only receipt set still installs the next context generation', async () => {
  const { authority, root } = makeHarness(true);
  try {
    const installed = await authority.installP11ContextCheckpoint({
      compiled_request_identity: 'request-stale-recovery',
      tool_profile: 'native-tools',
      model_route: 'test-model',
    });
    assert.equal(installed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staleness still closes verified completion while recovery continues', async () => {
  // The recovery path unblocks dispatch; it must NOT let a stale receipt
  // certify completion. The proof boundary stays fail-closed.
  const proof = evaluateChatCompletionProof({
    projectRoot: '.',
    hasMutation: true,
    verifierTampered: false,
    receipt: {
      command: 'npm test',
      exit_code: 0,
      exitCode: 0,
      summary: 'ok',
      stale: true,
      staleReason: 'File modified after verification: src/mod.ts',
      receiptId: 'receipt-stale',
      capturedAt: Date.now(),
      authority: true,
      verifier_id: 'npm-test',
      verifierId: 'npm-test',
      argv: ['npm', 'test'],
      authority_source: 'built_in_runner',
      authoritySource: 'built_in_runner',
      scope: 'full_suite',
    },
    events: [
      { kind: 'mutation_batch', paths: ['src/mod.ts'] },
      { kind: 'verifier_attempt', authoritative: true, exit_code: 0 },
    ],
    isAuthoritativeCommand: () => true,
    env: { BABEL_INDEPENDENT_VERIFIER: '0' },
  });
  assert.equal(proof.compliant, false);
  assert.ok(proof.errors?.some((error) => /stale/i.test(error)));
});
