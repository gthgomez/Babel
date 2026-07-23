/**
 * Protocol smoke tests — parse sample envelopes, assert catalog uniqueness.
 *
 * Run: npx tsx --test src/protocol/protocol.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BABEL_PROTOCOL_METHODS,
  BABEL_PROTOCOL_NOTIFICATIONS,
  BABEL_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  type ThreadCreateRequest,
  type ThreadCreateResponse,
  type TurnEventNotification,
} from './index.js';

test('BABEL_PROTOCOL_VERSION is defined', () => {
  assert.equal(BABEL_PROTOCOL_VERSION, '1.0.0');
});

test('all protocol method strings are unique', () => {
  const methods = [...BABEL_PROTOCOL_METHODS];
  assert.equal(new Set(methods).size, methods.length);
  assert.equal(methods.length, 5);
});

test('all protocol notification strings are unique', () => {
  const notifications = [...BABEL_PROTOCOL_NOTIFICATIONS];
  assert.equal(new Set(notifications).size, notifications.length);
  assert.equal(notifications.length, 2);
});

test('methods and notifications do not overlap', () => {
  const methodSet = new Set<string>(BABEL_PROTOCOL_METHODS);
  for (const n of BABEL_PROTOCOL_NOTIFICATIONS) {
    assert.equal(methodSet.has(n), false, `notification ${n} collides with a method name`);
  }
});

test('sample thread.create request parses and round-trips', () => {
  const request: ThreadCreateRequest = {
    jsonrpc: JSON_RPC_VERSION,
    id: 1,
    method: 'thread.create',
    params: {
      project_root: '/workspace/demo',
      task: 'fix the failing test',
      model: 'deepseek-chat',
    },
  };

  const raw = JSON.stringify(request);
  const parsed = JSON.parse(raw) as ThreadCreateRequest;

  assert.equal(parsed.jsonrpc, '2.0');
  assert.equal(parsed.method, 'thread.create');
  assert.equal(parsed.id, 1);
  assert.ok(parsed.params);
  assert.equal(parsed.params.project_root, '/workspace/demo');
  assert.equal(parsed.params.task, 'fix the failing test');
  assert.equal(parsed.params.model, 'deepseek-chat');
});

test('sample thread.create response round-trips', () => {
  const response: ThreadCreateResponse = {
    jsonrpc: JSON_RPC_VERSION,
    id: 'req-42',
    result: { thread_id: 'thr_abc123' },
  };

  const parsed = JSON.parse(JSON.stringify(response)) as ThreadCreateResponse;
  assert.equal(parsed.result.thread_id, 'thr_abc123');
});

test('sample turn.event notification has no id field', () => {
  const notification: TurnEventNotification = {
    jsonrpc: JSON_RPC_VERSION,
    method: 'turn.event',
    params: {
      thread_id: 'thr_abc123',
      turn_id: 3,
      seq: 7,
      event: { type: 'answer_chunk', text: 'Hello' },
    },
  };

  const parsed = JSON.parse(JSON.stringify(notification)) as Record<string, unknown>;
  assert.equal('id' in parsed, false);
  assert.equal(parsed.method, 'turn.event');
});

test('catalog method names match expected set', () => {
  assert.deepEqual([...BABEL_PROTOCOL_METHODS].sort(), [
    'history.lookup',
    'thread.create',
    'thread.resume',
    'turn.cancel',
    'turn.submit',
  ]);
});

test('catalog notification names match expected set', () => {
  assert.deepEqual([...BABEL_PROTOCOL_NOTIFICATIONS].sort(), ['cell.committed', 'turn.event']);
});