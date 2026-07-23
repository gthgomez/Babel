/**
 * latencyAdapter.test.ts — Tests for LatencyAdapter recommendations.
 *
 * Tests verify that the adapter returns correct frame intervals and
 * feature flags for each latency bucket.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LatencyAdapter } from './latencyAdapter.js';
import { SshLatencyDetector } from './latencyProbe.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockLatency(rtt: number | null, isSsh: boolean): void {
  SshLatencyDetector.resetInstance();
  const detector = SshLatencyDetector.getInstance();
  (detector as any)._rtt = rtt;
  (detector as any)._isSsh = isSsh;
  LatencyAdapter.resetInstance();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Recommendations by bucket
// ═══════════════════════════════════════════════════════════════════════════════

test('local: 33ms, all features enabled', () => {
  mockLatency(1, false);
  const recs = LatencyAdapter.getInstance().getRecommendations();
  assert.equal(recs.frameIntervalMs, 33);
  assert.equal(recs.enableSpinner, true);
  assert.equal(recs.enableMouseTracking, true);
  assert.equal(recs.enableSyncUpdate, true);
});

test('lan: 66ms, all features enabled', () => {
  mockLatency(25, true);
  const recs = LatencyAdapter.getInstance().getRecommendations();
  assert.equal(recs.frameIntervalMs, 66);
  assert.equal(recs.enableSpinner, true);
  assert.equal(recs.enableMouseTracking, true);
  assert.equal(recs.enableSyncUpdate, true);
});

test('wan: 200ms, no expensive features', () => {
  mockLatency(200, true);
  const recs = LatencyAdapter.getInstance().getRecommendations();
  assert.equal(recs.frameIntervalMs, 200);
  assert.equal(recs.enableSpinner, false);
  assert.equal(recs.enableMouseTracking, false);
  assert.equal(recs.enableSyncUpdate, false);
});

test('wan: null RTT on SSH → 200ms, no features', () => {
  mockLatency(null, true);
  const recs = LatencyAdapter.getInstance().getRecommendations();
  assert.equal(recs.frameIntervalMs, 200);
  assert.equal(recs.enableSpinner, false);
});

test('local: null RTT on non-SSH → 33ms, features on', () => {
  mockLatency(null, false);
  const recs = LatencyAdapter.getInstance().getRecommendations();
  assert.equal(recs.frameIntervalMs, 33);
  assert.equal(recs.enableSpinner, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. isHighLatency
// ═══════════════════════════════════════════════════════════════════════════════

test('isHighLatency: false for local', () => {
  mockLatency(1, false);
  assert.equal(LatencyAdapter.getInstance().isHighLatency, false);
});

test('isHighLatency: false for lan', () => {
  mockLatency(25, true);
  assert.equal(LatencyAdapter.getInstance().isHighLatency, false);
});

test('isHighLatency: true for wan', () => {
  mockLatency(100, true);
  assert.equal(LatencyAdapter.getInstance().isHighLatency, true);
});

test('isHighLatency: true for SSH with unknown RTT', () => {
  mockLatency(null, true);
  assert.equal(LatencyAdapter.getInstance().isHighLatency, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. getSummary
// ═══════════════════════════════════════════════════════════════════════════════

test('getSummary: includes frame interval and feature flags', () => {
  mockLatency(100, true);
  const summary = LatencyAdapter.getInstance().getSummary();
  assert.ok(summary.includes('200ms'), 'summary should include frame interval');
  assert.ok(summary.includes('disabled'), 'summary should note disabled features');
});

test('getSummary: shows enabled features for local', () => {
  mockLatency(1, false);
  const summary = LatencyAdapter.getInstance().getSummary();
  assert.ok(summary.includes('33ms'));
  assert.ok(summary.includes('enabled'));
});
