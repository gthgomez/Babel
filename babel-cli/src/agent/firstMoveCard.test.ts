import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildInteractiveFirstMoveHint,
  buildSweFirstMoveCard,
  computeToolsBeforeFirstWrite,
  extractBacktickSymbols,
  extractTestFilePaths,
  type FirstMoveCard,
} from './firstMoveCard.js';

// ─── Symbol extraction ────────────────────────────────────────────────────

test('extractBacktickSymbols: extracts code identifiers from backticks', () => {
  const text =
    'The `LogCaptureHandler.clear` method should call `self.handler.clear()` ' +
    'instead of `self.handler.reset()`.';
  const syms = extractBacktickSymbols(text);
  assert.ok(syms.includes('LogCaptureHandler.clear'));
  assert.ok(syms.includes('self.handler.clear()'));
  assert.ok(syms.includes('self.handler.reset()'));
});

test('extractBacktickSymbols: filters out file paths', () => {
  const text =
    'The bug is in `src/foo/bar.py` — the `fix_func` should be updated.';
  const syms = extractBacktickSymbols(text);
  assert.ok(syms.includes('fix_func'));
  assert.ok(!syms.includes('src/foo/bar.py'));
});

test('extractBacktickSymbols: filters out URLs', () => {
  const text = 'See `https://example.com` for the `get_config` reference.';
  const syms = extractBacktickSymbols(text);
  assert.ok(syms.includes('get_config'));
  assert.ok(!syms.includes('https://example.com'));
});

test('extractBacktickSymbols: filters bare numbers', () => {
  const text = 'The `42` is wrong; use `MAX_SIZE`.';
  const syms = extractBacktickSymbols(text);
  assert.ok(syms.includes('MAX_SIZE'));
  assert.ok(!syms.includes('42'));
});

test('extractBacktickSymbols: deduplicates and caps at 20', () => {
  const parts: string[] = [];
  for (let i = 0; i < 30; i++) {
    parts.push(`\`sym_${i}\``);
  }
  const syms = extractBacktickSymbols(parts.join(' '));
  assert.equal(syms.length, 20);
});

test('extractBacktickSymbols: empty string returns empty', () => {
  assert.deepEqual(extractBacktickSymbols(''), []);
});

// ─── Test file path extraction ────────────────────────────────────────────

test('extractTestFilePaths: strips :: separators', () => {
  const names = [
    'testing/logging/test_fixture.py::test_clear',
    'testing/logging/test_fixture.py::TestLogCapture::test_reset',
    'other/test_foo.py::test_bar',
  ];
  const paths = extractTestFilePaths(names);
  assert.deepEqual(paths, [
    'testing/logging/test_fixture.py',
    'other/test_foo.py',
  ]);
});

test('extractTestFilePaths: handles names without ::', () => {
  const names = ['plain_test.py', 'another_test.py'];
  const paths = extractTestFilePaths(names);
  assert.deepEqual(paths, ['plain_test.py', 'another_test.py']);
});

test('extractTestFilePaths: caps at 5', () => {
  const names = Array.from({ length: 10 }, (_, i) => `test_${i}.py::test_fn`);
  const paths = extractTestFilePaths(names);
  assert.equal(paths.length, 5);
});

test('extractTestFilePaths: empty array returns empty', () => {
  assert.deepEqual(extractTestFilePaths([]), []);
});

// ─── First-move card builder ──────────────────────────────────────────────

