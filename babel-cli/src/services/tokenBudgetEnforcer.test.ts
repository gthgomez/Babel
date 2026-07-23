/**
 * tokenBudgetEnforcer.test.ts — Tests for proactive token budget enforcement.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkTokenBudget, resolveBudgetLimit, formatBudgetStatus } from './tokenBudgetEnforcer.js';

describe('checkTokenBudget', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    if (restore) restore();
  });

  function setBudget(value: string | undefined): void {
    const prev = process.env['BABEL_TOKEN_BUDGET'];
    if (value === undefined) {
      delete process.env['BABEL_TOKEN_BUDGET'];
    } else {
      process.env['BABEL_TOKEN_BUDGET'] = value;
    }
    restore = () => {
      if (prev === undefined) {
        delete process.env['BABEL_TOKEN_BUDGET'];
      } else {
        process.env['BABEL_TOKEN_BUDGET'] = prev;
      }
    };
  }

  it('proceeds when tokens are well under budget', () => {
    setBudget('3200');
    const result = checkTokenBudget(1000);
    assert.equal(result.proceed, true);
    assert.equal(result.budgetLimit, 3200);
    assert.equal(result.tokensRemaining, 2200);
  });

  it('proceeds with warning when near budget (>=80%)', () => {
    setBudget('3200');
    const result = checkTokenBudget(2800); // 87.5% of 3200
    assert.equal(result.proceed, true);
    assert.ok(result.reason?.includes('warning'));
  });

  it('halts when budget is exactly exhausted', () => {
    setBudget('3200');
    const result = checkTokenBudget(3200);
    assert.equal(result.proceed, false);
    assert.ok(result.reason?.includes('exhausted'));
  });

  it('halts when budget is exceeded', () => {
    setBudget('1000');
    const result = checkTokenBudget(1500);
    assert.equal(result.proceed, false);
    assert.equal(result.tokensRemaining, -500);
  });

  it('uses default budget when BABEL_TOKEN_BUDGET is not set', () => {
    setBudget(undefined);
    const result = checkTokenBudget(100);
    assert.equal(result.proceed, true);
    assert.equal(result.budgetLimit, 3200); // default
  });

  it('respects CLI override over env var', () => {
    setBudget('3200');
    const result = checkTokenBudget(4000, 5000); // CLI says 5000
    assert.equal(result.proceed, true);
    assert.equal(result.budgetLimit, 5000);
  });

  it('handles zero tokens used', () => {
    setBudget('1000');
    const result = checkTokenBudget(0);
    assert.equal(result.proceed, true);
    assert.equal(result.tokensUsed, 0);
    assert.equal(result.tokensRemaining, 1000);
  });

  it('handles invalid BABEL_TOKEN_BUDGET value', () => {
    setBudget('not-a-number');
    const result = checkTokenBudget(100);
    assert.equal(result.proceed, true);
    assert.equal(result.budgetLimit, 3200); // falls back to default
  });
});

describe('resolveBudgetLimit', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    if (restore) restore();
  });

  it('returns env var value when set', () => {
    const prev = process.env['BABEL_TOKEN_BUDGET'];
    process.env['BABEL_TOKEN_BUDGET'] = '5000';
    restore = () => {
      if (prev === undefined) delete process.env['BABEL_TOKEN_BUDGET'];
      else process.env['BABEL_TOKEN_BUDGET'] = prev;
    };
    assert.equal(resolveBudgetLimit(), 5000);
  });

  it('returns CLI override when provided', () => {
    assert.equal(resolveBudgetLimit(8000), 8000);
  });

  it('returns default when nothing is set', () => {
    const prev = process.env['BABEL_TOKEN_BUDGET'];
    delete process.env['BABEL_TOKEN_BUDGET'];
    restore = () => {
      if (prev === undefined) delete process.env['BABEL_TOKEN_BUDGET'];
      else process.env['BABEL_TOKEN_BUDGET'] = prev;
    };
    assert.equal(resolveBudgetLimit(), 3200);
  });
});

describe('formatBudgetStatus', () => {
  it('formats exceeded status', () => {
    const result = checkTokenBudget(5000, 3200);
    const status = formatBudgetStatus(result);
    assert.match(status, /\[BUDGET_EXCEEDED\]/);
  });

  it('formats warning status', () => {
    const result = checkTokenBudget(2800, 3200);
    const status = formatBudgetStatus(result);
    assert.match(status, /\[BUDGET_WARNING\]/);
  });

  it('formats ok status', () => {
    const result = checkTokenBudget(100, 3200);
    const status = formatBudgetStatus(result);
    assert.match(status, /\[BUDGET_OK\]/);
  });
});
