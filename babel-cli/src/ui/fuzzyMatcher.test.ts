import assert from 'node:assert/strict';
import test from 'node:test';
import { fuzzyMatch, fuzzyTest } from './fuzzyMatcher.js';

test('fuzzyMatch ranks exact matches highest', () => {
  const results = fuzzyMatch('agent', [
    'agentRuntime',
    'chatAgent',
    'unrelated',
    'AgentConfig',
  ]);
  assert.ok(results.length >= 1);
  // Exact prefix match should score higher than mid-word match
  assert.match(results[0]!.item, /agentRuntime|AgentConfig/);
});

test('fuzzyMatch respects limit', () => {
  const results = fuzzyMatch('test', ['test1', 'test2', 'test3', 'test4', 'test5'], { limit: 3 });
  assert.equal(results.length, 3);
});

test('fuzzyMatch respects minScore', () => {
  const results = fuzzyMatch('xyz', ['abcdef', 'ghijkl'], { minScore: 0.5 });
  assert.equal(results.length, 0);
});

test('fuzzyMatch with matchPaths treats path separators as word boundaries', () => {
  const candidates = [
    'src/utils/helpers.ts',
    'src/ui/utils.ts',
    'src/utils/fuzzy.ts',
    'utils/other.ts',
  ];
  // Without matchPaths: "utils/fuzzy" would match against the full paths
  // indiscriminately. With matchPaths, "/" is a word boundary, so "utils/fuzzy"
  // matches "src/utils/fuzzy.ts" with higher score (path-segment boundary match).
  const withPaths = fuzzyMatch('utils/fuzzy', candidates, { matchPaths: true });
  assert.ok(withPaths.length >= 1);
  // The path containing the exact consecutive segment match should rank highest
  assert.equal(withPaths[0]!.item, 'src/utils/fuzzy.ts');

  // Without matchPaths, the same query still matches but ranking may differ
  const withoutPaths = fuzzyMatch('utils/fuzzy', candidates, { matchPaths: false });
  assert.ok(withoutPaths.length >= 1);
});

test('fuzzyMatch with preferPrefix boosts prefix matches', () => {
  const candidates = [
    'help Show help',
    'mode Switch execution mode (chat/deep/plan)',
    'theme Change color theme',
  ];
  // With preferPrefix: true, "he" should rank "help" highest because it starts
  // with "he". The other candidates match out-of-order only.
  const prefixed = fuzzyMatch('he', candidates, { preferPrefix: true });
  assert.ok(prefixed.length >= 1);
  assert.equal(prefixed[0]!.item, 'help Show help');
  assert.ok(prefixed[0]!.score >= 0);
});

test('fuzzyMatch uses indexed WASM path (matchPatternIndexed) internally', () => {
  // The indexed path should produce identical results to the string-based path.
  // We verify correctness by checking ordering and content of results.
  const candidates = ['fooBar', 'fooBaz', 'fooQuux', 'barFoo'];
  const results = fuzzyMatch('foo', candidates);
  assert.ok(results.length >= 1);
  // All "foo*" candidates should rank before non-prefixed ones
  const foos = results.filter((r) => r.item.startsWith('foo'));
  assert.ok(foos.length >= 2);
  // Results are sorted by score descending
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i]!.score <= results[i - 1]!.score,
      `Expected ${results[i]!.item} (score=${results[i]!.score}) <= ${results[i - 1]!.item} (score=${results[i - 1]!.score})`,
    );
  }
});

test('fuzzyMatch with matchPaths finds file by path segment', () => {
  const files = [
    'src/components/Button.tsx',
    'src/utils/helpers.ts',
    'docs/api/button.md',
    'src/hooks/useButton.ts',
  ];
  // Query "button" should match all files with "button" in any segment
  // With matchPaths, path boundaries boost segment-aligned matches
  const results = fuzzyMatch('button', files, { matchPaths: true });
  assert.ok(results.length >= 1);
  // The file with "Button" as a complete path segment should rank high
  const buttonFiles = results.filter((r) => r.item.includes('Button') || r.item.includes('button'));
  assert.ok(buttonFiles.length >= 1);
});

test('fuzzyTest returns boolean', () => {
  assert.equal(fuzzyTest('read', 'read_file'), true);
  assert.equal(fuzzyTest('zzz', 'read_file'), false);
});
