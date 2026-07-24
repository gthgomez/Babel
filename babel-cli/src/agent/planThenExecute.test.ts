import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  countTaskWords,
  evaluatePlanThenExecuteGate,
  shouldRequireTodoPlan,
} from './planThenExecute.js';
import type { PlaybookDefinition } from '../services/playbooks/playbookService.js';

describe('planThenExecute', () => {
  const prev = {
    require: process.env['BABEL_REQUIRE_TODO_PLAN'],
    threshold: process.env['BABEL_TODO_PLAN_WORD_THRESHOLD'],
  };

  beforeEach(() => {
    delete process.env['BABEL_REQUIRE_TODO_PLAN'];
    delete process.env['BABEL_TODO_PLAN_WORD_THRESHOLD'];
  });

  afterEach(() => {
    if (prev.require === undefined) delete process.env['BABEL_REQUIRE_TODO_PLAN'];
    else process.env['BABEL_REQUIRE_TODO_PLAN'] = prev.require;
    if (prev.threshold === undefined) delete process.env['BABEL_TODO_PLAN_WORD_THRESHOLD'];
    else process.env['BABEL_TODO_PLAN_WORD_THRESHOLD'] = prev.threshold;
  });

  it('counts words', () => {
    assert.equal(countTaskWords('fix the bug in auth'), 5);
  });

  it('requires plan when playbook.requireTodoPlan', () => {
    const pb: PlaybookDefinition = {
      id: 'multi-file',
      description: 'm',
      select: { skills: ['multi_file'] },
      requireTodoPlan: true,
    };
    assert.equal(shouldRequireTodoPlan('short task', pb), true);
  });

  it('requires plan above word threshold', () => {
    process.env['BABEL_TODO_PLAN_WORD_THRESHOLD'] = '5';
    const long = 'one two three four five six';
    assert.equal(shouldRequireTodoPlan(long, null), true);
    assert.equal(shouldRequireTodoPlan('one two', null), false);
  });

  it('env 0 disables even with playbook', () => {
    process.env['BABEL_REQUIRE_TODO_PLAN'] = '0';
    const pb: PlaybookDefinition = {
      id: 'x',
      description: 'x',
      select: { skills: ['multi_file'] },
      requireTodoPlan: true,
    };
    assert.equal(shouldRequireTodoPlan('anything long enough for threshold', pb), false);
  });

  it('blocks str_replace when plan required and no todos', () => {
    const r = evaluatePlanThenExecuteGate({
      toolName: 'str_replace',
      requirePlan: true,
      todoCount: 0,
    });
    assert.equal(r.blocked, true);
    assert.ok(r.observation?.includes('plan-then-execute'));
  });

  it('allows str_replace after todos exist', () => {
    const r = evaluatePlanThenExecuteGate({
      toolName: 'str_replace',
      requirePlan: true,
      todoCount: 1,
    });
    assert.equal(r.blocked, false);
  });

  it('allows read tools without todos', () => {
    const r = evaluatePlanThenExecuteGate({
      toolName: 'read_file',
      requirePlan: true,
      todoCount: 0,
    });
    assert.equal(r.blocked, false);
  });
});
