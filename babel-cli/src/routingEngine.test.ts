import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  selectBestTierForStage,
  reorderWaterfallByStartIndex,
  clearRoutingCache,
  type TierScore,
} from './routingEngine.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTmpRunsDir(): string {
  const dir = join(tmpdir(), `babel-routing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface TelemetryEntry {
  stage: string;
  tier_succeeded: string;
  tier_index: number;
  attempts: number;
  tiers_skipped: string[];
  cascade_reason: string;
  ts: string;
}

function writeTelemetry(runsDir: string, runId: string, entries: TelemetryEntry[]): void {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, '05_waterfall_telemetry.json'), JSON.stringify(entries));
}

// ─── reorderWaterfallByStartIndex ─────────────────────────────────────────────

describe('reorderWaterfallByStartIndex', () => {

  it('returns original array when startIndex is 0', () => {
    const arr = ['a', 'b', 'c'];
    assert.deepEqual(reorderWaterfallByStartIndex(arr, 0), ['a', 'b', 'c']);
  });

  it('returns original array when startIndex is undefined', () => {
    const arr = ['a', 'b', 'c'];
    assert.deepEqual(reorderWaterfallByStartIndex(arr, undefined), ['a', 'b', 'c']);
  });

  it('moves element at index 1 to front', () => {
    const arr = ['a', 'b', 'c'];
    assert.deepEqual(reorderWaterfallByStartIndex(arr, 1), ['b', 'a', 'c']);
  });

  it('moves element at index 2 to front, preserves rest', () => {
    const arr = ['a', 'b', 'c'];
    assert.deepEqual(reorderWaterfallByStartIndex(arr, 2), ['c', 'a', 'b']);
  });

  it('returns original when startIndex >= length', () => {
    const arr = ['a', 'b'];
    assert.deepEqual(reorderWaterfallByStartIndex(arr, 5), ['a', 'b']);
  });

  it('returns original when startIndex is negative', () => {
    const arr = ['a', 'b'];
    assert.deepEqual(reorderWaterfallByStartIndex(arr, -1), ['a', 'b']);
  });

  it('works with single-element array', () => {
    assert.deepEqual(reorderWaterfallByStartIndex(['only'], 0), ['only']);
  });

  it('works with objects, not just strings', () => {
    const arr = [{ n: 0 }, { n: 1 }, { n: 2 }];
    const result = reorderWaterfallByStartIndex(arr, 2);
    assert.equal(result[0]!.n, 2);
    assert.equal(result[1]!.n, 0);
    assert.equal(result[2]!.n, 1);
  });

});

// ─── selectBestTierForStage — disabled / thin data ───────────────────────────

describe('selectBestTierForStage — disabled or insufficient data', () => {
  let runsDir: string;

  before(() => {
    runsDir = makeTmpRunsDir();
    clearRoutingCache();
  });

  after(() => {
    rmSync(runsDir, { recursive: true, force: true });
    clearRoutingCache();
  });

  it('returns null when dynamic routing is not enabled', () => {
    const result = selectBestTierForStage('orchestrator', ['TierA', 'TierB'], { enabled: false, runsDir });
    assert.equal(result, null);
  });

  it('returns null for a single-tier waterfall even when enabled', () => {
    const result = selectBestTierForStage('orchestrator', ['OnlyTier'], { enabled: true, runsDir });
    assert.equal(result, null);
  });

  it('returns null when no telemetry files exist', () => {
    const result = selectBestTierForStage('orchestrator', ['TierA', 'TierB'], { enabled: true, runsDir });
    assert.equal(result, null);
  });

  it('returns null when fewer than MIN_SAMPLES entries exist', () => {
    // Write only 1 entry (default MIN_SAMPLES is 3)
    writeTelemetry(runsDir, 'run-thin-001', [{
      stage: 'orchestrator', tier_succeeded: 'TierA', tier_index: 0,
      attempts: 1, tiers_skipped: [], cascade_reason: 'none', ts: new Date().toISOString(),
    }]);
    clearRoutingCache();
    const result = selectBestTierForStage('orchestrator', ['TierA', 'TierB'], { enabled: true, runsDir });
    assert.equal(result, null);
  });

});

// ─── selectBestTierForStage — scoring logic ───────────────────────────────────

describe('selectBestTierForStage — scoring selects best tier', () => {
  let runsDir: string;

  before(() => {
    runsDir = makeTmpRunsDir();
    clearRoutingCache();
  });

  after(() => {
    rmSync(runsDir, { recursive: true, force: true });
    clearRoutingCache();
  });

  it('selects TierB when TierA always fails and TierB always wins', () => {
    // 5 runs: TierA skipped, TierB wins
    for (let i = 0; i < 5; i++) {
      writeTelemetry(runsDir, `run-wins-${i}`, [{
        stage: 'orchestrator', tier_succeeded: 'TierB', tier_index: 1,
        attempts: 1, tiers_skipped: ['TierA'], cascade_reason: 'TierA failed', ts: new Date().toISOString(),
      }]);
    }
    clearRoutingCache();

    const result = selectBestTierForStage('orchestrator', ['TierA', 'TierB'], { enabled: true, runsDir });
    assert.notEqual(result, null);
    assert.equal(result!.selectedName, 'TierB');
    assert.equal(result!.selectedIndex, 1);
  });

  it('returns a RoutingDecision with all expected fields', () => {
    const result = selectBestTierForStage('orchestrator', ['TierA', 'TierB'], { enabled: true, runsDir });
    assert.notEqual(result, null);
    assert.equal(typeof result!.stage, 'string');
    assert.equal(typeof result!.selectedIndex, 'number');
    assert.equal(typeof result!.selectedName, 'string');
    assert.equal(typeof result!.telemetryRunsScanned, 'number');
    assert.ok(Array.isArray(result!.scoredTiers));
    assert.ok(result!.scoredTiers.length > 0);
    assert.equal(typeof result!.reason, 'string');
  });

  it('scoredTiers contains both tiers with valid fields', () => {
    const result = selectBestTierForStage('orchestrator', ['TierA', 'TierB'], { enabled: true, runsDir });
    assert.notEqual(result, null);
    const tiers: TierScore[] = result!.scoredTiers;
    assert.equal(tiers.length, 2);
    for (const tier of tiers) {
      assert.equal(typeof tier.name, 'string');
      assert.equal(typeof tier.score, 'number');
      assert.equal(typeof tier.winRate, 'number');
      assert.ok(tier.winRate >= 0 && tier.winRate <= 1);
      assert.ok(Number.isFinite(tier.score));
    }
  });

  it('prefers high-win-rate tier even when it is not at index 0', () => {
    const altDir = makeTmpRunsDir();
    try {
      // 4 runs: TierA always skipped, TierC always wins
      for (let i = 0; i < 4; i++) {
        writeTelemetry(altDir, `run-alt-${i}`, [{
          stage: 'planning', tier_succeeded: 'TierC', tier_index: 2,
          attempts: 1, tiers_skipped: ['TierA', 'TierB'], cascade_reason: 'cascaded', ts: new Date().toISOString(),
        }]);
      }

      const result = selectBestTierForStage('planning', ['TierA', 'TierB', 'TierC'], { enabled: true, runsDir: altDir });
      assert.notEqual(result, null);
      assert.equal(result!.selectedName, 'TierC');
    } finally {
      rmSync(altDir, { recursive: true, force: true });
    }
  });

  it('ignores telemetry from a different stage', () => {
    const altDir = makeTmpRunsDir();
    try {
      // Write 5 entries for 'qa' stage — should not affect 'orchestrator' decision
      for (let i = 0; i < 5; i++) {
        writeTelemetry(altDir, `run-qa-${i}`, [{
          stage: 'qa', tier_succeeded: 'TierB', tier_index: 1,
          attempts: 1, tiers_skipped: ['TierA'], cascade_reason: 'none', ts: new Date().toISOString(),
        }]);
      }

      const result = selectBestTierForStage('orchestrator', ['TierA', 'TierB'], { enabled: true, runsDir: altDir });
      // orchestrator has no data — should return null (MIN_SAMPLES not met)
      assert.equal(result, null);
    } finally {
      rmSync(altDir, { recursive: true, force: true });
    }
  });

  it('handles corrupt telemetry file without throwing', () => {
    const altDir = makeTmpRunsDir();
    try {
      const runDir = join(altDir, 'run-corrupt');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, '05_waterfall_telemetry.json'), 'NOT VALID JSON {{{');

      // Add enough valid entries to meet MIN_SAMPLES
      for (let i = 0; i < 3; i++) {
        writeTelemetry(altDir, `run-valid-${i}`, [{
          stage: 'executor', tier_succeeded: 'TierA', tier_index: 0,
          attempts: 1, tiers_skipped: [], cascade_reason: 'none', ts: new Date().toISOString(),
        }]);
      }

      // Should not throw — corrupt file is skipped silently
      assert.doesNotThrow(() =>
        selectBestTierForStage('executor', ['TierA', 'TierB'], { enabled: true, runsDir: altDir })
      );
    } finally {
      rmSync(altDir, { recursive: true, force: true });
    }
  });

});

// ─── clearRoutingCache ────────────────────────────────────────────────────────

describe('clearRoutingCache', () => {

  it('forces a fresh directory scan after clearing', () => {
    const altDir = makeTmpRunsDir();
    try {
      // First call: no data → null
      clearRoutingCache();
      const r1 = selectBestTierForStage('orchestrator', ['X', 'Y'], { enabled: true, runsDir: altDir });
      assert.equal(r1, null);

      // Add enough telemetry
      for (let i = 0; i < 4; i++) {
        writeTelemetry(altDir, `run-fresh-${i}`, [{
          stage: 'orchestrator', tier_succeeded: 'Y', tier_index: 1,
          attempts: 1, tiers_skipped: ['X'], cascade_reason: 'failed', ts: new Date().toISOString(),
        }]);
      }

      // Without clearing, cache still returns null (stale)
      const r2 = selectBestTierForStage('orchestrator', ['X', 'Y'], { enabled: true, runsDir: altDir });
      assert.equal(r2, null);

      // After clearing, picks up new data
      clearRoutingCache();
      const r3 = selectBestTierForStage('orchestrator', ['X', 'Y'], { enabled: true, runsDir: altDir });
      assert.notEqual(r3, null);
      assert.equal(r3!.selectedName, 'Y');
    } finally {
      rmSync(altDir, { recursive: true, force: true });
      clearRoutingCache();
    }
  });

});
