// Trusted inputs/expectations only: this process never imports candidate code.
import { fuzzyScore } from './baseline-fuzzy.ts';

const vectors = [];
function add(group, method, args, expected) {
  vectors.push({ id: 'v' + vectors.length, group, method, args, expected });
}
function encode(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return { type: 'null' };
  if (Object.is(value, -0)) return { type: 'special_number', value: '-0' };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { type: 'number', value }
      : { type: 'special_number', value: String(value) };
  }
  if (typeof value === 'bigint') return { type: 'bigint', value: String(value) };
  return { type: Array.isArray(value) ? 'array' : typeof value, value };
}
function rankArgs(query, candidates, options) {
  const args = { query, candidates };
  if (options !== undefined) {
    args.options = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, encode(value)]));
  }
  return args;
}
function expectedRanking(query, candidates, options = {}) {
  const pool = [];
  for (let index = 0; index < candidates.length; index++) {
    const score = query === '' ? 0 : fuzzyScore(query, candidates[index]);
    if ((query === '' || score > 0) && score >= (options.minScore ?? 0)) {
      pool.push({ item: candidates[index], score, index });
    }
  }
  const result = [];
  // Selection ordering is independent of the sort and insertion reference overlays.
  while (pool.length && (options.limit === undefined || result.length < options.limit)) {
    let best = 0;
    for (let index = 1; index < pool.length; index++) {
      if (pool[index].score > pool[best].score) best = index;
    }
    result.push(pool.splice(best, 1)[0]);
  }
  return result;
}
function rank(group, query, candidates, options, expected = expectedRanking(query, candidates, options)) {
  add(group, 'rank', rankArgs(query, candidates, options), { kind: 'return', value: expected });
}
function invalid(group, options, query = '', candidates = []) {
  add(group, 'rank', rankArgs(query, candidates, options), { kind: 'error', name: 'RangeError' });
}
function generatedCandidates(seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state; };
  const chars = ['a', 'b', 'A', 'B', 'x', ' ', '/', '[', '_', '-', '0', 'é', 'É', '😀', 'İ', '\t'];
  const values = ['', 'ab', 'a/b', 'ab', 'xa', '[a', ' a', 'a ', 'a', 'é', '😀', 'İ'];
  for (let index = 0; index < 68; index++) {
    if (index % 7 === 0) { values.push(values[next() % values.length]); continue; }
    let value = '';
    const length = next() % 10;
    for (let pos = 0; pos < length; pos++) value += chars[next() % chars.length];
    values.push(value);
  }
  return values;
}
const queries = ['', 'a', 'b', 'ab', 'ba', 'aa', 'A', 'a ', ' ', '\t', '/a', '[', 'é', 'i', 'İ', '😀'];
for (const [query, target, value] of [
  ['', '', 0], ['', 'abc', 0], ['a', '', 0], ['ab', 'ab', 8], ['AB', 'ab', 8],
  ['ab', 'a/b', 6], ['ab', 'xaby', 6], ['ab', 'alphabet', 4], ['ab', 'ba', 0],
  ['b', '[b', 3], ['b', ' b', 3], ['b', '/b', 3], ['b', '_b', 1], ['b', '-b', 1],
  ['b', '\tb', 1], ['aa', 'aaa', 8], ['aa', 'a a', 6], ['a b', 'a b', 13],
  ['é', 'café', 1], ['É', 'Éclair', 3],
]) add('legacy scorer fixed expectations', 'score', { query, target }, { kind: 'return', value });
for (const seed of [0xC0FFEE, 0x31415926, 0x12345678]) {
  for (const target of generatedCandidates(seed)) {
    for (const query of queries) {
      add('legacy scorer generated preservation', 'score', { query, target }, { kind: 'return', value: fuzzyScore(query, target) });
    }
  }
}

