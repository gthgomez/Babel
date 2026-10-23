import assert from 'node:assert/strict';
import test from 'node:test';
import { isPriceExpired } from '../src/model_tariff.ts';

test('a rate remains current during its last allowed UTC day', () => {
  assert.equal(
    isPriceExpired({ effectiveTo: '2026-12-31' }, new Date('2026-12-31T12:00:00Z')),
    false,
  );
});

test('a rate expires at exactly the following UTC midnight', () => {
  assert.equal(
    isPriceExpired({ effectiveTo: '2026-12-31' }, new Date('2027-01-01T00:00:00Z')),
    true,
  );
});

test('missing, null, and empty bounds stay unbounded', () => {
  for (const entry of [undefined, null, {}, { effectiveTo: undefined }, { effectiveTo: null }, { effectiveTo: '' }]) {
    assert.equal(isPriceExpired(entry, new Date('2026-12-31T12:00:00Z')), false);
  }
});

test('malformed and impossible dates fail closed', () => {
  for (const effectiveTo of ['not-a-date', '2026-02-30', '2026-2-3', ' ', false, 20261231]) {
    assert.equal(isPriceExpired({ effectiveTo }, new Date('2026-01-01T00:00:00Z')), true);
  }
});

test('valid dates may have surrounding whitespace', () => {
  assert.equal(
    isPriceExpired({ effectiveTo: ' \t2026-12-31\n' }, new Date('2026-12-30T12:00:00Z')),
    false,
  );
});