test('buildSweFirstMoveCard: produces card with all sections', () => {
  const card: FirstMoveCard = buildSweFirstMoveCard({
    testNames: ['testing/logging/test_fixture.py::test_clear'],
    problemStatement:
      'The `LogCaptureFixture.clear` method should call `self.handler.clear()` ' +
      'instead of `self.handler.reset()`.',
    repo: 'pytest-dev/pytest',
  });

  const t = card.text;

  // Card header
  assert.match(t, /## First-Move Card/);

  // Repo
  assert.match(t, /pytest-dev\/pytest/);

  // Test files section
  assert.match(t, /### Test Files/);
  assert.match(t, /testing\/logging\/test_fixture\.py/);
  assert.match(t, /python -m pytest/);
  assert.match(t, /Do NOT search for test files/i);

  // Symbol section
  assert.match(t, /### Issue Symbols/);
  assert.match(t, /LogCaptureFixture\.clear/);
  assert.match(t, /self\.handler\.clear/);

  // Issue text
  assert.match(t, /### Issue/);
  assert.match(t, /The `LogCaptureFixture\.clear` method should call/);

  // Test names
  assert.match(t, /### Test Names/);
  assert.match(t, /test_clear/);

  // Metadata
  assert.equal(card.symbols.length, 3);
  assert.ok(card.symbols.includes('LogCaptureFixture.clear'));
  assert.deepEqual(card.testFilePaths, ['testing/logging/test_fixture.py']);
});

test('buildSweFirstMoveCard: no test names produces minimal card', () => {
  const card: FirstMoveCard = buildSweFirstMoveCard({
    testNames: [],
    problemStatement: 'Fix the histogram density range bug in plot.py.',
  });

  const t = card.text;
  assert.match(t, /First-Move Card/);
  assert.ok(!t.includes('### Test Files'));
  assert.match(t, /### Issue/);
  assert.ok(!t.includes('### Test Names'));
  assert.deepEqual(card.testFilePaths, []);
});

test('buildSweFirstMoveCard: no symbols still produces card', () => {
  const card: FirstMoveCard = buildSweFirstMoveCard({
    testNames: ['tests/test_x.py::test_case'],
    problemStatement: 'Fix the bug in the parser.',
  });

  const t = card.text;
  assert.match(t, /First-Move Card/);
  assert.ok(!t.includes('### Issue Symbols'));
  assert.match(t, /### Test Files/);
  assert.equal(card.symbols.length, 0);
});

test('buildSweFirstMoveCard: hints text included when present', () => {
  const card: FirstMoveCard = buildSweFirstMoveCard({
    testNames: [],
    problemStatement: 'Fix something.',
    hintsText: 'Look in src/parser.py around line 42.',
  });

  assert.match(card.text, /Look in src\/parser\.py/);
});

test('buildSweFirstMoveCard: multi-test card includes first run command', () => {
  const card: FirstMoveCard = buildSweFirstMoveCard({
    testNames: [
      'tests/test_a.py::test_one',
      'tests/test_b.py::test_two',
    ],
    problemStatement: 'Multi-test bug.',
  });

  // First test path should be the run target
  assert.match(card.text, /python -m pytest tests\/test_a\.py/);
});

// ─── tools_before_first_write metric ──────────────────────────────────────

test('computeToolsBeforeFirstWrite: counts before first successful write', () => {
  const calls = [
    { tool: 'grep' },
    { tool: 'read_file' },
    { tool: 'str_replace' }, // first write at index 2
    { tool: 'str_replace' },
    { tool: 'run_command' },
  ];
  assert.equal(computeToolsBeforeFirstWrite(calls), 2);
});

test('computeToolsBeforeFirstWrite: ignores failed writes', () => {
  const calls = [
    { tool: 'grep' },
    { tool: 'str_replace', error: 'str_replace_miss' },
    { tool: 'read_file' },
    { tool: 'str_replace' }, // first successful write at index 3
  ];
  assert.equal(computeToolsBeforeFirstWrite(calls), 3);
});

test('computeToolsBeforeFirstWrite: returns length when no write', () => {
  const calls = [
    { tool: 'grep' },
    { tool: 'read_file' },
    { tool: 'run_command' },
  ];
  assert.equal(computeToolsBeforeFirstWrite(calls), 3);
});

test('computeToolsBeforeFirstWrite: returns 0 when first call is a write', () => {
  const calls = [
    { tool: 'str_replace' },
    { tool: 'run_command' },
  ];
  assert.equal(computeToolsBeforeFirstWrite(calls), 0);
});

test('computeToolsBeforeFirstWrite: empty array returns 0', () => {
  assert.equal(computeToolsBeforeFirstWrite([]), 0);
});

// ─── Interactive first-move hint ──────────────────────────────────────────

test('buildInteractiveFirstMoveHint: includes test command and guidance', () => {
  const hint = buildInteractiveFirstMoveHint('npm test');
  assert.match(hint, /## First Move/);
  assert.match(hint, /Localize the fix BEFORE running tests/i);
  assert.match(hint, /npm test/);
  assert.match(hint, /Mutate first, verify second/);
});

test('buildInteractiveFirstMoveHint: works with pytest commands', () => {
  const hint = buildInteractiveFirstMoveHint('npx pytest tests/test_auth.py -v');
  assert.match(hint, /npx pytest tests\/test_auth\.py -v/);
});

test('buildInteractiveFirstMoveHint: produces non-empty string', () => {
  const hint = buildInteractiveFirstMoveHint('cargo test');
  assert.ok(hint.length > 0);
  assert.ok(hint.includes('cargo test'));
});
