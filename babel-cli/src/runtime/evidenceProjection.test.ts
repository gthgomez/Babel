import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createTrustedExecutionReadPortInternal } from '../authority/trustedExecutionPort.js';
import { RevisionManager } from '../evidence/revisionBoundReceipt.js';
import { ReceiptIndex } from '../evidence/receiptIndex.js';
import {
  createEvidenceReadApi,
  projectCompletionExplanation,
  terminalOutcomeFromExplanation,
  type ProjectCompletionExplanationInput,
} from './evidenceProjection.js';
import type { RuntimeFactV1 } from './events.js';
import { projectTask } from './projection.js';
import type { CompletionDecision } from '../executor/contracts.js';
import { createExecutorKernel } from '../executor/kernel.js';

const VERIFIED_DECISION: CompletionDecision = {
  requestedOutcome: 'VERIFIED_COMPLETE',
  finalOutcome: 'VERIFIED_COMPLETE',
  allowed: true,
  reason: 'proof_carrying_completion_accepted',
  evidenceRefs: ['receipt-1'],
  policyVersion: 'executor-contract-v1',
};

function fact(input: {
  sequence: number;
  id: string;
  authority: 'authoritative' | 'observation';
  payload: RuntimeFactV1['payload'];
}): RuntimeFactV1 {
  return {
    schemaVersion: 1,
    id: input.id,
    cursor: { stream: 'runtime-facts', sequence: input.sequence },
    threadId: 'thread-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    runId: 'run-1',
    sequence: input.sequence,
    causationId: input.id,
    producer: 'runtime_coordinator',
    authority: input.authority,
    timestamp: '2026-09-19T00:00:00.000Z',
    payload: input.payload,
  };
}

function completionProjection(
  finalOutcome: string,
  authority: 'authoritative' | 'observation',
) {
  return projectTask([
    fact({
      sequence: 0,
      id: 'completion-1',
      authority,
      payload: {
        type: 'completion.decided',
        decision: {
          requestedOutcome: finalOutcome,
          finalOutcome,
          allowed: finalOutcome === 'VERIFIED_COMPLETE',
          reason: 'test_decision',
          evidenceRefs: ['receipt-1'],
          policyVersion: 'executor-contract-v1',
        },
      },
    }),
  ]);
}

function availableReceipt() {
  return {
    receipt_id: 'receipt-1',
    command: 'npm test',
    verifier_id: 'verifier-1',
    authority_source: 'built_in_runner',
    authority: true,
    exit_code: 0,
    stale: false,
  };
}

test('P07 explanation: kernel non-promotion invariant — unverified stays unverified', () => {
  const kernel = createExecutorKernel('chat');
  const decision = kernel.completion.decide({
    mode: 'chat',
    requestedOutcome: 'VERIFIED_COMPLETE',
    hasWrite: true,
    verificationPolicy: 'strict',
    toolCallLog: [],
    proof: { compliant: false, errors: ['missing evidence'] },
  });
  assert.equal(decision.finalOutcome, 'UNVERIFIED_PATCH');
  assert.equal(decision.allowed, false);
  const projection = projectTask([]);
  const explanation = projectCompletionExplanation({ projection, decision });

  assert.equal(explanation.authority.promoted_by_kernel, false);
  assert.equal(explanation.authority.effective_verified, false);
  assert.equal(explanation.authority.promoter, 'executor_kernel');
  assert.equal(explanation.outcome.authoritative, false);
  assert.equal(explanation.read_enabled, true);
  assert.equal(terminalOutcomeFromExplanation(explanation), 'UNVERIFIED_PATCH');
});

test('P07 explanation: a verified decision without an authoritative projection disables the read API', () => {
  const projection = completionProjection('VERIFIED_COMPLETE', 'observation');
  assert.equal(projection.outcome?.authoritative, false);
  const explanation = projectCompletionExplanation({
    projection,
    decision: VERIFIED_DECISION,
    verification_receipt: availableReceipt(),
  });
  assert.equal(explanation.authority.promoted_by_kernel, true);
  assert.equal(explanation.authority.effective_verified, false);
  assert.equal(explanation.read_enabled, false);
  assert.ok(
    explanation.authority.reasons.includes(
      'verified_decision_without_authoritative_projection',
    ),
  );
});

test('P07 explanation: an authoritative projection mirrors kernel promotion, never exceeds it', () => {
  const projection = completionProjection('VERIFIED_COMPLETE', 'authoritative');
  const explanation = projectCompletionExplanation({
    projection,
    decision: VERIFIED_DECISION,
    verification_receipt: availableReceipt(),
  });
  assert.equal(explanation.authority.effective_outcome_authoritative, true);
  assert.equal(explanation.authority.promoted_by_kernel, true);
  assert.equal(explanation.authority.effective_verified, true);
  assert.equal(explanation.read_enabled, true);
  assert.equal(explanation.verification.state, 'available');

  // A promoted decision with no available receipt cannot be explained as verified.
  const withoutReceipt = projectCompletionExplanation({
    projection,
    decision: VERIFIED_DECISION,
  });
  assert.equal(withoutReceipt.verification.state, 'not_recorded');
  assert.equal(withoutReceipt.authority.effective_verified, false);
  assert.equal(withoutReceipt.read_enabled, false);
});

