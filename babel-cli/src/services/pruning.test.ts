import assert from 'node:assert/strict';
import test from 'node:test';

import { isContextPruningEnabled } from './pruning.js';

test('context pruning is opt-in only', () => {
  assert.equal(isContextPruningEnabled({}), false);
  assert.equal(isContextPruningEnabled({ BABEL_CONTEXT_PRUNING: 'false' }), false);
  assert.equal(isContextPruningEnabled({ BABEL_CONTEXT_PRUNING: '1' }), false);
  assert.equal(isContextPruningEnabled({ BABEL_CONTEXT_PRUNING: 'true' }), true);
});
