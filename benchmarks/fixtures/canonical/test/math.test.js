import assert from 'node:assert/strict';
import test from 'node:test';
import { add } from '../src/math.js';

test('add returns numeric sum', () => {
  assert.equal(add(2, 3), 5);
});
