import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDesktopApprovalLine, parseDesktopDecision } from './desktopApproval.js';

test('desktop approval accepts only an explicit allow_once decision', () => {
  assert.equal(parseDesktopApprovalLine('{"decision":"allow_once"}'), 'allow_once');
  assert.equal(parseDesktopApprovalLine('{"decision":"deny"}'), 'deny');
  assert.equal(parseDesktopApprovalLine('{"decision":"allow_session"}'), 'deny');
  assert.equal(parseDesktopApprovalLine('not-json'), 'deny');
  assert.equal(parseDesktopDecision('{"decision":"cancel"}'), 'cancel');
  assert.equal(parseDesktopApprovalLine('{"decision":"cancel"}'), 'deny');
});
