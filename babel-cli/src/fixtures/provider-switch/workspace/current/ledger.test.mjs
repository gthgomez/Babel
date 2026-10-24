import assert from 'node:assert/strict';
import { test } from 'node:test';

import { total } from './ledger.mjs';

test('ledger total includes credits and debits', () => {
  assert.equal(total(), 150);
});

test('ledger total over an empty book is zero', () => {
  assert.equal(total([]), 0);
});
