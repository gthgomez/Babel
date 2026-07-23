import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiteSessionProgress, createNoopLiteSessionProgress } from './liteSessionProgress.js';

test('createLiteSessionProgress records session loop synthesis', () => {
  const previousCi = process.env['CI'];
  const previousNoColor = process.env['NO_COLOR'];
  process.env['CI'] = '1';
  process.env['NO_COLOR'] = '1';
  try {
    const progress = createLiteSessionProgress();
    progress.report('discover', 'Gathering repo context…');
    progress.synthesizeFromPayload({
      session_loop_steps: [
        { phase: 'observe', status: 'pass', policy_decision: 'allow' },
        { phase: 'finish', status: 'pass', policy_decision: 'allow' },
      ],
    });
    progress.finish('pass');

    assert.deepEqual(progress.getProgressSteps(), [
      'Gathering repo context…',
      'Observe pass',
      'Finish pass',
      'Read-only run complete',
    ]);
  } finally {
    if (previousCi === undefined) {
      delete process.env['CI'];
    } else {
      process.env['CI'] = previousCi;
    }
    if (previousNoColor === undefined) {
      delete process.env['NO_COLOR'];
    } else {
      process.env['NO_COLOR'] = previousNoColor;
    }
  }
});

test('createNoopLiteSessionProgress stays silent', () => {
  const progress = createNoopLiteSessionProgress();
  progress.report('discover');
  progress.finish('pass');
  assert.deepEqual(progress.getProgressSteps(), []);
});

test('createLiteSessionProgress avoids duplicate synthesized steps', () => {
  const previousCi = process.env['CI'];
  const previousNoColor = process.env['NO_COLOR'];
  process.env['CI'] = '1';
  process.env['NO_COLOR'] = '1';
  try {
    const progress = createLiteSessionProgress();
    progress.report('discover');
    progress.synthesizeFromPayload({
      session_loop_steps: [
        { phase: 'observe', status: 'pass', policy_decision: 'allow' },
        { phase: 'observe', status: 'pass', policy_decision: 'allow' },
      ],
    });
    const steps = progress.getProgressSteps();
    assert.equal(steps.filter((step) => step === 'Observe pass').length, 1);
  } finally {
    if (previousCi === undefined) {
      delete process.env['CI'];
    } else {
      process.env['CI'] = previousCi;
    }
    if (previousNoColor === undefined) {
      delete process.env['NO_COLOR'];
    } else {
      process.env['NO_COLOR'] = previousNoColor;
    }
  }
});
