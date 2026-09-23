import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostTracker, usageDelta } from './costTracker.js';
import { resetGlobalTokenHistoryDb, TokenHistoryDb } from './tokenHistoryDb.js';

test('CostTracker prices direct DeepSeek v4 Flash with conservative cache-miss input', () => {
  const tracker = new CostTracker();
  const cost = tracker.trackUsage('deepseek-v4-flash', 1000, 2000);
  assert.ok(cost !== null);
  const summary = tracker.getSessionSummary();

  assert.ok(Math.abs(cost - 0.0007) < 1e-12);
  assert.ok(Math.abs(summary.totalCostUSD - 0.0007) < 1e-12);
  assert.equal(summary.modelBreakdown['deepseek-v4-flash']?.inputTokens, 1000);
  assert.equal(summary.modelBreakdown['deepseek-v4-flash']?.outputTokens, 2000);
});

test('CostTracker prices direct DeepSeek v4 Pro with conservative cache-miss input', () => {
  const tracker = new CostTracker();
  const cost = tracker.trackUsage('deepseek-v4-pro', 1000, 2000);
  assert.ok(cost !== null);

  assert.ok(Math.abs(cost - 0.002175) < 1e-12);
});

test('usageDelta is this-turn billed usage, never session totals', () => {
  const tracker = new CostTracker();
  tracker.trackUsage('deepseek-v4-flash', 40_000, 396);
  const before = tracker.getSessionSummary();
  tracker.trackUsage('deepseek-v4-flash', 9_000, 286);
  const after = tracker.getSessionSummary();
  const turn = usageDelta(before, after);
  assert.equal(turn.tokens, 9286);
  assert.ok(turn.costUsd > 0);
  assert.ok(turn.tokens < after.totalTokens);
  assert.equal(after.totalTokens, before.totalTokens + turn.tokens);
});

test('CostTracker uses the shared registry for DeepInfra model pricing', () => {
  const tracker = new CostTracker();
  const cost = tracker.trackUsage('Qwen/Qwen3-32B', 1000, 2000);
  assert.ok(cost !== null);

  assert.ok(Math.abs(cost - 0.00064) < 1e-12);
});

test('unknown model pricing stays nullable and does not become a free or fallback charge', () => {
  const tracker = new CostTracker();
  const unknown = tracker.trackUsage('unlisted-provider-model', 1000, 1000, null, null, {
    taskOwnerId: 'owner-A', chargeId: 'unknown-1', accountingEpoch: tracker.getAccountingEpoch(),
  });
  assert.equal(unknown, null);
  const task = JSON.parse(JSON.stringify(tracker.getTaskSummary('owner-A')));
  const session = tracker.getSessionSummary();
  assert.equal(task.completeCostUSD, null);
  assert.equal(task.knownCostUSD, 0);
  assert.equal(task.unknownChargeCount, 1);
  assert.equal(task.costComplete, false);
  assert.equal(session.completeCostUSD, null);
  assert.equal(session.unknownChargeCount, 1);
  assert.equal(tracker.trackUsage('deepseek-v4-flash', 0, 0, null, null, {
    taskOwnerId: 'owner-B', chargeId: 'known-zero',
  }), 0);
  assert.equal(tracker.getTaskSummary('owner-B').completeCostUSD, 0);
  assert.equal(tracker.getSessionSummary().completeCostUSD, null);
  assert.equal(tracker.trackUsage('unlisted-provider-model', 1000, 1000, null, null, {
    taskOwnerId: 'owner-A', chargeId: 'unknown-1',
  }), 0);
  assert.equal(tracker.getTaskSummary('owner-A').unknownChargeCount, 1);
});

test('charge replay cannot change owner or accounting epoch', () => {
  const tracker = new CostTracker();
  const attribution = {
    taskOwnerId: 'owner-A', chargeId: 'attempt-1', accountingEpoch: tracker.getAccountingEpoch(),
  };
  const first = tracker.trackUsage('deepseek-v4-flash', 1000, 100, null, null, attribution);
  assert.ok(first !== null && first > 0);
  assert.equal(tracker.trackUsage('deepseek-v4-flash', 1000, 100, null, null, {
    ...attribution, taskOwnerId: 'owner-B',
  }), 0);
  assert.equal(tracker.getTaskSummary('owner-B').totalCostUSD, 0);
  assert.equal(tracker.getSessionSummary().totalCostUSD, first);
  assert.throws(() => tracker.trackUsage('deepseek-v4-flash', 1000, 100, null, null, {
    ...attribution, chargeId: 'attempt-2', accountingEpoch: 'wrong-epoch',
  }), /different accounting epoch/);
});