test('P07 explanation: forged trusted producer is refused and cannot authorize a promotion', () => {
  const projection = completionProjection('VERIFIED_COMPLETE', 'authoritative');
  const query = {
    run_id: 'run-1',
    task_id: 'task-1',
    contract_hash: 'contract-1',
    endpoint_id: 'verifier:forged',
    role: 'verifier' as const,
    execution_domain: 'isolated-verifier',
  };

  // An unbranded, caller-fabricated read port cannot establish trust.
  const forged = projectCompletionExplanation({
    projection,
    decision: VERIFIED_DECISION,
    verification_receipt: availableReceipt(),
    trusted_execution: { authorize: () => ({ authorized: true }) } as never,
    trusted_producer: query,
  });
  assert.equal(forged.producer.trusted, false);
  assert.equal(forged.verification.state, 'untrusted_producer');
  assert.equal(forged.authority.effective_verified, false);
  assert.equal(forged.read_enabled, false);
  assert.match(forged.explanation, /trusted=false/);

  // A branded port that refuses the binding also fails closed.
  const refusing = createTrustedExecutionReadPortInternal(
    {
      authorize: () => ({ authorized: false, error: 'endpoint is not trusted for this run' }),
      get: () => undefined,
      assignmentsForRun: () => [],
    },
    true,
  );
  const explanation = projectCompletionExplanation({
    projection,
    decision: VERIFIED_DECISION,
    verification_receipt: availableReceipt(),
    trusted_execution: refusing,
    trusted_producer: query,
  });
  assert.equal(explanation.producer.trusted, false);
  assert.equal(explanation.verification.state, 'untrusted_producer');
  assert.equal(explanation.read_enabled, false);
});

test('P07 explanation: wrong oracle contract is reported, not passed off as verified', () => {
  const projection = completionProjection('VERIFIED_COMPLETE', 'authoritative');
  const explanation = projectCompletionExplanation({
    projection,
    decision: VERIFIED_DECISION,
    verification_receipt: availableReceipt(),
    oracle: { kind: 'acceptance_contract', contract_hash: 'actual' },
    expected_oracle: { kind: 'acceptance_contract', contract_hash: 'expected' },
  });
  assert.equal(explanation.oracle.matches_expected, false);
  assert.equal(explanation.verification.state, 'wrong_contract');
  assert.ok(explanation.verification.issues.includes('oracle_contract_mismatch'));
  assert.equal(explanation.authority.effective_verified, false);
  assert.equal(explanation.read_enabled, false);
});

test('P07 explanation: a stale receipt is re-checked through existing revision authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-evidence-projection-'));
  try {
    const file = join(root, 'a.txt');
    writeFileSync(file, 'v1', 'utf8');
    const boundRevision = RevisionManager.computeRevisionSync(root, ['a.txt']);
    // Workspace moves after verification: existing authority marks it stale.
    writeFileSync(file, 'v2', 'utf8');

    const projection = completionProjection('VERIFIED_COMPLETE', 'authoritative');
    const explanation = projectCompletionExplanation({
      projection,
      decision: VERIFIED_DECISION,
      verification_receipt: {
        ...availableReceipt(),
        bound_revision: boundRevision,
        stale: false,
      },
      project_root: root,
    });
    assert.equal(explanation.verification.stale, true);
    assert.equal(explanation.verification.state, 'stale');
    assert.equal(explanation.authority.effective_verified, false);
    assert.equal(explanation.read_enabled, false);
    assert.ok(
      explanation.authority.reasons.some((reason) =>
        reason.startsWith('verified_decision_without_available_receipt:'),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P07 explanation: legacy receipt stays inspectable without acquiring stronger authority', () => {
  const projection = completionProjection('UNVERIFIED_PATCH', 'observation');
  const explanation = projectCompletionExplanation({
    projection,
    decision: {
      requestedOutcome: 'UNVERIFIED_PATCH',
      finalOutcome: 'UNVERIFIED_PATCH',
      allowed: false,
      reason: 'non_verified_terminal_preserved',
      evidenceRefs: [],
      policyVersion: 'executor-contract-v1',
    },
    verification_receipt: {
      receipt_id: 'legacy-receipt',
      command: 'npm test',
      exit_code: 0,
    },
  });
  assert.equal(explanation.verification.state, 'available');
  assert.ok(explanation.verification.issues.includes('missing_revision_binding'));
  assert.equal(explanation.verification.authority, false);
  assert.equal(explanation.coverage.manifest.completeness, 'unknown');
  assert.equal(explanation.coverage.complete, false);
  assert.equal(explanation.authority.effective_verified, false);
  assert.equal(explanation.read_enabled, true);
});

test('P07 explanation: read API returns unavailable for missing objects and survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-evidence-api-'));
  try {
    const first = ReceiptIndex.open({ directory: dir });
    first.recordReceipt({ receipt_id: 'receipt-1', payload: availableReceipt() });
    const api = createEvidenceReadApi({ receiptIndex: ReceiptIndex.open({ directory: dir }) });
    assert.equal(api.read_only, true);
    assert.equal(api.lookupReceipt('receipt-1').status, 'available');
    assert.equal(api.lookupReceipt('missing').status, 'unavailable');

    const projection = completionProjection('VERIFIED_COMPLETE', 'authoritative');
    const result = api.explainCompletion({
      projection,
      decision: VERIFIED_DECISION,
      verification_receipt: availableReceipt(),
    });
    assert.equal(result.enabled, true);
    assert.equal(result.explanation.authority.effective_verified, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P07 explanation: projection never mutates its inputs', () => {
  const projection = completionProjection('VERIFIED_COMPLETE', 'authoritative');
  const decision: CompletionDecision = { ...VERIFIED_DECISION, evidenceRefs: ['receipt-1'] };
  const beforeProjection = structuredClone(projection);
  const beforeDecision = structuredClone(decision);
  const input: ProjectCompletionExplanationInput = {
    projection,
    decision,
    verification_receipt: availableReceipt(),
  };
  projectCompletionExplanation(input);
  assert.deepEqual(projection, beforeProjection);
  assert.deepEqual(decision, beforeDecision);
});
