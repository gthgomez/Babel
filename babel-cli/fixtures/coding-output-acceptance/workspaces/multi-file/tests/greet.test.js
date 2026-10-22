import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGreeting } from '../src/index.ts';

test('formatGreeting', () => {
  assert.equal(formatGreeting('Babel'), 'Hello, Babel!');
});
