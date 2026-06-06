import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVE_V9_BUDGET_POLICY,
  buildBudgetDiagnostics,
  resolveBudgetEvaluationTokens,
} from './budgetPolicy.js';

test('budget policy prefers actual prompt tokens when available', () => {
  const evaluation = resolveBudgetEvaluationTokens({
    declaredTokenBudgetTotal: 100,
    actualPromptTokens: 3000,
  });

  assert.deepEqual(evaluation, { tokenTotal: 3000, source: 'actual' });
});

test('budget policy falls back to declared token budget when actual is unavailable', () => {
  const evaluation = resolveBudgetEvaluationTokens({
    declaredTokenBudgetTotal: 2500,
    actualPromptTokens: null,
  });

  assert.deepEqual(evaluation, { tokenTotal: 2500, source: 'declared' });
});

test('budget diagnostics use actual prompt tokens for hard threshold severity', () => {
  const diagnostics = buildBudgetDiagnostics({
    declaredTokenBudgetTotal: 100,
    tokenBudgetMissing: [],
    policyApplies: true,
    budgetPolicy: ACTIVE_V9_BUDGET_POLICY,
    actualPromptTokens: 3000,
    actualMinusDeclared: 2900,
    driftWarningTolerance: 500,
  });

  assert.equal(diagnostics.some(diagnostic => diagnostic.code === 'budget_threshold_severe'), true);
  assert.equal(diagnostics.some(diagnostic => /policy source: actual/.test(diagnostic.message)), true);
});

test('budget diagnostics use declared tokens when actual counts are unavailable', () => {
  const diagnostics = buildBudgetDiagnostics({
    declaredTokenBudgetTotal: 2500,
    tokenBudgetMissing: [],
    policyApplies: true,
    budgetPolicy: ACTIVE_V9_BUDGET_POLICY,
    actualPromptTokens: null,
  });

  assert.equal(diagnostics.some(diagnostic => diagnostic.code === 'budget_threshold_warning'), true);
  assert.equal(diagnostics.some(diagnostic => /policy source: declared/.test(diagnostic.message)), true);
});

test('budget diagnostics warn when actual-vs-declared drift exceeds tolerance', () => {
  const diagnostics = buildBudgetDiagnostics({
    declaredTokenBudgetTotal: 100,
    tokenBudgetMissing: [],
    policyApplies: true,
    budgetPolicy: ACTIVE_V9_BUDGET_POLICY,
    actualPromptTokens: 1000,
    actualMinusDeclared: 900,
    driftWarningTolerance: 100,
  });

  assert.equal(diagnostics.some(diagnostic => diagnostic.code === 'actual_declared_token_drift'), true);
});