test('restored task snapshot keeps unknown cost incomplete without adding a session bill', () => {
  const original = new CostTracker();
  original.recordUnknownCharge('unlisted-provider-model', {
    taskOwnerId: 'owner-A', chargeId: 'unpriced-1',
  });
  const snapshot = JSON.parse(JSON.stringify({
    totalCostUSD: original.getTaskSummary('owner-A').totalCostUSD,
    unknownChargeCount: original.getTaskSummary('owner-A').unknownChargeCount,
    chargeIds: original.getTaskChargeIds('owner-A'),
  }));
  const resumed = new CostTracker();
  resumed.restoreTaskUsage('owner-A', snapshot);
  assert.equal(resumed.getTaskSummary('owner-A').completeCostUSD, null);
  assert.equal(resumed.getTaskSummary('owner-A').unknownChargeCount, 1);
  assert.equal(resumed.getSessionSummary().totalCostUSD, 0);
  assert.equal(resumed.trackUsage('deepseek-v4-flash', 100, 10, null, null, {
    taskOwnerId: 'owner-A', chargeId: 'unpriced-1',
  }), 0);
});

test('a durable charge observation can refine after cold owner restore', () => {
  const original = new CostTracker();
  const attribution = { taskOwnerId: 'owner-A', chargeId: 'attempt-1', requestId: 'request-1', attemptId: 'try-1' };
  original.recordUnknownCharge('deepseek-v4-flash', attribution);
  const snapshot = JSON.parse(JSON.stringify({
    totalCostUSD: original.getTaskSummary('owner-A').totalCostUSD,
    unknownChargeCount: original.getTaskSummary('owner-A').unknownChargeCount,
    chargeIds: original.getTaskChargeIds('owner-A'),
    chargeObservations: original.getTaskChargeObservations('owner-A'),
  }));
  const resumed = new CostTracker();
  resumed.restoreTaskUsage('owner-A', snapshot);
  const result = resumed.settleUsage('deepseek-v4-flash', 1000, 100, null, null, attribution);
  assert.ok(result.kind === 'refined');
  assert.equal(result.unknownDelta, -1);
  assert.equal(resumed.getTaskSummary('owner-A').unknownChargeCount, 0);
  assert.equal(resumed.getTaskSummary('owner-A').totalTokens, 1100);
  assert.ok(resumed.getTaskSummary('owner-A').totalCostUSD > 0);
  assert.equal(resumed.getSessionSummary().unknownChargeCount, 0);
  assert.equal(resumed.getSessionSummary().totalTokens, 1100);
});

test('resume projects a known refinement once against restored session totals', () => {
  const original = new CostTracker();
  const attribution = { taskOwnerId: 'A', chargeId: 'pending-1', attemptId: 'try-1' };
  original.recordUnknownCharge('deepseek-v4-flash', attribution);
  const saved = original.getSessionSummary();
  const snapshot = {
    totalCostUSD: original.getTaskSummary('A').totalCostUSD,
    unknownChargeCount: original.getTaskSummary('A').unknownChargeCount ?? 0,
    chargeIds: original.getTaskChargeIds('A'),
    chargeObservations: original.getTaskChargeObservations('A'),
  };
  const resumed = new CostTracker();
  resumed.restoreSessionCost({ ...saved,
    accountedChargeIds: original.getSessionChargeIds(),
    chargeObservations: original.getSessionChargeObservations(),
  });
  resumed.restoreTaskUsage('A', snapshot);
  const update = resumed.settleUsage('deepseek-v4-flash', 100, 20, null, null, attribution);
  assert.equal(update.kind, 'refined');
  assert.equal(resumed.getSessionSummary().totalTokens, 120);
  assert.equal(resumed.getSessionSummary().unknownChargeCount, 0);
  assert.equal(resumed.getSessionSummary().completeCostUSD, resumed.getTaskSummary('A').totalCostUSD);
  assert.deepEqual(resumed.getSessionChargeIds(), ['pending-1']);
});

test('a pending dispatch survives cold restore and can clear only on proven refusal', () => {
  const original = new CostTracker();
  const attribution = { taskOwnerId: 'A', chargeId: 'pending-1', requestId: 'r1', attemptId: 't1' };
  original.recordUnknownCharge('deepseek-v4-flash', attribution);
  const pending = {
    totalCostUSD: original.getTaskSummary('A').totalCostUSD,
    unknownChargeCount: original.getTaskSummary('A').unknownChargeCount ?? 0,
    chargeIds: original.getTaskChargeIds('A'),
    chargeObservations: original.getTaskChargeObservations('A'),
  };
  const resumed = new CostTracker();
  resumed.restoreTaskUsage('A', pending);
  assert.equal(resumed.getTaskSummary('A').costComplete, false);
  assert.equal(resumed.getTaskSummary('A').unknownChargeCount, 1);
  assert.equal(resumed.clearUnstartedCharge({ ...attribution, chargeId: 'wrong' }), false);
  assert.equal(resumed.clearUnstartedCharge(attribution), true);
  assert.equal(resumed.getTaskSummary('A').costComplete, true);
  assert.deepEqual(resumed.getTaskChargeIds('A'), []);
});

