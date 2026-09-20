import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ingestVerifierResult } from './codingLoop/chatBindings.js';
import {
  applyWorkingStateEvent,
  createWorkingState,
  formatWorkingStateBlock,
  upsertWorkingStateMessage,
} from './codingLoop/workingState.js';
import { buildChatTurnPrompt } from './chatToolDefinitions.js';

test('repeated repair evidence gate changes the next strategy before mutation', () => {
  let state = createWorkingState('fix bug X');
  state = applyWorkingStateEvent(state, {
    type: 'set_hypothesis',
    hypothesis: 'the parser is the cause',
  });
  state = applyWorkingStateEvent(state, { type: 'mutation', path: 'src/parser.ts' });
  const first = ingestVerifierResult({
    state,
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
  assert.ok(state.recoveryGate?.mutationFingerprint);
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
  // a counter or model prose alone cannot clear this gate.
  state = applyWorkingStateEvent(state, {
    type: 'add_evidence',
    evidence: 'read src/parser.ts and the caller boundary',
    file: 'src/parser.ts',
  });
  assert.equal(state.recoveryGate?.satisfied, true);
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
