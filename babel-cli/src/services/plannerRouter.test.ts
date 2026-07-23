import assert from 'node:assert/strict';
import test from 'node:test';

import { assessPlanningComplexity, type PlannerRouteDecision } from './plannerRouter.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function baseInput(overrides: Partial<Parameters<typeof assessPlanningComplexity>[0]> = {}) {
  return {
    task: 'List all the files in the src directory.',
    qaRejections: [] as string[],
    previousRejectionTags: [] as string[][],
    attempt: 1,
    ...overrides,
  };
}

function assertDefaultRoute(decision: PlannerRouteDecision): void {
  assert.equal(
    decision.startTierIndex,
    0,
    `startTierIndex should be 0, got ${decision.startTierIndex}. Rationale: ${decision.rationale}`,
  );
  assert.deepEqual(decision.skipTierKeys, [], 'skipTierKeys should be empty');
  assert.equal(decision.escalatedByRepeatedFailure, false);
  assert.equal(decision.recommendedEffort, 'high', 'default effort should be high');
}

function assertEscalated(
  decision: PlannerRouteDecision,
  expectedStartIndex: number,
  expectedSkip: string[],
  expectedEffort?: 'high' | 'max',
): void {
  assert.equal(
    decision.startTierIndex,
    expectedStartIndex,
    `startTierIndex should be ${expectedStartIndex}`,
  );
  assert.deepEqual(
    decision.skipTierKeys,
    expectedSkip,
    `skipTierKeys should be ${JSON.stringify(expectedSkip)}`,
  );
  assert.ok(decision.rationale.length > 0, 'rationale should not be empty');
  if (expectedEffort) {
    assert.equal(decision.recommendedEffort, expectedEffort, `effort should be ${expectedEffort}`);
  }
}

// ─── Priority 6: Default (no signals) ─────────────────────────────────────────

test('default route — simple file listing task, first attempt', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'List all the files in the src directory.',
    }),
  );
  assertDefaultRoute(result);
  assert.match(result.rationale, /default/i);
});

test('default route — simple read-only question', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'What does the package.json say about the project version?',
      manifestComplexity: 'Low' as const,
    }),
  );
  assertDefaultRoute(result);
});

test('default route — medium complexity but no risk signals', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Add a comment to the calculateTotal function in utils.ts.',
      manifestComplexity: 'Medium' as const,
    }),
  );
  assertDefaultRoute(result);
});

// ─── Priority 5: Model escalation rules ───────────────────────────────────────

test('escalation rules trigger — performance optimization', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Optimize the performance of the database query. The latency is too high.',
    }),
  );
  assertEscalated(result, 1, ['scout']);
  assert.equal(result.escalatedByRepeatedFailure, false);
  assert.match(result.rationale, /escalation/i);
});

test('escalation rules trigger — exploit/bypass construction', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Check if the XSS filter bypass works in the sandbox.',
    }),
  );
  assertEscalated(result, 1, ['scout']);
  assert.match(result.rationale, /escalation/i);
});

test('escalation rules — no trigger for simple comment task', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Add a JSDoc comment to the helper function.',
    }),
  );
  assertDefaultRoute(result);
});

// ─── Priority 4: Lite/Full router risk signals ────────────────────────────────

test('risk signals trigger — exact_literal_invariants', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Update status-final.txt so its entire contents are the exact string "final exact ok". Do not modify status.txt.',
    }),
  );
  assertEscalated(result, 1, ['scout']);
  assert.match(result.rationale, /exact_literal_invariants/);
});

test('risk signals trigger — repo_wide_or_architecture', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Refactor the entire architecture to use a plugin-based system across the repo.',
    }),
  );
  assertEscalated(result, 1, ['scout']);
  assert.match(result.rationale, /repo_wide_or_architecture/);
});

test('risk signals — simple formatting task does not trigger', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Format the code in utils.ts according to the style guide.',
    }),
  );
  assertDefaultRoute(result);
});

// ─── Priority 3: Orchestrator high complexity ─────────────────────────────────

test('orchestrator high complexity triggers escalation', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Add a simple utility function.',
      manifestComplexity: 'High' as const,
    }),
  );
  assertEscalated(result, 1, ['scout']);
  assert.match(result.rationale, /complexity.*High/i);
});

test('orchestrator medium complexity does not trigger escalation on simple task', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Add a simple utility function.',
      manifestComplexity: 'Medium' as const,
    }),
  );
  assertDefaultRoute(result);
});

test('orchestrator low complexity does not trigger escalation', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Add a simple utility function.',
      manifestComplexity: 'Low' as const,
    }),
  );
  assertDefaultRoute(result);
});

