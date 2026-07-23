/**
 * arenaRunner.test.ts — Tests for Arena evaluation infrastructure (P1.1)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scorePlan, compareEntries, buildDefaultArenaEntries, runArena } from './arenaRunner.js';
import type {
  ArenaEntrySpec,
  ArenaEntryResult,
  ArenaStrategy,
  ArenaConfig,
} from './arenaRunner.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeFakePlan(
  overrides: Record<string, unknown> = {},
): import('../schemas/liteReadOnlyAnswers.js').LitePlanAnswer {
  return {
    schema_version: 1,
    status: (overrides['status'] as 'PLAN_READY' | 'NEEDS_MORE_CONTEXT') ?? 'PLAN_READY',
    summary: (overrides['summary'] as string) ?? 'A complete plan for the task.',
    answer: (overrides['answer'] as string) ?? 'Read the target files, apply changes, and verify.',
    steps: (overrides['steps'] as string[]) ?? [
      'Read src/target.ts to understand the current implementation.',
      'Apply the fix to src/target.ts.',
      'Run the existing test suite to verify.',
      'Check for type errors.',
    ],
    likely_files: (overrides['likely_files'] as string[]) ?? [
      'src/target.ts',
      'src/target.test.ts',
      'package.json',
    ],
    risks: (overrides['risks'] as string[]) ?? [
      'Breaking change to public API if not careful.',
      'Test fixtures may need updating.',
    ],
    verification: (overrides['verification'] as string[]) ?? ['npm test', 'npm run typecheck'],
    next: (overrides['next'] as string[]) ?? ['Review plan.md', 'Run babel fix to apply'],
  };
}

// ── ScorePlan Tests ────────────────────────────────────────────────────────────

describe('scorePlan', () => {
  it('scores a well-formed plan highly', () => {
    const plan = makeFakePlan();
    const score = scorePlan(plan, 'balanced');
    assert.ok(score.total >= 6, `Expected total >= 6, got ${score.total}`);
    assert.ok(score.completeness >= 6);
    assert.ok(score.riskAwareness >= 6);
    assert.ok(score.scopeControl >= 5);
    assert.ok(score.verifiability >= 6);
  });

  it('scores a sparse plan lower', () => {
    const plan = makeFakePlan({
      steps: ['Do something.'],
      likely_files: [],
      risks: [],
      verification: [],
      summary: 'Brief.',
      answer: 'Short.',
    });
    const score = scorePlan(plan, 'balanced');
    assert.ok(score.total <= 5, `Expected total <= 5, got ${score.total}`);
  });

  it('scores NEEDS_MORE_CONTEXT plans lower', () => {
    const plan = makeFakePlan({ status: 'NEEDS_MORE_CONTEXT' });
    const score = scorePlan(plan, 'balanced');
    assert.ok(
      score.completeness < measureCompletenessForTest(makeFakePlan()),
      'NEEDS_MORE_CONTEXT should reduce completeness',
    );
  });

  it('penalizes repo-wide scope in aggressive strategy', () => {
    const plan = makeFakePlan({
      summary: 'This is a repo-wide migration of the entire codebase.',
      likely_files: Array.from({ length: 10 }, (_, i) => `src/module${i}.ts`),
    });
    const score = scorePlan(plan, 'aggressive');
    assert.ok(score.scopeControl <= 6, `Expected scopeControl <= 6, got ${score.scopeControl}`);
  });

  it('rewards scoped language', () => {
    const plan = makeFakePlan({
      summary: 'This plan is scoped to a specific module and targets only the auth system.',
      likely_files: ['src/auth/login.ts', 'src/auth/login.test.ts'],
    });
    const score = scorePlan(plan, 'conservative');
    assert.ok(score.scopeControl >= 7, `Expected scopeControl >= 7, got ${score.scopeControl}`);
  });

  it('scores different strategies independently (same plan)', () => {
    const plan = makeFakePlan();
    const conservative = scorePlan(plan, 'conservative');
    const aggressive = scorePlan(plan, 'aggressive');
    // Same plan should get same scores — strategy affects task enrichment, not scoring
    assert.equal(conservative.total, aggressive.total);
  });

  it('all score dimensions are within 1-10 range', () => {
    const plan = makeFakePlan();
    const score = scorePlan(plan, 'balanced');
    for (const dim of [
      'completeness',
      'riskAwareness',
      'scopeControl',
      'verifiability',
      'total',
    ] as const) {
      assert.ok(score[dim] >= 1 && score[dim] <= 10, `${dim} should be 1-10, got ${score[dim]}`);
    }
  });
});

// ── Helper to access measureCompleteness for testing ────────────────────────────

function measureCompletenessForTest(
  plan: import('../schemas/liteReadOnlyAnswers.js').LitePlanAnswer,
): number {
  let sc = 5;
  const files = (plan.likely_files ?? []).length;
  const steps = (plan.steps ?? []).filter((s: unknown) =>
    /\b(read|inspect|check|verify|test|write|modify|update|add|remove|create)\b/i.test(
      String(s ?? ''),
    ),
  ).length;
  if (files >= 2) sc += 2;
  if (steps >= 3) sc += 2;
  if ((plan.summary ?? '').length > 20) sc += 1;
  if ((plan.answer ?? '').length > 30) sc += 1;
  if (plan.status === 'NEEDS_MORE_CONTEXT') sc -= 3;
  if (plan.status === 'PLAN_READY') sc += 1;
  return Math.max(1, Math.min(10, sc));
}

// ── CompareEntries Tests ───────────────────────────────────────────────────────

describe('compareEntries', () => {
  function makeEntry(id: string, strategy: ArenaStrategy, totalScore: number): ArenaEntryResult {
    return {
      spec: { id, model: 'deepseek', strategy, description: `${strategy} approach` },
      plan: makeFakePlan(),
      runDir: `/tmp/arena/${id}`,
      score: {
        completeness: totalScore,
        riskAwareness: totalScore,
        scopeControl: totalScore,
        verifiability: totalScore,
        total: totalScore,
      },
      strengths: [`Strength for ${id}`],
      weaknesses: [`Weakness for ${id}`],
    };
  }

  it('returns winner as highest scored entry', () => {
    const results = [
      makeEntry('low', 'conservative', 4),
      makeEntry('high', 'balanced', 8),
      makeEntry('mid', 'aggressive', 6),
    ];
    const comparison = compareEntries(results);
    assert.equal(comparison.winnerId, 'high');
    assert.equal(comparison.entries.length, 3);
    assert.equal(comparison.entries[0]!.spec.id, 'high'); // sorted best first
    assert.equal(comparison.entries[2]!.spec.id, 'low'); // worst last
  });

  it('returns null winner for empty entries', () => {
    const comparison = compareEntries([]);
    assert.equal(comparison.winner, null);
    assert.equal(comparison.winnerId, null);
    assert.equal(comparison.entries.length, 0);
  });

  it('computes score deltas from winner', () => {
    const results = [
      makeEntry('winner', 'balanced', 9),
      makeEntry('runner-up', 'conservative', 7),
      makeEntry('last', 'aggressive', 5),
    ];
    const comparison = compareEntries(results);
    assert.equal(comparison.scoreDeltas['winner'], 0);
    assert.equal(comparison.scoreDeltas['runner-up'], 2);
    assert.equal(comparison.scoreDeltas['last'], 4);
  });

  it('generates summary with all entries', () => {
    const results = [makeEntry('a', 'conservative', 8), makeEntry('b', 'balanced', 6)];
    const comparison = compareEntries(results);
    assert.ok(comparison.summary.includes('WINNER'));
    assert.ok(comparison.summary.includes('a'));
    assert.ok(comparison.summary.includes('b'));
    assert.ok(comparison.summary.includes('8/10'));
  });

  it('generates recommendation noting close scores', () => {
    const results = [makeEntry('first', 'balanced', 8), makeEntry('second', 'conservative', 7)];
    const comparison = compareEntries(results);
    assert.ok(
      comparison.recommendation.includes('close to runner-up') ||
        comparison.recommendation.includes('first'),
    );
  });

  it('sorts entries by score descending', () => {
    const results = [
      makeEntry('c', 'conservative', 3),
      makeEntry('a', 'aggressive', 9),
      makeEntry('b', 'balanced', 6),
    ];
    const comparison = compareEntries(results);
    assert.equal(comparison.entries[0]!.spec.id, 'a');
    assert.equal(comparison.entries[1]!.spec.id, 'b');
    assert.equal(comparison.entries[2]!.spec.id, 'c');
  });
});

// ── Default Config Tests ───────────────────────────────────────────────────────

describe('buildDefaultArenaEntries', () => {
  it('returns at least 2 entries for a normal task', () => {
    const config = buildDefaultArenaEntries('add login button to the auth module', '/tmp/test');
    assert.ok(config.entries.length >= 2);
    assert.equal(config.task, 'add login button to the auth module');
    assert.equal(config.projectRoot, '/tmp/test');
  });

  it('includes thorough-audit for high-risk tasks', () => {
    const config = buildDefaultArenaEntries(
      'migration of the entire auth system with breaking changes',
      '/tmp/test',
    );
    const hasAggressive = config.entries.some((e) => e.strategy === 'aggressive');
    assert.ok(hasAggressive, 'High-risk task should include aggressive/thorough entry');
  });

  it('does not include thorough-audit for low-risk tasks', () => {
    const config = buildDefaultArenaEntries('add a comment to the README', '/tmp/test');
    const hasAggressive = config.entries.some((e) => e.strategy === 'aggressive');
    assert.equal(hasAggressive, false, 'Low-risk task should not include aggressive entry');
  });

  it('all entries have unique ids', () => {
    const config = buildDefaultArenaEntries('fix the login bug', '/tmp/test');
    const ids = config.entries.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, 'All entry ids must be unique');
  });
});

// ── Integration: runArena (mock) ───────────────────────────────────────────────

describe('runArena (mock)', () => {
  it('runs arena with default entries for a simple task', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'babel-arena-test-'));
    try {
      const config: ArenaConfig = {
        task: 'add tests for the login module',
        projectRoot: tmpDir,
        entries: [
          { id: 'safe', model: 'deepseek', strategy: 'conservative', description: 'Conservative' },
          { id: 'bold', model: 'deepseek', strategy: 'balanced', description: 'Balanced' },
        ],
        provider: 'mock',
        runsDir: join(tmpDir, 'runs'),
      };

      const comparison = await runArena(config);

      assert.equal(comparison.entries.length, 2);
      assert.ok(comparison.winner !== null, 'Should have a winner');
      assert.ok(comparison.winnerId !== null);
      assert.ok(comparison.summary.length > 0);
      assert.ok(comparison.recommendation.length > 0);
      assert.ok(existsSync(comparison.runDir), 'Arena run dir should exist');
      assert.ok(existsSync(join(comparison.runDir, 'arena_comparison.json')));
      assert.ok(existsSync(join(comparison.runDir, 'arena_summary.md')));

      // Each entry should have its own evidence
      for (const entry of comparison.entries) {
        assert.ok(
          existsSync(join(comparison.runDir, entry.spec.id, 'entry_result.json')),
          `Entry ${entry.spec.id} should have entry_result.json`,
        );
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles single entry gracefully', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'babel-arena-single-'));
    try {
      const config: ArenaConfig = {
        task: 'single entry test',
        projectRoot: tmpDir,
        entries: [
          { id: 'only', model: 'deepseek', strategy: 'balanced', description: 'Only entry' },
        ],
        provider: 'mock',
        runsDir: join(tmpDir, 'runs'),
      };

      const comparison = await runArena(config);
      assert.equal(comparison.entries.length, 1);
      assert.equal(comparison.winnerId, 'only');
      assert.equal(comparison.scoreDeltas['only'], 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
