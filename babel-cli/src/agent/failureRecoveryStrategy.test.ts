import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ingestVerifierResult } from './codingLoop/chatBindings.js';
import {
  applyWorkingStateEvent,
  createWorkingState,
  formatWorkingStateBlock,
  recordControllerRecoveryStrategy,
  sameRecoveryBinding,
  targetMatchesGate,
  upsertWorkingStateMessage,
} from './codingLoop/workingState.js';
import { buildChatTurnPrompt } from './chatToolDefinitions.js';

const TEST_BINDING = {
  schemaVersion: 1 as const,
  taskId: 'task-1', contractHash: 'contract-1',
  repositoryIdentity: '/repo', workspaceRevision: 'revision-A',
};

test('repeated repair evidence gate changes the next strategy before mutation', () => {
  let state = createWorkingState('fix bug X');
  state = applyWorkingStateEvent(state, {
    type: 'set_hypothesis',
    hypothesis: 'the parser is the cause',
  });
  state = applyWorkingStateEvent(state, { type: 'mutation', path: 'src/parser.ts' });
  const first = ingestVerifierResult({
    state,
    recoveryBinding: TEST_BINDING,
    tool: 'test_run',
    target: 'npm test -- parser',
    exitCode: 1,
    stdout: 'FAIL tests failed: parser adds values',
    stderr: '',
    summary: 'same assertion remains red',
  });
  state = first.state;
  assert.equal(first.lastVerifierFailed, true);
  assert.equal(state.recoveryGate?.satisfied, false);
  assert.equal(state.recoveryGate?.mutationFingerprint, undefined);
  assert.match(formatWorkingStateBlock(state), /evidence_required/);
  assert.match(formatWorkingStateBlock(state), /caller\/callee/);
  const nextProviderPrompt = buildChatTurnPrompt({
    conversation: upsertWorkingStateMessage([{ role: 'system', content: 'controller policy' }], state),
    task: 'continue the accepted repair',
    textTools: true,
  });
  assert.match(nextProviderPrompt, /Acquire discriminating evidence/);
  assert.match(nextProviderPrompt, /caller\/callee boundary/);

  // A discriminating read is the controller-recognized evidence transition;
  // a counter or model prose alone cannot clear this gate. The boolean is not
  // authority: provenance bound to the gate failure signature is required.
  const failureSignature = state.recoveryGate!.failureSignature;
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence',
    evidence: 'read src/parser.ts and the caller boundary',
    file: 'src/parser.ts',
    discriminating: true,
    provenance: {
      tool: 'read_file',
      target: 'src/parser.ts',
      failureSignature,
      binding: TEST_BINDING,
      observationDigest: 'parser-and-caller-content',
    },
  });
  assert.equal(state.recoveryGate?.satisfied, true);

  // A bare boolean without provenance is not authority.
  let unprovenanced = createWorkingState('fix bug X');
  unprovenanced = applyWorkingStateEvent(unprovenanced, { type: 'mutation', path: 'src/parser.ts' });
  unprovenanced = ingestVerifierResult({
    state: unprovenanced,
    tool: 'test_run',
    target: 'npm test -- parser',
    exitCode: 1,
    stdout: 'FAIL tests failed: parser adds values',
    stderr: '',
    summary: 'same assertion remains red',
  }).state;
  const gateSignature = unprovenanced.recoveryGate!.failureSignature;
  unprovenanced = applyWorkingStateEvent(unprovenanced, {
    type: 'add_evidence',
    evidence: 'read_file:src/parser.ts',
    discriminating: true,
  });
  assert.equal(unprovenanced.recoveryGate?.satisfied, false);

  // Provenance naming the wrong failure signature must not clear the gate.
  unprovenanced = applyWorkingStateEvent(unprovenanced, {
    type: 'add_evidence',
    evidence: 'read_file:src/parser.ts',
    discriminating: true,
    provenance: { tool: 'read_file', target: 'src/parser.ts', failureSignature: 'other-signature' },
  });
  assert.equal(unprovenanced.recoveryGate?.satisfied, false);
  assert.equal(gateSignature.length > 0, true);

  // A non-content tool is not discriminating even with matching provenance.
  unprovenanced = applyWorkingStateEvent(unprovenanced, {
    type: 'add_evidence',
    evidence: 'list_dir:.',
    discriminating: true,
    provenance: { tool: 'list_dir', target: 'src/parser.ts', failureSignature: gateSignature },
  });
  assert.equal(unprovenanced.recoveryGate?.satisfied, false);
});