test('duplicate durable receipts cannot masquerade as two declared charges', () => {
  const tracker = new CostTracker();
  const receipt = {
    attribution: { taskOwnerId: 'A', chargeId: 'one' }, modelId: 'deepseek-v4-flash',
    inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0,
    knownCostUSD: null,
  };
  assert.throws(() => tracker.restoreTaskUsage('A', {
    totalCostUSD: 0, unknownChargeCount: 2, chargeIds: ['one', 'two'],
    chargeObservations: [receipt, { ...receipt }],
  }), /Invalid durable charge observation/);
  assert.deepEqual(tracker.getTaskChargeIds('A'), []);
});

test('malformed cold receipts fail without partially restoring owner state', () => {
  const tracker = new CostTracker();
  const receipt = {
    attribution: { taskOwnerId: 'A', chargeId: 'charge-1', requestId: 'req-1', attemptId: 'try-1' },
    modelId: 'deepseek-v4-flash', inputTokens: -1, outputTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, knownCostUSD: null,
  };
  assert.throws(() => tracker.restoreTaskUsage('A', {
    totalCostUSD: 0, unknownChargeCount: 1, chargeIds: ['charge-1'],
    chargeObservations: [receipt],
  }), /Invalid durable charge observation/);
  assert.deepEqual(tracker.getTaskChargeIds('A'), []);
  assert.equal(tracker.getTaskSummary('A').unknownChargeCount, 0);
  assert.equal(tracker.getSessionSummary().unknownChargeCount, 0);
});

test('a mismatched durable charge total is rejected before any owner mutation', () => {
  const tracker = new CostTracker();
  const receipt = {
    attribution: { taskOwnerId: 'A', chargeId: 'charge-1', requestId: 'req-1', attemptId: 'try-1' },
    modelId: 'deepseek-v4-flash', inputTokens: 0, outputTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, knownCostUSD: 0.01,
  };
  assert.throws(() => tracker.restoreTaskUsage('A', {
    totalCostUSD: 0.02, unknownChargeCount: 0, chargeIds: ['charge-1'],
    chargeObservations: [receipt],
  }), /disagree with the task totals/);
  assert.deepEqual(tracker.getTaskChargeIds('A'), []);
  assert.equal(tracker.getTaskSummary('A').totalCostUSD, 0);
});

test('an unknown charge refines to one known charge without duplicating tokens or parent spend', () => {
  const tracker = new CostTracker();
  const attribution = { taskOwnerId: 'child', parentTaskOwnerId: 'parent', chargeId: 'attempt-1', attemptId: 'try-1' };
  assert.deepEqual(tracker.settleUsage('deepseek-v4-flash', 100, 20, null, null, attribution, false), {
    kind: 'inserted', knownCostDelta: 0, unknownDelta: 1,
  });
  const refined = tracker.settleUsage('deepseek-v4-flash', 100, 20, null, null, attribution);
  assert.ok(refined.kind === 'refined');
  assert.ok(refined.knownCostDelta > 0);
  assert.equal(refined.unknownDelta, -1);
  assert.equal(tracker.getTaskSummary('child').unknownChargeCount, 0);
  assert.equal(tracker.getTaskSummary('child').totalTokens, 120);
  assert.equal(tracker.getTaskSummary('parent').totalCostUSD, tracker.getTaskSummary('child').totalCostUSD);
  assert.equal(tracker.getSessionSummary().totalTokens, 120);
  assert.equal(tracker.getSessionSummary().costComplete, true);
  assert.deepEqual(tracker.settleUsage('deepseek-v4-flash', 100, 20, null, null, attribution), { kind: 'duplicate' });
  assert.equal(tracker.getSessionSummary().totalTokens, 120);
});

test('pending unpriced usage accepts later tokens without minting another charge', () => {
  const tracker = new CostTracker();
  const attribution = { taskOwnerId: 'A', chargeId: 'unpriced-dispatch' };
  tracker.recordUnknownCharge('unlisted-provider-model', attribution);
  const update = tracker.settleUsage('unlisted-provider-model', 150, 25, null, null, attribution);
  assert.deepEqual(update, { kind: 'refined', knownCostDelta: 0, unknownDelta: 0 });
  assert.equal(tracker.getTaskSummary('A').totalTokens, 175);
  assert.equal(tracker.getTaskSummary('A').unknownChargeCount, 1);
  assert.equal(tracker.getSessionSummary().totalTokens, 175);
  assert.equal(tracker.getSessionSummary().completeCostUSD, null);
});

test('cold resumed pending unpriced usage transfers its unknown projection once', () => {
  const original = new CostTracker();
  const attribution = { taskOwnerId: 'A', chargeId: 'unpriced-cold' };
  original.recordUnknownCharge('unlisted-provider-model', attribution);
  const resumed = new CostTracker();
  resumed.restoreSessionCost({
    ...original.getSessionSummary(), accountedChargeIds: original.getSessionChargeIds(),
    chargeObservations: original.getSessionChargeObservations(),
  });
  resumed.restoreTaskUsage('A', {
    totalCostUSD: 0, unknownChargeCount: 1,
    chargeIds: original.getTaskChargeIds('A'),
    chargeObservations: original.getTaskChargeObservations('A'),
  });
  assert.equal(resumed.settleUsage('unlisted-provider-model', 5, 7, null, null, attribution).kind, 'refined');
  assert.equal(resumed.getSessionSummary().unknownChargeCount, 1);
  assert.equal(resumed.getSessionSummary().totalTokens, 12);
  assert.equal(resumed.getTaskSummary('A').unknownChargeCount, 1);
});

