import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginUserSubmission,
  emptyTurnCounters,
  priorWritesLeak,
  type TurnRuntimeSnapshot,
} from './turnRuntime.js';

const classify = (text: string): 'execute' | 'explain' =>
  /explain|what is|why/i.test(text) ? 'explain' : 'execute';

function snapshot(partial: Partial<TurnRuntimeSnapshot> & Pick<TurnRuntimeSnapshot, 'taskText'>): TurnRuntimeSnapshot {
  return {
    submissionIndex: 1,
    taskIntent: 'execute',
    taskClass: 'general_swe',
    gatePolicy: null,
    stickyIntent: 'execute',
    continuedTask: false,
    projectRoot: '/repo',
    ...emptyTurnCounters(),
    ...partial,
  };
}

test('beginUserSubmission isolates counters by default (no write leak)', () => {
  const prev = snapshot({
    submissionIndex: 1,
    taskText: 'fix the parser',
    writeCount: 5,
    gateStrikes: 2,
    turnsWithoutWrite: 3,
    consecutiveReadOnlyTools: 8,
  });

  const next = beginUserSubmission({
    userInput: 'now add a different feature in README',
    projectRoot: '/repo',
    classifyIntent: classify,
    previous: prev,
  });

  assert.equal(next.continuedTask, false);
  assert.equal(next.writeCount, 0);
  assert.equal(next.gateStrikes, 0);
  assert.equal(next.turnsWithoutWrite, 0);
  assert.equal(next.consecutiveReadOnlyTools, 0);
  assert.equal(next.submissionIndex, 2);
  assert.equal(priorWritesLeak(prev, next), false);
});

test('beginUserSubmission continueTask preserves counters and sticky intent', () => {
  const prev = snapshot({
    submissionIndex: 2,
    taskText: 'fix the parser',
    writeCount: 4,
    gateStrikes: 1,
    stickyIntent: 'execute',
    taskClass: 'quick_fix',
  });

  const next = beginUserSubmission({
    userInput: 'continue',
    projectRoot: '/repo',
    continueTask: true,
    classifyIntent: classify,
    previous: prev,
  });

  assert.equal(next.continuedTask, true);
  assert.equal(next.writeCount, 4);
  assert.equal(next.gateStrikes, 1);
  assert.equal(next.taskIntent, 'execute');
  assert.equal(next.stickyIntent, 'execute');
  assert.equal(next.taskClass, 'quick_fix');
  assert.equal(next.submissionIndex, 3);
});

test('continueTask without previous still isolates', () => {
  const next = beginUserSubmission({
    userInput: 'fix it',
    projectRoot: '/repo',
    continueTask: true,
    classifyIntent: classify,
    previous: null,
  });
  assert.equal(next.continuedTask, false);
  assert.equal(next.writeCount, 0);
  assert.equal(next.submissionIndex, 1);
});

test('explicit taskIntent overrides sticky classification', () => {
  const prev = snapshot({
    taskText: 'implement feature',
    stickyIntent: 'execute',
    writeCount: 1,
  });
  const next = beginUserSubmission({
    userInput: 'what is going on?',
    projectRoot: '/repo',
    taskIntent: 'explain',
    continueTask: true,
    classifyIntent: classify,
    previous: prev,
  });
  assert.equal(next.taskIntent, 'explain');
  assert.equal(next.stickyIntent, 'explain');
  assert.equal(next.writeCount, 1);
});

test('isolated submission reclassifies task class from new text', () => {
  const prev = snapshot({
    taskText: 'investigate architecture',
    taskClass: 'investigate',
    writeCount: 2,
  });
  const next = beginUserSubmission({
    userInput: 'fix the failing unit test in chatEngine',
    projectRoot: '/repo',
    classifyIntent: classify,
    previous: prev,
  });
  assert.equal(next.continuedTask, false);
  assert.equal(next.writeCount, 0);
  // quick_fix / general_swe depending on classifier — must not stay investigate
  assert.notEqual(next.taskClass, 'investigate');
});

test('model and projectRoot are recorded on snapshot for turn_started truth', () => {
  const next = beginUserSubmission({
    userInput: 'implement feature',
    projectRoot: '<BABEL_REPO_ROOT>',
    model: 'deepseek-v4-flash',
    classifyIntent: classify,
  });
  assert.equal(next.model, 'deepseek-v4-flash');
  assert.equal(next.projectRoot, '<BABEL_REPO_ROOT>');
  assert.equal(next.taskIntent, 'execute');
});

test('status question is a read-only presentation that preserves the objective', () => {
  const prev = snapshot({
    submissionIndex: 3,
    taskText: 'fix the failing authentication test',
    durableObjective: 'fix the failing authentication test',
    taskIntent: 'execute',
    stickyIntent: 'execute',
    effectiveOperation: 'MUTATING',
    taskClass: 'general_swe',
    writeCount: 2,
    gateStrikes: 1,
  });

  const next = beginUserSubmission({
    userInput: 'status?',
    projectRoot: '/repo',
    classifyIntent: classify, // legacy classifier would say 'execute' for 'status?'
    previous: prev,
  });

  assert.equal(next.presentationOnly, true);
  assert.equal(next.effectiveOperation, 'READ_ONLY');
  assert.equal(next.taskIntent, 'explain');
  assert.equal(next.durableObjective, 'fix the failing authentication test');
  // Prior counters/state preserved so progress is not lost on a status query.
  assert.equal(next.continuedTask, true);
  assert.equal(next.writeCount, 2);
  assert.equal(next.gateStrikes, 1);
  assert.equal(next.taskClass, 'general_swe');
  // The task's sticky intent survives so a later continue resumes the real task.
  assert.equal(next.stickyIntent, 'execute');
});

test('an explicit or gestured continue after a status presentation resumes the mutating task', () => {
  const prev = snapshot({
    taskText: 'fix the failing test',
    durableObjective: 'fix the failing test',
    effectiveOperation: 'MUTATING',
    stickyIntent: 'execute',
  });
  const status = beginUserSubmission({
    userInput: 'status?',
    projectRoot: '/repo',
    classifyIntent: classify,
    previous: prev,
  });
  assert.equal(status.effectiveOperation, 'READ_ONLY');

  const resumed = beginUserSubmission({
    userInput: 'continue',
    projectRoot: '/repo',
    continueTask: true,
    classifyIntent: classify,
    previous: status,
  });
  assert.equal(resumed.effectiveOperation, 'MUTATING');
  assert.equal(resumed.taskIntent, 'execute');
  assert.equal(resumed.durableObjective, 'fix the failing test');

  const gestured = beginUserSubmission({
    userInput: 'continue',
    projectRoot: '/repo',
    classifyIntent: classify,
    previous: status,
  });
  assert.equal(gestured.effectiveOperation, 'MUTATING');
  assert.equal(gestured.taskIntent, 'execute');
});

test('an explicit CHANGE operation overrides status presentation', () => {
  const prev = snapshot({
    taskText: 'fix the failing test',
    durableObjective: 'fix the failing test',
    effectiveOperation: 'MUTATING',
  });
  const next = beginUserSubmission({
    userInput: 'status?',
    projectRoot: '/repo',
    operation: 'CHANGE',
    classifyIntent: classify,
    previous: prev,
  });
  assert.equal(next.presentationOnly, undefined);
  assert.equal(next.effectiveOperation, 'MUTATING');
});
