import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RateBudget, RateBudgetExhaustedError, RateBudgetPausedError } from './rateBudget.js';

test('zero response byte budget prevents the first request', () => {
  const budget = new RateBudget(100, 30, 0);
  assert.throws(() => budget.beforeRequest('core'), RateBudgetExhaustedError);
  assert.equal(budget.snapshot().requestsIssued, 0);
  assert.equal(budget.snapshot().state, 'EXHAUSTED');
});

test('binding a smaller mission ceiling preserves consumed bytes and cannot replenish capacity', () => {
  const budget = new RateBudget(100, 30, 100);
  budget.recordBytes(20);
  budget.limitRemoteBytes(30);
  assert.equal(budget.remainingBytes, 10);
  budget.limitRemoteBytes(1000);
  assert.equal(budget.remainingBytes, 10);
  budget.limitRemoteBytes(15);
  assert.equal(budget.bytes, 20);
  assert.equal(budget.remainingBytes, 0);
  assert.throws(() => budget.beforeRequest('core'), RateBudgetExhaustedError);
});

test('budget counts requests and search requests separately', () => {
  const budget = new RateBudget(100, 2);
  budget.beforeRequest('search');
  budget.beforeRequest('core');
  budget.beforeRequest('search');
  assert.throws(() => budget.beforeRequest('search'), RateBudgetExhaustedError);
  budget.beforeRequest('core');
  const snap = budget.snapshot();
  assert.equal(snap.requestsIssued, 4);
  assert.equal(snap.searchRequests, 2);
  assert.equal(snap.state, 'OK');
});

test('budget respects x-ratelimit-remaining=0 until reset', () => {
  const budget = new RateBudget();
  budget.beforeRequest('core');
  const futureReset = Math.floor(Date.now() / 1000) + 1800;
  budget.recordHeaders(
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(futureReset) },
    100,
  );
  assert.throws(() => budget.beforeRequest('core'), RateBudgetPausedError);
  const snap = budget.snapshot();
  assert.equal(snap.state, 'EXHAUSTED');
  assert.equal(snap.remainingPrimary, 0);
  assert.equal(snap.bytesDownloaded, 100);
});

test('retry-after header sets an explicit backoff window', () => {
  const budget = new RateBudget();
  budget.recordHeaders({ 'retry-after': '30' }, 0);
  assert.throws(() => budget.beforeRequest('core'), RateBudgetPausedError);
  const snap = budget.snapshot();
  assert.equal(snap.state, 'BACKOFF');
  assert.ok(snap.backoffUntil);
});

test('quota exhaustion clears after the reset time passes', () => {
  const budget = new RateBudget();
  const pastReset = Math.floor(Date.now() / 1000) - 10;
  budget.recordHeaders({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(pastReset) }, 0);
  budget.beforeRequest('core');
  assert.equal(budget.snapshot().state, 'OK');
});

test('errors and retries are tracked for the receipt', () => {
  const budget = new RateBudget();
  budget.recordError();
  budget.recordRetry();
  const snap = budget.snapshot();
  assert.equal(snap.errors, 1);
  assert.equal(snap.retries, 1);
});