test('owner receipt newer than session snapshot reconciles on cold resume', () => {
  const original = new CostTracker();
  const attribution = { taskOwnerId: 'A', chargeId: 'late-known' };
  original.recordUnknownCharge('deepseek-v4-flash', attribution);
  const staleSession = {
    ...original.getSessionSummary(), accountedChargeIds: original.getSessionChargeIds(),
    chargeObservations: original.getSessionChargeObservations(),
  };
  original.settleUsage('deepseek-v4-flash', 1000, 100, null, null, attribution);
  const latestOwner = {
    totalCostUSD: original.getTaskSummary('A').totalCostUSD,
    unknownChargeCount: original.getTaskSummary('A').unknownChargeCount ?? 0,
    chargeIds: original.getTaskChargeIds('A'),
    chargeObservations: original.getTaskChargeObservations('A'),
  };
  const resumed = new CostTracker();
  resumed.restoreSessionCost(staleSession);
  resumed.restoreTaskUsage('A', latestOwner);
  assert.equal(resumed.getSessionSummary().unknownChargeCount, 0);
  assert.equal(resumed.getSessionSummary().totalTokens, 1100);
  assert.equal(resumed.getSessionSummary().completeCostUSD, latestOwner.totalCostUSD);
  assert.equal(resumed.settleUsage('deepseek-v4-flash', 1000, 100, null, null, attribution).kind, 'duplicate');
  assert.equal(resumed.getSessionSummary().totalTokens, 1100);
});

test('newer confirmed session receipt supersedes a stale pending owner receipt', () => {
  const original = new CostTracker();
  const attribution = { taskOwnerId: 'A', chargeId: 'session-newer' };
  original.recordUnknownCharge('deepseek-v4-flash', attribution);
  const staleOwner = {
    totalCostUSD: 0, unknownChargeCount: 1,
    chargeIds: original.getTaskChargeIds('A'),
    chargeObservations: original.getTaskChargeObservations('A'),
  };
  original.settleUsage('deepseek-v4-flash', 1000, 100, null, null, attribution);
  const resumed = new CostTracker();
  resumed.restoreSessionCost({
    ...original.getSessionSummary(), accountedChargeIds: original.getSessionChargeIds(),
    chargeObservations: original.getSessionChargeObservations(),
  });
  resumed.restoreTaskUsage('A', staleOwner);
  assert.equal(resumed.getTaskSummary('A').unknownChargeCount, 0);
  assert.equal(resumed.getTaskSummary('A').totalCostUSD, original.getTaskSummary('A').totalCostUSD);
  assert.equal(resumed.settleUsage('deepseek-v4-flash', 1000, 100, null, null, attribution).kind, 'duplicate');
  assert.equal(resumed.getSessionSummary().unknownChargeCount, 0);
  assert.equal(resumed.getSessionSummary().totalCostUSD, original.getSessionSummary().totalCostUSD);
});

test('charge identity conflict is explicit and cannot move a receipt to another owner', () => {
  const tracker = new CostTracker();
  const attribution = { taskOwnerId: 'A', chargeId: 'shared-id', attemptId: 'try-1' };
  tracker.settleUsage('deepseek-v4-flash', 100, 20, null, null, attribution);
  const conflict = tracker.settleUsage('deepseek-v4-flash', 100, 20, null, null, { ...attribution, taskOwnerId: 'B' });
  assert.equal(conflict.kind, 'conflict');
  assert.equal(tracker.getTaskSummary('B').totalCostUSD, 0);
  assert.equal(tracker.getTaskSummary('A').totalTokens, 120);
  assert.equal(tracker.settleUsage('deepseek-v4-flash', 0, 0, null, null, attribution, false).kind, 'duplicate');
  assert.equal(tracker.getTaskSummary('A').costComplete, true);
});

test('restoring a stale snapshot preserves a live unknown-only charge', () => {
  const tracker = new CostTracker();
  tracker.recordUnknownCharge('deepseek-v4-flash', { taskOwnerId: 'A', chargeId: 'late' });
  tracker.restoreTaskUsage('A', { totalCostUSD: 0, unknownChargeCount: 0, chargeIds: [] });
  assert.equal(tracker.getTaskSummary('A').unknownChargeCount, 1);
  assert.deepEqual(tracker.getTaskChargeIds('A'), ['late']);
});

test('restoring stale session totals preserves a newer live model ledger', () => {
  const tracker = new CostTracker();
  tracker.trackUsage('deepseek-v4-flash', 1000, 100);
  const before = tracker.getSessionSummary();
  tracker.restoreSessionCost({ totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0 });
  assert.deepEqual(tracker.getSessionSummary(), before);
});

