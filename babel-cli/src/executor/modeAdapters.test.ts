import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionDescriptor } from './contracts.js';
import { buildPreparedTurn, resolveModeCapability } from './modeAdapters.js';

test('chat and plan are supported on the chat controller', () => {
  const chat = resolveModeCapability('chat');
  assert.deepEqual(
    { submission: chat.submission, resume: chat.resume, controller: chat.controller },
    { submission: true, resume: true, controller: 'chat_engine' },
  );

  const plan = resolveModeCapability('plan');
  assert.equal(plan.submission, true);
  assert.equal(plan.resume, true);
  assert.equal(plan.controller, 'chat_engine');
});

test('deep is explicitly unsupported until the V9 controller is wired', () => {
  const deep = resolveModeCapability('deep');
  assert.equal(deep.submission, false);
  assert.equal(deep.resume, false);
  assert.equal(deep.controller, 'v9_pipeline');
  assert.ok(deep.reason && deep.reason.length > 0, 'unsupported mode must carry a reason');
});

test('every mode resolves to an explicit capability', () => {
  for (const mode of ['chat', 'plan', 'deep'] as const) {
    const capability = resolveModeCapability(mode);
    assert.equal(capability.mode, mode);
    assert.equal(typeof capability.submission, 'boolean');
    assert.equal(typeof capability.resume, 'boolean');
  }
});

test('buildPreparedTurn carries controller identity and no renderer state', () => {
  const descriptor: SessionDescriptor = {
    schemaVersion: 1,
    threadId: 'chat-abc',
    projectRoot: '/repo',
    mode: 'chat',
    provider: 'openai',
    model: 'gpt-x',
    policyProfile: 'safe_repo',
    createdAt: new Date().toISOString(),
    kernelVersion: 'executor-kernel-v1',
    contractVersion: 'executor-contract-v1',
    task: 'do the thing',
  };
  const prepared = buildPreparedTurn(descriptor);
  assert.deepEqual(Object.keys(prepared).sort(), [
    'controller',
    'mode',
    'model',
    'policyProfile',
    'projectRoot',
    'provider',
    'task',
    'threadId',
  ]);
  assert.equal(prepared.controller, 'chat_engine');
  assert.equal(prepared.task, 'do the thing');
  assert.equal(prepared.projectRoot, '/repo');
});

test('buildPreparedTurn defaults the task and routes deep to the pipeline controller', () => {
  const descriptor: SessionDescriptor = {
    schemaVersion: 1,
    threadId: 'chat-xyz',
    projectRoot: '/repo',
    mode: 'deep',
    provider: 'default',
    model: 'default',
    policyProfile: 'safe_repo',
    createdAt: new Date().toISOString(),
    kernelVersion: 'executor-kernel-v1',
    contractVersion: 'executor-contract-v1',
  };
  const prepared = buildPreparedTurn(descriptor);
  assert.equal(prepared.task, 'Session chat-xyz');
  assert.equal(prepared.controller, 'v9_pipeline');
});