test('irrelevant evidence does not clear the controller recovery gate', () => {
  let state = createWorkingState('fix bug X');
  state = applyWorkingStateEvent(state, { type: 'set_hypothesis', hypothesis: 'the parser is the cause' });
  state = applyWorkingStateEvent(state, { type: 'mutation', path: 'src/parser.ts' });
  state = ingestVerifierResult({
    state,
    tool: 'test_run',
    target: 'npm test -- parser',
    exitCode: 1,
    stdout: 'FAIL parser adds values',
    stderr: '',
    summary: 'same assertion remains red',
  }).state;

  state = applyWorkingStateEvent(state, {
    type: 'add_evidence',
    evidence: 'list_dir:.',
  });
  assert.equal(state.recoveryGate?.satisfied, false);
});

test('a new hypothesis alone does not admit a post-red mutation', () => {
  let state = createWorkingState('fix bug X');
  state = applyWorkingStateEvent(state, { type: 'set_hypothesis', hypothesis: 'the parser is the cause' });
  state = applyWorkingStateEvent(state, { type: 'mutation', path: 'src/parser.ts' });
  state = ingestVerifierResult({
    state,
    recoveryBinding: TEST_BINDING,
    tool: 'test_run',
    target: 'npm test -- parser',
    exitCode: 1,
    stdout: 'FAIL parser adds values',
    stderr: '',
    summary: 'same assertion remains red',
  }).state;
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence',
    evidence: 'read src/parser.ts and the caller boundary',
    file: 'src/parser.ts',
    discriminating: true,
    provenance: {
      tool: 'read_file',
      target: 'src/parser.ts',
      failureSignature: state.recoveryGate!.failureSignature,
      binding: TEST_BINDING,
      observationDigest: 'parser-and-caller-content',
    },
  });
  assert.equal(state.recoveryGate?.strategyChanged, false);
  state = applyWorkingStateEvent(state, {
    type: 'set_hypothesis',
    hypothesis: 'the caller passes the wrong collection shape',
  });
  assert.equal(state.recoveryGate?.strategyChanged, false);
  assert.equal(state.recoveryGate?.planAdmitted, false);
});

test('accepted evidence proposes investigation without admitting a repair plan', () => {
  let state = createWorkingState('fix bug X');
  state = applyWorkingStateEvent(state, {
    type: 'set_hypothesis',
    hypothesis: 'the parser is the cause',
  });
  state = applyWorkingStateEvent(state, { type: 'mutation', path: 'src/parser.ts' });
  state = ingestVerifierResult({
    state,
    recoveryBinding: TEST_BINDING,
    tool: 'test_run',
    target: 'npm test -- parser',
    exitCode: 1,
    stdout: 'FAIL parser adds values',
    stderr: '',
    summary: 'same assertion remains red',
  }).state;
  const evidence = 'read_file:src/parser.ts';
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence',
    evidence,
    file: 'src/parser.ts',
    discriminating: true,
    provenance: {
      tool: 'read_file',
      target: 'src/parser.ts',
      failureSignature: state.recoveryGate!.failureSignature,
      binding: TEST_BINDING,
      observationDigest: 'parser-content',
    },
  });
  state = recordControllerRecoveryStrategy(state, {
    target: 'src/parser.ts',
    evidence,
  });
  assert.equal(state.recoveryGate?.satisfied, true);
  assert.equal(state.recoveryGate?.strategyChanged, false);
  assert.equal(state.recoveryGate?.planAdmitted, false);
  assert.match(state.nextExperiment, /^controller-investigate:/);
});