// ─── Priority 2: Final retry attempt ──────────────────────────────────────────

test('final attempt (3/3) escalates to strongest model', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Fix the test in math.test.js.',
      attempt: 3,
      qaRejections: ['[missing_verification] No verification step in plan'],
      previousRejectionTags: [['missing_verification'], ['scope_creep']],
    }),
  );
  assertEscalated(result, 2, ['scout', 'qwen3-32b']);
  assert.equal(result.escalatedByRepeatedFailure, true);
  assert.match(result.rationale, /final/i);
});

test('attempt 2 with no repeated pattern stays on default route', () => {
  // Only 1 previous attempt, no overlap possible — should not trigger
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Fix the test in math.test.js.',
      attempt: 2,
      previousRejectionTags: [['missing_verification']],
    }),
  );
  assertDefaultRoute(result);
});

// ─── Priority 1: Repeated failure pattern ─────────────────────────────────────

test('repeated failure pattern — ≥50% tag overlap across 2 attempts', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Fix the failing test.',
      attempt: 2,
      qaRejections: [
        '[missing_verification] No verification step',
        '[scope_creep] Plan modifies files outside scope',
      ],
      previousRejectionTags: [
        ['missing_verification', 'scope_creep'],
        ['missing_verification', 'scope_creep', 'exact_drift'],
      ],
    }),
  );
  // 2/3 tags overlap between last two attempts = 67% → repeated pattern
  assertEscalated(result, 2, ['scout', 'qwen3-32b']);
  assert.equal(result.escalatedByRepeatedFailure, true);
  assert.match(result.rationale, /repeated/i);
});

test('different tags across attempts — no repeated pattern trigger', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Fix the failing test.',
      attempt: 2,
      qaRejections: ['[exact_drift] File content mismatch'],
      previousRejectionTags: [['missing_verification'], ['exact_drift']],
    }),
  );
  // 0% overlap → no repeated pattern → stays at default
  assertDefaultRoute(result);
});

test('attempt 1 with no prior rejections stays at default', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Fix the failing test.',
      attempt: 1,
      previousRejectionTags: [],
    }),
  );
  assertDefaultRoute(result);
});

// ─── Priority overlap: higher priority wins ───────────────────────────────────

test('repeated failure (P1) overrides orchestrator complexity (P3)', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Fix the failing test.',
      manifestComplexity: 'High' as const,
      attempt: 3,
      qaRejections: ['[missing_verification] No verification step'],
      previousRejectionTags: [['missing_verification'], ['missing_verification']],
    }),
  );
  // P1+P2 (final attempt + repeated pattern) should win over P3 (high complexity)
  assertEscalated(result, 2, ['scout', 'qwen3-32b'], 'max');
  assert.equal(result.escalatedByRepeatedFailure, true);
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

test('risk signals detect exact literal even when qaRejections is empty', () => {
  const result = assessPlanningComplexity(
    baseInput({
      task: 'The implementation must contain the exact string "return a + b;".',
      attempt: 2,
      qaRejections: [],
      previousRejectionTags: [['scope_creep']],
    }),
  );
  assertEscalated(result, 1, ['scout']);
  assert.equal(result.escalatedByRepeatedFailure, false);
});

test('below-50% overlap does not trigger repeated failure', () => {
  // Only 1 tag out of 3 overlaps → 33% < 50% threshold → no trigger
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Fix the failing test.',
      attempt: 2,
      previousRejectionTags: [
        ['tag_a', 'tag_b', 'tag_c'],
        ['tag_a', 'tag_d', 'tag_e'],
      ],
    }),
  );
  assertDefaultRoute(result);
});

test('exact string in task text triggers escalation (real matrix case)', () => {
  // This is the actual matrix case text that fails with EXACT_INSTRUCTION_DRIFT.
  // The smart planner should detect exact literal invariants and skip scout.
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Update exact-status.txt so its entire contents are the exact string autonomous exact ok. Do not modify other files.',
    }),
  );
  assertEscalated(result, 1, ['scout']);
  assert.match(result.rationale, /exact_literal/);
});

test('TypeScript repair task triggers escalation via repair risk signal', () => {
  // The npm typecheck repair matrix case — should escalate.
  const result = assessPlanningComplexity(
    baseInput({
      task: 'Fix the TypeScript type error in src/index.ts. Only edit src/index.ts. Run npm run typecheck before completing. The final src/index.ts implementation must contain the exact string "export const answer: number = 42;".',
    }),
  );
  assertEscalated(result, 1, ['scout']);
});
