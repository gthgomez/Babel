import assert from 'node:assert/strict';
import test from 'node:test';
import { fuzzyScore } from '../src/fuzzy.ts';
import { rankCandidates } from '../src/rankCandidates.ts';

test('the existing fuzzy scorer retains its documented observable scores', () => {
  const examples = [
    ['', 'anything', 0],
    ['ab', 'ab', 8],
    ['AB', 'ab', 8],
    ['ab', 'a/b', 6],
    ['ab', 'xaby', 6],
    ['ab', 'alphabet', 4],
    ['ab', 'ba', 0],
    ['b', '[b', 3],
    ['b', '_b', 1],
  ];
  for (const [query, target, score] of examples) {
    assert.equal(fuzzyScore(query, target), score, JSON.stringify({ query, target }));
  }
});

test('rankCandidates ranks matches and preserves original indices for duplicates', () => {
  const candidates = Object.freeze(['xa', 'a', '/a', 'banana', 'a', 'zzz']);
  let actual;
  assert.doesNotThrow(() => {
    actual = rankCandidates('a', candidates);
  }, 'the requested ranking feature must be implemented');
  assert.equal(Array.isArray(actual), true);
  assert.deepEqual(actual.map(({ item, score, index }) => ({ item, score, index })), [
    { item: 'a', score: 3, index: 1 },
    { item: '/a', score: 3, index: 2 },
    { item: 'a', score: 3, index: 4 },
    { item: 'xa', score: 1, index: 0 },
    { item: 'banana', score: 1, index: 3 },
  ]);
});