test('a gate with no implicated target fails closed', () => {
  let state = createWorkingState('fix bug X');
  state = applyWorkingStateEvent(state, {
    type: 'recovery_gate',
    failureSignature: 'sig-no-targets',
    requiredEvidence: 'inspect the failure',
  });
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence',
    evidence: 'read_file:src/parser.ts',
    discriminating: true,
    provenance: { tool: 'read_file', target: 'src/parser.ts', failureSignature: 'sig-no-targets' },
  });
  assert.equal(state.recoveryGate?.satisfied, false);
});

test('equivalent target spellings cannot defeat failure-scoped dedup', () => {
  let state = createWorkingState('fix bug X');
  state = applyWorkingStateEvent(state, { type: 'mutation', path: 'src/parser.ts' });
  state = ingestVerifierResult({
    state,
    recoveryBinding: TEST_BINDING,
    tool: 'test_run',
    target: 'npm test -- parser',
    exitCode: 1,
    stdout: 'FAIL parser adds values',
    stderr: '',
    summary: 'same assertion remains red',
  }).state;
  const signature = state.recoveryGate!.failureSignature;
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence',
    evidence: 'read_file:src/parser.ts',
    discriminating: true,
    provenance: { tool: 'read_file', target: 'src/parser.ts', failureSignature: signature, binding: TEST_BINDING, observationDigest: 'same-content' },
  });
  assert.equal(state.recoveryGate?.satisfied, true);

  // Re-arm for the same failure, then re-read through an equivalent spelling.
  state = applyWorkingStateEvent(state, {
    type: 'recovery_gate',
    failureSignature: signature,
    requiredEvidence: 'reread',
    failingTargets: ['src/parser.ts'],
    binding: TEST_BINDING,
  });
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence',
    evidence: 'read_file:./src/parser.ts',
    discriminating: true,
    provenance: { tool: 'read_file', target: './src/parser.ts', failureSignature: signature, binding: TEST_BINDING, observationDigest: 'same-content' },
  });
  assert.equal(state.recoveryGate?.satisfied, false);
});

test('an ancestor directory does not localize a failing file', () => {
  let state = createWorkingState('fix bug X');
  state = applyWorkingStateEvent(state, { type: 'mutation', path: 'src/parser.ts' });
  state = ingestVerifierResult({
    state,
    tool: 'test_run',
    target: 'npm test -- parser',
    exitCode: 1,
    stdout: 'FAIL parser adds values',
    stderr: '',
    summary: 'same assertion remains red',
  }).state;
  const signature = state.recoveryGate!.failureSignature;
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence',
    evidence: 'grep:src',
    discriminating: true,
    provenance: { tool: 'grep', target: 'src', failureSignature: signature },
  });
  assert.equal(state.recoveryGate?.satisfied, false);
});

test('an observation from revision A cannot clear the same failure gate at revision B', () => {
  const candidateA = {
    schemaVersion: 1 as const,
    taskId: 'task-1',
    contractHash: 'contract-1',
    repositoryIdentity: '/repo',
    workspaceRevision: 'revision-A',
  };
  const candidateB = { ...candidateA, workspaceRevision: 'revision-B' };
  let state = applyWorkingStateEvent(createWorkingState('fix parser'), {
    type: 'recovery_gate',
    failureSignature: 'same-red-verifier',
    requiredEvidence: 'inspect parser',
    failingTargets: ['src/parser.ts'],
    binding: candidateA,
  });
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence',
    evidence: 'read_file:src/parser.ts#call-A',
    discriminating: true,
    provenance: {
      tool: 'read_file', target: 'src/parser.ts', failureSignature: 'same-red-verifier',
      binding: candidateA, observationDigest: 'payload-A',
    },
  });
  assert.equal(state.recoveryGate?.satisfied, true);

  state = applyWorkingStateEvent(state, {
    type: 'recovery_gate',
    failureSignature: 'same-red-verifier',
    requiredEvidence: 'inspect current parser',
    failingTargets: ['src/parser.ts'],
    binding: candidateB,
  });
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence',
    evidence: 'read_file:src/parser.ts#call-B',
    discriminating: true,
    provenance: {
      tool: 'read_file', target: 'src/parser.ts', failureSignature: 'same-red-verifier',
      binding: candidateA, observationDigest: 'payload-B',
    },
  });
  assert.equal(state.recoveryGate?.satisfied, false, 'stale revision cannot authorize a new repair');
});

