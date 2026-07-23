import assert from 'node:assert/strict';
import test from 'node:test';

import { renderTextRunPrelude } from './runPrelude.js';
import { stripAnsi } from './theme.js';

test('renderTextRunPrelude includes task and pipeline sections', () => {
  const rendered = stripAnsi(
    renderTextRunPrelude({
      task: 'Fix failing tests',
      mode: 'deep',
      project: 'Babel',
      orchestrator: 'v9',
      executionProfile: 'safe_repo',
    }),
  );
  assert.match(rendered, /Fix failing tests/);
  assert.match(rendered, /PIPELINE/);
  assert.match(rendered, /STATUS/);
});

test('renderTextRunPrelude shows plan warning for plan mode', () => {
  const rendered = stripAnsi(
    renderTextRunPrelude({
      task: 'Prepare rollout plan',
      mode: 'plan',
    }),
  );
  assert.match(rendered, /PLAN MODE ACTIVE/);
});