test('an unavailable history store reports unavailable instead of known zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-cost-unavailable-'));
  try {
    writeFileSync(join(root, 'blocker'), 'file');
    const history = new TokenHistoryDb(join(root, 'blocker', 'history.db'));
    assert.equal(history.getProjectCostSummary(root), null);
    history.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project history upserts changing sessions and retains unknown completeness', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-cost-'));
  const oldDb = process.env['BABEL_TOKEN_DB_PATH'];
  process.env['BABEL_TOKEN_DB_PATH'] = join(root, 'history.db');
  resetGlobalTokenHistoryDb();
  try {
    const a = new CostTracker(root);
    a.trackUsage('deepseek-v4-flash', 1000, 100);
    a.saveToProjectStats('A');
    a.trackUsage('deepseek-v4-flash', 2000, 200);
    a.saveToProjectStats('A');
    const aCost = a.getSessionSummary().totalCostUSD;
    const b = new CostTracker(root);
    b.trackUsage('deepseek-v4-pro', 1000, 100);
    b.saveToProjectStats('B');
    const bCost = b.getSessionSummary().totalCostUSD;
    a.saveToProjectStats('A');
    const stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf-8'));
    assert.ok(Math.abs(stats.totalCostUSD - aCost - bCost) < 1e-12);
    assert.ok(Math.abs(stats.modelBreakdown['deepseek-v4-flash'].costUSD - aCost) < 1e-12);
    assert.ok(Math.abs(stats.modelBreakdown['deepseek-v4-pro'].costUSD - bCost) < 1e-12);
    assert.ok(Math.abs(a.getProjectHistoricalCost(root)! - aCost - bCost) < 1e-12);

    b.recordUnknownCharge('unlisted-provider-model', { taskOwnerId: 'B', chargeId: 'unknown-B' });
    b.saveToProjectStats('B');
    const unknownStats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf-8'));
    assert.equal(unknownStats.unknownChargeCount, 1);
    assert.equal(unknownStats.completeCostUSD, null);
    assert.equal(b.getProjectHistoricalCost(root), null);
  } finally {
    resetGlobalTokenHistoryDb();
    if (oldDb === undefined) delete process.env['BABEL_TOKEN_DB_PATH'];
    else process.env['BABEL_TOKEN_DB_PATH'] = oldDb;
    rmSync(root, { recursive: true, force: true });
  }
});

