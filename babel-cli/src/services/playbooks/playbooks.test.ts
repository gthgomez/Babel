import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSweIssuePrompt,
  type SwebenchInstanceRow,
  type PlaybookDefinition,
} from '../agentBenchmarkHarness.js';

// ─── Builders ───────────────────────────────────────────────────────────────

function makeInstance(overrides: Partial<SwebenchInstanceRow> = {}): SwebenchInstanceRow {
  return {
    instance_id: 'test__test-100',
    repo: 'test/test',
    base_commit: 'abc123',
    problem_statement: 'The function foo() returns null instead of 0.',
    hints_text: '',
    _babel_eval_dataset: 'princeton-nlp/SWE-bench_Verified',
    ...overrides,
  };
}

function makePlaybook(overrides: Partial<PlaybookDefinition> = {}): PlaybookDefinition {
  return {
    id: 'test-playbook',
    description: 'Test playbook',
    select: { skills: ['single_file'] },
    phaseGuidance: {
      explore: 'Test explore guidance.',
      diagnose: 'Test diagnose guidance.',
      fix: 'Test fix guidance.',
      verify: 'Test verify guidance.',
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('buildSweIssuePrompt', () => {
  it('produces the original prompt when no playbook is provided', () => {
    const instance = makeInstance();
    const prompt = buildSweIssuePrompt(instance);
    assert.ok(prompt.includes('Fix the issue described below'));
    assert.ok(prompt.includes('Work through these steps in order:'));
    assert.ok(prompt.includes(instance.problem_statement));
  });

  it('includes problem statement even without playbook', () => {
    const instance = makeInstance();
    const prompt = buildSweIssuePrompt(instance);
    assert.ok(prompt.includes(instance.problem_statement));
  });

  it('prepends phase guidance when playbook is provided', () => {
    const instance = makeInstance();
    const playbook = makePlaybook();
    const prompt = buildSweIssuePrompt(instance, playbook);
    assert.ok(prompt.includes('## Task Guidance'));
    assert.ok(prompt.includes('EXPLORE: Test explore guidance.'));
    assert.ok(prompt.includes('DIAGNOSE: Test diagnose guidance.'));
    assert.ok(prompt.includes('FIX: Test fix guidance.'));
    assert.ok(prompt.includes('VERIFY: Test verify guidance.'));
  });

  it('does not include hardcoded steps when playbook is provided', () => {
    const instance = makeInstance();
    const playbook = makePlaybook();
    const prompt = buildSweIssuePrompt(instance, playbook);
    assert.ok(!prompt.includes('Work through these steps in order:'));
  });

  it('includes problem statement after playbook guidance', () => {
    const instance = makeInstance();
    const playbook = makePlaybook();
    const prompt = buildSweIssuePrompt(instance, playbook);
    const guidanceIndex = prompt.indexOf('## Task Guidance');
    const problemIndex = prompt.indexOf(instance.problem_statement);
    assert.ok(guidanceIndex < problemIndex, 'guidance should appear before problem statement');
  });

  it('includes hints when present', () => {
    const instance = makeInstance({ hints_text: 'Check the edge case at line 42.' });
    const playbook = makePlaybook();
    const prompt = buildSweIssuePrompt(instance, playbook);
    assert.ok(prompt.includes('Check the edge case at line 42.'));
  });

  it('includes plan-first warning when requireTodoPlan is true', () => {
    const instance = makeInstance();
    const playbook = makePlaybook({
      requireTodoPlan: true,
      planFirstWarning: 'You MUST use todo_write FIRST.',
    });
    const prompt = buildSweIssuePrompt(instance, playbook);
    assert.ok(prompt.includes('You MUST use todo_write FIRST.'));
  });

  it('does not include plan warning when requireTodoPlan is false', () => {
    const instance = makeInstance();
    const playbook = makePlaybook({ requireTodoPlan: false });
    const prompt = buildSweIssuePrompt(instance, playbook);
    assert.ok(!prompt.includes('todo_write FIRST'));
  });

  it('omits undefined phase guidance entries', () => {
    const instance = makeInstance();
    const playbook = makePlaybook({
      phaseGuidance: {
        explore: 'Only explore.',
        // diagnose, fix, verify omitted
      },
    });
    const prompt = buildSweIssuePrompt(instance, playbook);
    assert.ok(prompt.includes('EXPLORE: Only explore.'));
    assert.ok(!prompt.includes('DIAGNOSE:'));
    assert.ok(!prompt.includes('FIX:'));
    assert.ok(!prompt.includes('VERIFY:'));
  });

  it('works with empty playbook (no phase guidance, no plan warning)', () => {
    const instance = makeInstance();
    const playbook = makePlaybook({ requireTodoPlan: false });
    const prompt = buildSweIssuePrompt(instance, playbook);
    assert.ok(prompt.includes(instance.problem_statement));
    // Should not crash — just produce clean output with problem statement
  });
});