const input = ['a----b', 'ab', 'a/b', 'xaby', 'nothing', 'ab'];
const ranked = [
  { item: 'ab', score: 8, index: 1 }, { item: 'ab', score: 8, index: 5 },
  { item: 'a/b', score: 6, index: 2 }, { item: 'xaby', score: 6, index: 3 },
  { item: 'a----b', score: 4, index: 0 },
];
rank('fixed ranking and distinct duplicate indices', 'ab', input, undefined, ranked);
rank('limit follows global ranking', 'ab', input, { limit: 1 }, ranked.slice(0, 1));
rank('limit follows global ranking', 'ab', input, { limit: 3, minScore: 6 }, ranked.slice(0, 3));
rank('limit follows filtering', 'ab', ['none', 'ab'], { limit: 1 }, [{ item: 'ab', score: 8, index: 1 }]);
for (const query of ['ab', '']) {
  rank('zero limit', query, input, { limit: 0 }, []);
  rank('zero limit', query, input, { limit: -0 }, []);
}
rank('inclusive threshold', 'ab', input, { minScore: 8 }, ranked.slice(0, 2));
rank('fractional threshold', 'ab', input, { minScore: 8.01 }, []);
rank('fractional threshold', 'ab', input, { minScore: 5.5 }, ranked.slice(0, 4));
rank('large threshold', 'ab', input, { minScore: Number.MAX_VALUE }, []);
rank('nonmatches excluded', 'z', ['', 'abc', 'zzz', 'xzx'], { minScore: 0 }, [
  { item: 'zzz', score: 3, index: 2 }, { item: 'xzx', score: 1, index: 3 },
]);
rank('nonmatches excluded', 'ab', ['ba', '', 'none'], undefined, []);
rank('empty query preserves input order', '', ['z', '', 'a', 'a'], undefined, [
  { item: 'z', score: 0, index: 0 }, { item: '', score: 0, index: 1 },
  { item: 'a', score: 0, index: 2 }, { item: 'a', score: 0, index: 3 },
]);
rank('empty query applies options', '', ['z', '', 'a'], { limit: 2 });
rank('empty query applies options', '', ['z', '', 'a'], { minScore: 0.01 }, []);
rank('empty query applies options', '', ['z', '', 'a'], { minScore: 0, limit: 9 });
rank('literal leading whitespace', ' ab', ['ab', ' ab', 'x ab', 'a b'], undefined, [
  { item: ' ab', score: 13, index: 1 }, { item: 'x ab', score: 11, index: 2 },
]);
rank('literal space-only query', ' ', ['', 'no-space', 'x y', ' a', 'z z z', '\t', ' '], undefined, [
  { item: ' a', score: 3, index: 3 }, { item: ' ', score: 3, index: 6 },
  { item: 'x y', score: 1, index: 2 }, { item: 'z z z', score: 1, index: 4 },
]);
rank('ties retain input order', 'a', ['za', 'xa', 'xa'], undefined, [
  { item: 'za', score: 1, index: 0 }, { item: 'xa', score: 1, index: 1 }, { item: 'xa', score: 1, index: 2 },
]);
rank('legacy case handling', 'AB', input, undefined, ranked);
rank('legacy case handling', 'é', ['café', 'Éclair', 'É'], undefined, [
  { item: 'Éclair', score: 3, index: 1 }, { item: 'É', score: 3, index: 2 }, { item: 'café', score: 1, index: 0 },
]);
for (const options of [undefined, {}, { limit: undefined, minScore: undefined }, { limit: Number.MAX_SAFE_INTEGER + 1 }]) {
  rank('optional defaults and large limit', 'ab', input, options, ranked);
}
rank('frozen input and options', 'a', ['xa', 'a', 'a'], { minScore: 0, limit: 2 }, [
  { item: 'a', score: 3, index: 1 }, { item: 'a', score: 3, index: 2 },
]);
rank('frozen input and options', 'x', ['xa', 'a', 'a'], undefined, [{ item: 'xa', score: 3, index: 0 }]);
rank('empty candidate list', 'a', [], undefined, []);
rank('empty candidate list', '', [], undefined, []);
for (const value of [-1, 0.5, NaN, Infinity, -Infinity, '1', null, true, {}, [], 1n]) {
  for (const query of ['', 'a']) invalid('invalid limit on empty candidates', { limit: value }, query);
}
for (const value of [-1, NaN, Infinity, -Infinity, '0', null, false, {}, [], 1n]) {
  for (const query of ['', 'a']) {
    invalid('invalid threshold on empty candidates', { minScore: value }, query);
    invalid('invalid threshold before zero limit', { minScore: value, limit: 0 }, query, input);
  }
}
for (const seed of [0xC0FFEE, 0x31415926, 0x12345678]) {
  for (const query of queries) {
    for (const options of [{}, { limit: 0 }, { limit: 1 }, { limit: 7 }, { minScore: 1 }, { minScore: 3 }, { minScore: 5.5, limit: 4 }]) {
      rank('generated ranking and option combinations', query, generatedCandidates(seed), options);
    }
  }
}
console.log(JSON.stringify({ case_id: 'BRPCB-C', vectors }));