test('a new tool call with the same observation payload does not mint another recovery permit', () => {
  const binding = {
    schemaVersion: 1 as const,
    taskId: 'task-1',
    contractHash: 'contract-1',
    repositoryIdentity: '/repo',
    workspaceRevision: 'revision-A',
  };
  let state = applyWorkingStateEvent(createWorkingState('fix parser'), {
    type: 'recovery_gate', failureSignature: 'same-red-verifier', requiredEvidence: 'inspect parser',
    failingTargets: ['src/parser.ts'], binding,
  });
  for (const callId of ['call-1', 'call-2']) {
    if (callId === 'call-2') {
      state = applyWorkingStateEvent(state, {
        type: 'recovery_gate', failureSignature: 'same-red-verifier', requiredEvidence: 'inspect parser',
        failingTargets: ['src/parser.ts'], binding,
      });
    }
    state = applyWorkingStateEvent(state, {
      type: 'add_evidence', evidence: `read_file:src/parser.ts#${callId}`, discriminating: true,
      provenance: {
        tool: 'read_file', target: 'src/parser.ts', failureSignature: 'same-red-verifier',
        binding, observationDigest: 'same-payload',
      },
    });
    assert.equal(state.recoveryGate?.satisfied, callId === 'call-1');
  }
});

test('recovery target matching preserves case and resolves dot segments', () => {
  assert.equal(targetMatchesGate('src/Foo.ts', ['src/foo.ts']), false);
  assert.equal(targetMatchesGate('src/./parser.ts', ['src/parser.ts']), true);
  assert.equal(targetMatchesGate('../src/parser.ts', ['src/parser.ts']), false);
});

test('recovery provenance binds task, contract, repository, revision, and failure', () => {
  const mismatches = [
    { taskId: 'other-task' },
    { contractHash: 'other-contract' },
    { repositoryIdentity: '/other-repo' },
    { workspaceRevision: 'other-revision' },
  ];
  for (const mismatch of mismatches) {
    let state = applyWorkingStateEvent(createWorkingState('repair'), {
      type: 'recovery_gate', failureSignature: 'red', requiredEvidence: 'inspect',
      failingTargets: ['src/parser.ts'], binding: TEST_BINDING,
    });
    state = applyWorkingStateEvent(state, {
      type: 'add_evidence', evidence: 'read_file:src/parser.ts', discriminating: true,
      provenance: {
        tool: 'read_file', target: 'src/parser.ts', failureSignature: 'red',
        binding: { ...TEST_BINDING, ...mismatch }, observationDigest: 'content',
      },
    });
    assert.equal(state.recoveryGate?.satisfied, false, JSON.stringify(mismatch));
  }
  assert.equal(sameRecoveryBinding(TEST_BINDING, { ...TEST_BINDING, workspaceRevision: 'other' }), false);
});

test('serialized recovery evidence stays consumed and legacy permits downgrade', () => {
  let state = applyWorkingStateEvent(createWorkingState('repair'), {
    type: 'recovery_gate', failureSignature: 'red', requiredEvidence: 'inspect',
    failingTargets: ['src/parser.ts'], binding: TEST_BINDING,
  });
  const observation = {
    type: 'add_evidence' as const, evidence: 'read_file:src/parser.ts#call-1', discriminating: true,
    provenance: {
      tool: 'read_file', target: 'src/parser.ts', failureSignature: 'red',
      binding: TEST_BINDING, observationDigest: 'content',
    },
  };
  state = applyWorkingStateEvent(state, observation);
  assert.equal(state.recoveryGate?.satisfied, true);
  state = JSON.parse(JSON.stringify(state));
  state = applyWorkingStateEvent(state, {
    type: 'recovery_gate', failureSignature: 'red', requiredEvidence: 'inspect again',
    failingTargets: ['src/parser.ts'], binding: TEST_BINDING,
  });
  state = applyWorkingStateEvent(state, { ...observation, evidence: 'read_file:src/parser.ts#call-2' });
  assert.equal(state.recoveryGate?.satisfied, false);

  const legacy = JSON.parse(JSON.stringify(state));
  delete legacy.recoveryGate.binding;
  legacy.recoveryGate.satisfied = true;
  legacy.recoveryGate.strategyChanged = true;
  const migrated = applyWorkingStateEvent(legacy, { type: 'next_experiment', experiment: 'recheck' });
  assert.equal(migrated.recoveryGate?.satisfied, false);
  assert.equal(migrated.recoveryGate?.strategyChanged, false);
});