test('project stats sum per-run deltas from one cumulative tracker', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-runs-'));
  const oldDb = process.env['BABEL_TOKEN_DB_PATH'];
  process.env['BABEL_TOKEN_DB_PATH'] = join(root, 'history.db');
  resetGlobalTokenHistoryDb();
  try {
    const tracker = new CostTracker(root);
    const beforeA = tracker.getSessionSummary();
    tracker.trackUsage('deepseek-v4-flash', 1000, 100);
    const afterA = tracker.getSessionSummary();
    tracker.saveToProjectStats('run-A', beforeA);
    tracker.trackUsage('deepseek-v4-pro', 2000, 200);
    tracker.saveToProjectStats('run-B', afterA);
    const stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf8'));
    assert.ok(Math.abs(stats.totalCostUSD - tracker.getSessionSummary().totalCostUSD) < 1e-12);
    assert.equal(stats.totalInputTokens, 3000);
    assert.equal(stats.totalOutputTokens, 300);
    assert.ok(Math.abs(tracker.getProjectHistoricalCost(root)! - tracker.getSessionSummary().totalCostUSD) < 1e-12);
  } finally {
    resetGlobalTokenHistoryDb();
    if (oldDb === undefined) delete process.env['BABEL_TOKEN_DB_PATH'];
    else process.env['BABEL_TOKEN_DB_PATH'] = oldDb;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a later run refines an earlier unknown in one session snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-late-refinement-'));
  try {
    const tracker = new CostTracker(root);
    const sessionId = tracker.getProjectSessionId();
    const attribution = { taskOwnerId: 'A', chargeId: 'late' };
    const beforeFirstRun = tracker.getSessionSummary();
    tracker.recordUnknownCharge('deepseek-v4-flash', attribution);
    tracker.saveToProjectStats(sessionId, beforeFirstRun, root);
    const beforeSecondRun = tracker.getSessionSummary();
    tracker.settleUsage('deepseek-v4-flash', 1000, 100, null, null, attribution);
    tracker.saveToProjectStats(sessionId, beforeSecondRun, root);
    const stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf8'));
    assert.equal(stats.unknownChargeCount, 0);
    assert.equal(stats.totalInputTokens, 1000);
    assert.equal(stats.totalOutputTokens, 100);
    assert.equal(stats.completeCostUSD, tracker.getSessionSummary().totalCostUSD);
    assert.deepEqual(Object.keys(stats.sessionSnapshots), [sessionId]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('crash-window project projection stays incomplete without receipt root attribution', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-crash-'));
  try {
    const original = new CostTracker(root);
    const attribution = { taskOwnerId: 'A', chargeId: 'crash-late' };
    original.recordUnknownCharge('deepseek-v4-flash', attribution);
    original.saveToProjectStats(original.getProjectSessionId(), undefined, root);
    const savedSession = {
      ...original.getSessionSummary(), accountedChargeIds: original.getSessionChargeIds(),
      chargeObservations: original.getSessionChargeObservations(),
      projectSessionId: original.getProjectSessionId(),
    };
    original.settleUsage('deepseek-v4-flash', 1000, 100, null, null, attribution);
    const resumed = new CostTracker(root);
    resumed.restoreSessionCost(savedSession);
    resumed.restoreTaskUsage('A', {
      totalCostUSD: original.getTaskSummary('A').totalCostUSD,
      unknownChargeCount: 0,
      chargeIds: original.getTaskChargeIds('A'),
      chargeObservations: original.getTaskChargeObservations('A'),
    });
    const baseline = resumed.getSessionSummary();
    resumed.saveToProjectStats(resumed.getProjectSessionId(), baseline, root);
    const stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf8'));
    assert.equal(stats.projectionComplete, false);
    assert.equal(stats.completeCostUSD, null);
    assert.equal(resumed.getProjectHistoricalCost(root), null);
    assert.equal(resumed.getSessionSummary().unknownChargeCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a newer saved session cannot certify an older project snapshot after resume', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-session-ahead-'));
  try {
    const original = new CostTracker(root);
    const attribution = { taskOwnerId: 'A', chargeId: 'session-ahead', projectRoot: root };
    original.recordUnknownCharge('deepseek-v4-flash', attribution);
    original.saveToProjectStats(original.getProjectSessionId(), undefined, root);
    original.settleUsage('deepseek-v4-flash', 1000, 100, null, null, attribution);
    const savedSession = {
      ...original.getSessionSummary(), accountedChargeIds: original.getSessionChargeIds(),
      chargeObservations: original.getSessionChargeObservations(),
      projectSessionId: original.getProjectSessionId(),
    };
    const resumed = new CostTracker(root);
    resumed.restoreSessionCost(savedSession);
    resumed.restoreTaskUsage('A', {
      totalCostUSD: original.getTaskSummary('A').totalCostUSD,
      unknownChargeCount: 0,
      chargeIds: original.getTaskChargeIds('A'),
      chargeObservations: original.getTaskChargeObservations('A'),
    });
    resumed.saveToProjectStats(resumed.getProjectSessionId(), resumed.getSessionSummary(), root);
    const stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf8'));
    assert.equal(stats.projectionComplete, true);
    assert.equal(stats.unknownChargeCount, 0);
    assert.equal(stats.completeCostUSD, original.getSessionSummary().totalCostUSD);
    assert.equal(resumed.getProjectHistoricalCost(root), original.getSessionSummary().totalCostUSD);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project snapshots use each target root run delta', () => {
  const rootA = mkdtempSync(join(tmpdir(), 'babel-project-A-'));
  const rootB = mkdtempSync(join(tmpdir(), 'babel-project-B-'));
  try {
    const tracker = new CostTracker(rootA);
    const beforeA = tracker.getSessionSummary();
    tracker.trackUsage('deepseek-v4-flash', 100, 10);
    tracker.saveToProjectStats(tracker.getProjectSessionId(), beforeA, rootA);
    const beforeB = tracker.getSessionSummary();
    tracker.trackUsage('deepseek-v4-flash', 200, 20);
    tracker.saveToProjectStats(tracker.getProjectSessionId(), beforeB, rootB);
    const a = JSON.parse(readFileSync(join(rootA, 'project_stats.json'), 'utf8'));
    const b = JSON.parse(readFileSync(join(rootB, 'project_stats.json'), 'utf8'));
    assert.equal(a.totalInputTokens, 100);
    assert.equal(b.totalInputTokens, 200);
    assert.ok(Math.abs(tracker.getProjectHistoricalCost(rootA)! - a.totalCostUSD) < 1e-12);
    assert.ok(Math.abs(tracker.getProjectHistoricalCost(rootB)! - b.totalCostUSD) < 1e-12);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('rooted restored receipts repair one project without poisoning another', () => {
  const rootA = mkdtempSync(join(tmpdir(), 'babel-rooted-A-'));
  const rootB = mkdtempSync(join(tmpdir(), 'babel-rooted-B-'));
  try {
    const original = new CostTracker(rootA);
    const a = { taskOwnerId: 'A', chargeId: 'charge-A', projectRoot: rootA };
    const b = { taskOwnerId: 'B', chargeId: 'charge-B', projectRoot: rootB };
    original.recordUnknownCharge('deepseek-v4-flash', a);
    original.saveToProjectStats(original.getProjectSessionId(), undefined, rootA);
    original.settleUsage('deepseek-v4-flash', 1000, 100, null, null, a);
    original.settleUsage('deepseek-v4-flash', 200, 20, null, null, b);
    const saved = {
      ...original.getSessionSummary(), accountedChargeIds: original.getSessionChargeIds(),
      chargeObservations: original.getSessionChargeObservations(),
      projectSessionId: original.getProjectSessionId(),
    };
    const resumed = new CostTracker(rootA);
    resumed.restoreSessionCost(saved);
    for (const owner of ['A', 'B']) {
      resumed.restoreTaskUsage(owner, {
        totalCostUSD: original.getTaskSummary(owner).totalCostUSD,
        unknownChargeCount: 0,
        chargeIds: original.getTaskChargeIds(owner),
        chargeObservations: original.getTaskChargeObservations(owner),
      });
    }
    const baseline = resumed.getSessionSummary();
    resumed.saveToProjectStats(resumed.getProjectSessionId(), baseline, rootA);
    resumed.saveToProjectStats(resumed.getProjectSessionId(), baseline, rootB);
    const statsA = JSON.parse(readFileSync(join(rootA, 'project_stats.json'), 'utf8'));
    const statsB = JSON.parse(readFileSync(join(rootB, 'project_stats.json'), 'utf8'));
    assert.equal(statsA.projectionComplete, true);
    assert.equal(statsB.projectionComplete, true);
    assert.equal(statsA.unknownChargeCount, 0);
    assert.equal(statsA.totalInputTokens, 1000);
    assert.equal(statsB.totalInputTokens, 200);
    assert.ok(Math.abs(resumed.getProjectHistoricalCost(rootA)! - original.getTaskSummary('A').totalCostUSD) < 1e-12);
    assert.ok(Math.abs(resumed.getProjectHistoricalCost(rootB)! - original.getTaskSummary('B').totalCostUSD) < 1e-12);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('older resumed receipts cannot overwrite a newer project snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-ahead-'));
  try {
    const original = new CostTracker(root);
    const attribution = { taskOwnerId: 'A', chargeId: 'project-ahead', projectRoot: root };
    original.recordUnknownCharge('deepseek-v4-flash', attribution);
    const olderSession = {
      ...original.getSessionSummary(), accountedChargeIds: original.getSessionChargeIds(),
      chargeObservations: original.getSessionChargeObservations(),
      projectSessionId: original.getProjectSessionId(),
    };
    original.settleUsage('deepseek-v4-flash', 1000, 100, null, null, attribution);
    original.saveToProjectStats(original.getProjectSessionId(), undefined, root);
    const newerCost = original.getTaskSummary('A').totalCostUSD;
    const resumed = new CostTracker(root);
    resumed.restoreSessionCost(olderSession);
    resumed.restoreTaskUsage('A', {
      totalCostUSD: 0, unknownChargeCount: 1,
      chargeIds: olderSession.accountedChargeIds,
      chargeObservations: olderSession.chargeObservations,
    });
    resumed.saveToProjectStats(resumed.getProjectSessionId(), resumed.getSessionSummary(), root);
    const stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf8'));
    assert.equal(stats.totalCostUSD, newerCost);
    assert.equal(stats.unknownChargeCount, 0);
    assert.equal(stats.projectionComplete, false);
    assert.equal(stats.completeCostUSD, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a new pending receipt after resume does not permanently poison project completeness', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-new-pending-'));
  try {
    const original = new CostTracker(root);
    const first = { taskOwnerId: 'A', chargeId: 'first', projectRoot: root };
    original.settleUsage('deepseek-v4-flash', 100, 10, null, null, first);
    original.saveToProjectStats(original.getProjectSessionId(), undefined, root);
    const saved = {
      ...original.getSessionSummary(), accountedChargeIds: original.getSessionChargeIds(),
      chargeObservations: original.getSessionChargeObservations(),
      projectSessionId: original.getProjectSessionId(),
    };
    const resumed = new CostTracker(root);
    resumed.restoreSessionCost(saved);
    resumed.restoreTaskUsage('A', {
      totalCostUSD: original.getTaskSummary('A').totalCostUSD,
      unknownChargeCount: 0,
      chargeIds: original.getTaskChargeIds('A'),
      chargeObservations: original.getTaskChargeObservations('A'),
    });
    const next = { taskOwnerId: 'B', chargeId: 'next', projectRoot: root };
    resumed.recordUnknownCharge('deepseek-v4-flash', next);
    resumed.saveToProjectStats(resumed.getProjectSessionId(), saved, root);
    let stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf8'));
    assert.equal(stats.projectionComplete, true);
    assert.equal(stats.unknownChargeCount, 1);
    resumed.settleUsage('deepseek-v4-flash', 50, 5, null, null, next);
    resumed.saveToProjectStats(resumed.getProjectSessionId(), saved, root);
    stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf8'));
    assert.equal(stats.projectionComplete, true);
    assert.equal(stats.unknownChargeCount, 0);
    assert.equal(stats.completeCostUSD, resumed.getSessionSummary().totalCostUSD);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a removed unrelated root cannot contribute to another project snapshot', () => {
  const rootA = mkdtempSync(join(tmpdir(), 'babel-removed-A-'));
  const rootB = mkdtempSync(join(tmpdir(), 'babel-remaining-B-'));
  try {
    const tracker = new CostTracker(rootB);
    tracker.settleUsage('deepseek-v4-flash', 1000, 100, null, null,
      { taskOwnerId: 'A', chargeId: 'removed-A', projectRoot: rootA });
    rmSync(rootA, { recursive: true, force: true });
    tracker.settleUsage('deepseek-v4-flash', 200, 20, null, null,
      { taskOwnerId: 'B', chargeId: 'remaining-B', projectRoot: rootB });
    tracker.saveToProjectStats(tracker.getProjectSessionId(), undefined, rootB);
    const stats = JSON.parse(readFileSync(join(rootB, 'project_stats.json'), 'utf8'));
    assert.equal(stats.projectionComplete, true);
    assert.equal(stats.totalInputTokens, 200);
    assert.equal(stats.totalOutputTokens, 20);
    assert.equal(stats.totalCostUSD, tracker.getTaskSummary('B').totalCostUSD);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test('rooted project matching accepts Windows path case aliases', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-case-'));
  try {
    const tracker = new CostTracker(root);
    const attribution = { taskOwnerId: 'A', chargeId: 'case-alias', projectRoot: root.toLowerCase() };
    tracker.settleUsage('deepseek-v4-flash', 100, 10, null, null, attribution);
    tracker.saveToProjectStats(tracker.getProjectSessionId(), undefined, root);
    const stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf8'));
    assert.equal(stats.totalInputTokens, 100);
    assert.equal(stats.projectionComplete, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit project root receives governed cost history instead of launch root', () => {
  const launch = mkdtempSync(join(tmpdir(), 'babel-cost-launch-'));
  const target = mkdtempSync(join(tmpdir(), 'babel-cost-target-'));
  try {
    const tracker = new CostTracker(launch);
    const baseline = tracker.getSessionSummary();
    tracker.trackUsage('deepseek-v4-flash', 100, 10);
    tracker.saveToProjectStats(tracker.getProjectSessionId(), baseline, target);
    assert.equal(readFileSync(join(target, 'project_stats.json'), 'utf8').includes('totalCostUSD'), true);
    assert.equal(existsSync(join(launch, 'project_stats.json')), false);
  } finally {
    rmSync(launch, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('stale project stats lock from a dead owner is recovered', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-stale-cost-lock-'));
  try {
    const lock = join(root, 'project_stats.json.lock');
    writeFileSync(lock, JSON.stringify({ pid: 999_999_999, createdAt: Date.now() - 120_000 }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    const tracker = new CostTracker(root);
    tracker.trackUsage('deepseek-v4-flash', 10, 1);
    tracker.saveToProjectStats('recovered');
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(join(root, 'project_stats.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy project aggregates do not claim a complete session projection after migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-cost-legacy-'));
  const oldDb = process.env['BABEL_TOKEN_DB_PATH'];
  process.env['BABEL_TOKEN_DB_PATH'] = join(root, 'history.db');
  resetGlobalTokenHistoryDb();
  try {
    writeFileSync(join(root, 'project_stats.json'), JSON.stringify({
      totalCostUSD: 0.01,
      totalInputTokens: 100,
      totalOutputTokens: 10,
      lastSessionId: 'A',
      modelBreakdown: { 'deepseek-v4-flash': { inputTokens: 100, outputTokens: 10, costUSD: 0.01 } },
    }));
    const tracker = new CostTracker(root);
    tracker.trackUsage('deepseek-v4-flash', 200, 20);
    tracker.saveToProjectStats('A');
    const stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf-8'));
    assert.equal(stats.projectionComplete, false);
    assert.equal(stats.totalCostUSD, 0.01);
    assert.equal(stats.completeCostUSD, null);
    assert.equal(tracker.getProjectHistoricalCost(root), null);
  } finally {
    resetGlobalTokenHistoryDb();
    if (oldDb === undefined) delete process.env['BABEL_TOKEN_DB_PATH'];
    else process.env['BABEL_TOKEN_DB_PATH'] = oldDb;
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy resumed session identities keep project completeness unavailable after save', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-legacy-resume-'));
  try {
    const tracker = new CostTracker(root);
    tracker.restoreSessionCost({
      totalCostUSD: 0.02, totalInputTokens: 100, totalOutputTokens: 10,
      totalTokens: 110,
    });
    tracker.trackUsage('deepseek-v4-flash', 10, 1);
    tracker.saveToProjectStats('run-after-resume');
    const stats = JSON.parse(readFileSync(join(root, 'project_stats.json'), 'utf8'));
    assert.equal(stats.projectionComplete, false);
    assert.equal(stats.completeCostUSD, null);
    assert.equal(tracker.getProjectHistoricalCost(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