test('a mutation invalidates a previously satisfied recovery permit', () => {
  let state = applyWorkingStateEvent(createWorkingState('repair'), {
    type: 'recovery_gate', failureSignature: 'red', requiredEvidence: 'inspect',
    failingTargets: ['src/parser.ts'], binding: TEST_BINDING,
  });
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence', evidence: 'read_file:src/parser.ts', discriminating: true,
    provenance: {
      tool: 'read_file', target: 'src/parser.ts', failureSignature: 'red',
      binding: TEST_BINDING, observationDigest: 'content',
    },
  });
  assert.equal(state.recoveryGate?.satisfied, true);
  state = applyWorkingStateEvent(state, { type: 'mutation', path: 'src/parser.ts' });
  assert.equal(state.recoveryGate?.satisfied, false);
});

test('environment and provider failures stay outside implementation recovery gate', () => {
  let state = createWorkingState('fix bug X');
  state = applyWorkingStateEvent(state, { type: 'mutation', path: 'src/parser.ts' });
  const environment = ingestVerifierResult({
    state,
    tool: 'run_command',
    target: 'npm test',
    exitCode: 1,
    stdout: '',
    stderr: 'ENOSPC: no space left on device',
    summary: 'environment failed',
  });
  assert.equal(environment.state.failureSurface?.kind, 'ENVIRONMENT_FAILURE');
  assert.equal(environment.state.recoveryGate, undefined);

  const processEnvironment = ingestVerifierResult({
    state,
    tool: 'run_command',
    target: 'node test runner',
    exitCode: 1,
    stdout: '',
    stderr: 'spawn EPERM',
    summary: 'process launch failed',
  });
  assert.equal(processEnvironment.state.failureSurface?.kind, 'ENVIRONMENT_FAILURE');
  assert.equal(processEnvironment.state.recoveryGate, undefined);

  const provider = ingestVerifierResult({
    state: createWorkingState('fix bug X'),
    tool: 'run_command',
    target: 'provider request',
    exitCode: 1,
    stdout: '',
    stderr: 'provider ECONNRESET',
    summary: 'transport failed',
  });
  assert.equal(provider.state.failureSurface?.kind, 'PROVIDER_FAILURE');
  assert.equal(provider.state.recoveryGate, undefined);
});

test('baseline causality is only asserted from a controller-captured pre-mutation failure', () => {
  let state = createWorkingState('fix bug X');
  const baseline = ingestVerifierResult({
    state,
    tool: 'test_run',
    target: 'npm test -- parser',
    exitCode: 1,
    stdout: 'FAIL tests failed: parser adds values',
    stderr: '',
    summary: 'baseline red',
  });
  state = applyWorkingStateEvent(baseline.state, { type: 'mutation', path: 'src/parser.ts', fingerprint: 'h1' });
  const repeated = ingestVerifierResult({
    state,
    tool: 'test_run',
    target: 'npm test -- parser',
    exitCode: 1,
    stdout: 'FAIL parser adds values',
    stderr: '',
    summary: 'same baseline red',
  });
  assert.equal(repeated.state.failureSurface?.kind, 'BASELINE_FAILURE');
  assert.equal(repeated.state.failureSurface?.causality, 'pre_existing');
});
