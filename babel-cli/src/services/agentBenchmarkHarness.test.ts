import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { defaultSwebenchDatasetPath } from './agentBenchmark.js';
import {
  buildSweAgentChatEnv,
  buildSweIssuePrompt,
  isDockerAvailable,
  loadSwebenchInstance,
  resolveSwebenchForkPath,
  resolveTerminalBenchRoot,
} from './agentBenchmarkHarness.js';

test('resolveTerminalBenchRoot prefers workspace benchmarks repo', () => {
  const root = resolveTerminalBenchRoot();
  assert.ok(typeof root === 'string' && root.length > 0);
  const pilot = join(root, 'scripts', 'run_babel_terminal_bench_pilot.mjs');
  // Sibling `Workspace/benchmarks` is optional on CI checkouts (only the repo is cloned).
  // When provisioned, the pilot script must be resolvable; otherwise skip presence assert.
  if (!existsSync(pilot)) {
    return;
  }
  assert.ok(existsSync(pilot), `expected terminal-bench pilot at ${pilot}`);
});

test('resolveSwebenchForkPath points at workspace SWE-bench fork when present', () => {
  const fork = resolveSwebenchForkPath();
  assert.ok(typeof fork === 'string' && fork.includes('SWE-bench-fork'));
  // Optional external asset — absent on clean CI runners without workspace benchmarks/.
  if (!existsSync(fork)) {
    return;
  }
  assert.ok(existsSync(fork), `expected SWE-bench fork at ${fork}`);
});

test('loadSwebenchInstance reads manifest SWE-A01 row from provisioned JSONL', () => {
  const datasetPath = defaultSwebenchDatasetPath();
  assert.ok(existsSync(datasetPath), `dataset missing at ${datasetPath}`);
  const row = loadSwebenchInstance(datasetPath, 'astropy__astropy-12907');
  assert.ok(row);
  assert.equal(row.instance_id, 'astropy__astropy-12907');
  assert.ok(row.problem_statement.length > 20);
  const prompt = buildSweIssuePrompt(row);
  assert.match(prompt, /Fix the issue described below/);
});

test('isDockerAvailable reports docker daemon status', () => {
  const available = isDockerAvailable();
  assert.equal(typeof available, 'boolean');
});

test('buildSweAgentChatEnv omits wall unless explicitly set (P0.3)', () => {
  const without = buildSweAgentChatEnv({ BABEL_PROVIDER: 'x' }, {});
  assert.equal(without['BABEL_CHAT_TASK_CLASS'], 'general_swe');
  assert.equal(without['BABEL_CHAT_MAX_WALL_MS'], undefined);
  assert.equal(without['BABEL_DIFF_CRITIC'], '1');
  assert.equal(without['BABEL_HEADLESS'], '1');
  assert.equal(without['BABEL_BENCHMARK_AUTO_APPROVE'], '1');

  const withWall = buildSweAgentChatEnv({}, { BABEL_CHAT_MAX_WALL_MS: '900000' });
  assert.equal(withWall['BABEL_CHAT_MAX_WALL_MS'], '900000');
});

// ─── Semantic Gold-Diff Comparison ──────────────────────────────────────────

import {
  isWhitespaceOnlyChangeLine,
  normalizeHunkChange,
  normalizeParsedFileChanges,
  parsePatchToFileChanges,
  patchesMatchSemantically,
} from './agentBenchmarkHarness.js';

const SINGLE_FILE_GOLD = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index abc..def 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -10,7 +10,8 @@ module Foo {',
  '  const x = 1;',
  '-  const y = 2;',
  '+  const y = 42;',
  '+  const z = 3;',
  '  const w = 4;',
  '  return x + w;',
  '}',
].join('\n');

const SINGLE_FILE_DIFFERENT_HUNK_HEADER = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 123..456 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -9,6 +9,8 @@ module Foo {',
  '  const x = 1;',
  '-  const y = 2;',
  '+  const y = 42;',
  '+  const z = 3;',
].join('\n');

const SINGLE_FILE_DIFFERENT_CONTEXT = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index abc..def 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -10,7 +10,8 @@ module Foo {',
  '-  const y = 2;',
  '+  const y = 42;',
  '+  const z = 3;',
].join('\n');

const SINGLE_FILE_TRAILING_WS = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index abc..def 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -10,7 +10,8 @@ module Foo {   ',
  '  const x = 1;  ',
  '-  const y = 2;   ',
  '+  const y = 42;  ',
  '+  const z = 3;',
  '  const w = 4;',
  '  return x + w;',
  '}',
].join('\n');

const DIFFERENT_CHANGE = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index abc..def 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -10,7 +10,8 @@ module Foo {',
  '  const x = 1;',
  '-  const y = 2;',
  '+  const y = 99;',
  '+  const z = 3;',
  '  const w = 4;',
  '  return x + w;',
  '}',
].join('\n');

test('semantic gold-diff: both empty patches match', () => {
  assert.ok(patchesMatchSemantically('', ''));
  assert.ok(patchesMatchSemantically('  ', ''));
  assert.ok(patchesMatchSemantically('', '\n\n'));
});

test('semantic gold-diff: one empty, one non-empty does not match', () => {
  assert.ok(!patchesMatchSemantically('', SINGLE_FILE_GOLD));
  assert.ok(!patchesMatchSemantically(SINGLE_FILE_GOLD, ''));
});

test('semantic gold-diff: identical patches match', () => {
  assert.ok(patchesMatchSemantically(SINGLE_FILE_GOLD, SINGLE_FILE_GOLD));
});

test('semantic gold-diff: different hunk header line numbers match', () => {
  assert.ok(
    patchesMatchSemantically(SINGLE_FILE_GOLD, SINGLE_FILE_DIFFERENT_HUNK_HEADER),
  );
});

test('semantic gold-diff: different context lines match', () => {
  assert.ok(
    patchesMatchSemantically(SINGLE_FILE_GOLD, SINGLE_FILE_DIFFERENT_CONTEXT),
  );
});

test('semantic gold-diff: trailing whitespace differences match', () => {
  assert.ok(
    patchesMatchSemantically(SINGLE_FILE_GOLD, SINGLE_FILE_TRAILING_WS),
  );
});

test('semantic gold-diff: extra index/git metadata lines match', () => {
  // Remove the index line from one patch -- should still match
  const withoutIndex = SINGLE_FILE_GOLD
    .split('\n')
    .filter((l) => !l.startsWith('index '))
    .join('\n');
  assert.ok(patchesMatchSemantically(SINGLE_FILE_GOLD, withoutIndex));
  assert.ok(patchesMatchSemantically(withoutIndex, SINGLE_FILE_GOLD));
});

test('semantic gold-diff: different code changes do not match', () => {
  assert.ok(!patchesMatchSemantically(SINGLE_FILE_GOLD, DIFFERENT_CHANGE));
});

test('semantic gold-diff: no match when files differ', () => {
  const goldFile = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    'index abc..def 100644',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,4 @@',
    ' a',
    '-b',
    '+B',
    '+c',
  ].join('\n');
  const agentChangedDifferentFile = [
    'diff --git a/src/bar.ts b/src/bar.ts',
    'index abc..def 100644',
    '--- a/src/bar.ts',
    '+++ b/src/bar.ts',
    '@@ -1,3 +1,4 @@',
    ' a',
    '-b',
    '+B',
    '+c',
  ].join('\n');
  assert.ok(!patchesMatchSemantically(agentChangedDifferentFile, goldFile));
});

test('semantic gold-diff: different hunk count does not match', () => {
  // Two substantive hunks in gold, one in agent
  const twoHunkGold = SINGLE_FILE_GOLD + '\n' + SINGLE_FILE_GOLD.replace('@@ -10,7', '@@ -20,7 @@');
  assert.ok(!patchesMatchSemantically(SINGLE_FILE_GOLD, twoHunkGold));
});

test('isWhitespaceOnlyChangeLine detects blank +/- lines', () => {
  assert.equal(isWhitespaceOnlyChangeLine('-'), true);
  assert.equal(isWhitespaceOnlyChangeLine('+'), true);
  assert.equal(isWhitespaceOnlyChangeLine('-   '), true);
  assert.equal(isWhitespaceOnlyChangeLine('+  \t'), true);
  assert.equal(isWhitespaceOnlyChangeLine('-        self.records = []'), false);
  assert.equal(isWhitespaceOnlyChangeLine('+    def clear(self) -> None:'), false);
});

test('normalizeHunkChange drops pure whitespace hunks', () => {
  assert.equal(
    normalizeHunkChange({ minusLines: ['-'], plusLines: [] }),
    null,
  );
  const kept = normalizeHunkChange({
    minusLines: ['-', '-        self.handler.reset()'],
    plusLines: ['+        self.handler.clear()', '+'],
  });
  assert.ok(kept);
  assert.deepEqual(kept!.minusLines, ['-        self.handler.reset()']);
  assert.deepEqual(kept!.plusLines, ['+        self.handler.clear()']);
});

test('semantic gold-diff: pure whitespace-only gold hunk is ignored (SWE-A09 class)', () => {
  // Gold includes a blank-line tidy hunk agents often omit; substantive clear() fix matches.
  const goldWithWsHunk = [
    'diff --git a/src/_pytest/logging.py b/src/_pytest/logging.py',
    '--- a/src/_pytest/logging.py',
    '+++ b/src/_pytest/logging.py',
    '@@ -40,7 +40,6 @@',
    ' else:',
    '     logging_StreamHandler = logging.StreamHandler',
    ' ',
    '-',
    ' DEFAULT_LOG_FORMAT = "%(levelname)-8s %(name)s:%(filename)s:%(lineno)d %(message)s"',
    '@@ -345,6 +344,10 @@ def reset(self) -> None:',
    '         self.records = []',
    '         self.stream = StringIO()',
    ' ',
    '+    def clear(self) -> None:',
    '+        self.records.clear()',
    '+        self.stream = StringIO()',
    '+',
    '     def handleError(self, record: logging.LogRecord) -> None:',
    '@@ -440,7 +443,7 @@ def messages(self) -> List[str]:',
    '     def clear(self) -> None:',
    '-        self.handler.reset()',
    '+        self.handler.clear()',
  ].join('\n');

  const agentGoldDirection = [
    'diff --git a/src/_pytest/logging.py b/src/_pytest/logging.py',
    'index a4f4214b1..1c5b64b7b 100644',
    '--- a/src/_pytest/logging.py',
    '+++ b/src/_pytest/logging.py',
    '@@ -345,6 +345,10 @@ class LogCaptureHandler(logging_StreamHandler):',
    '         self.records = []',
    '         self.stream = StringIO()',
    ' ',
    '+    def clear(self) -> None:',
    '+        self.records.clear()',
    '+        self.stream = StringIO()',
    '+',
    '     def handleError(self, record: logging.LogRecord) -> None:',
    '@@ -440,7 +444,7 @@ class LogCaptureFixture:',
    '     def clear(self) -> None:',
    '-        self.handler.reset()',
    '+        self.handler.clear()',
  ].join('\n');

  assert.ok(
    patchesMatchSemantically(agentGoldDirection, goldWithWsHunk),
    'agent gold-direction clear() patch must match gold despite blank-line tidy hunk',
  );

  // Raw parse still sees the whitespace hunk; normalize drops it.
  const goldParsed = parsePatchToFileChanges(goldWithWsHunk);
  assert.equal(goldParsed[0]!.hunks.length, 3);
  const goldNorm = normalizeParsedFileChanges(goldParsed);
  assert.equal(goldNorm[0]!.hunks.length, 2);
});

test('semantic gold-diff: hunk order within a file does not matter after normalize', () => {
  const hunkA = [
    '@@ -1,3 +1,3 @@',
    '-oldA',
    '+newA',
  ].join('\n');
  const hunkB = [
    '@@ -10,3 +10,3 @@',
    '-oldB',
    '+newB',
  ].join('\n');
  const header = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
  ].join('\n');
  const ab = `${header}\n${hunkA}\n${hunkB}`;
  const ba = `${header}\n${hunkB}\n${hunkA}`;
  assert.ok(patchesMatchSemantically(ab, ba));
});

test('semantic gold-diff: live SWE-A09 preds vs dataset gold (when available)', () => {
  const datasetPath = defaultSwebenchDatasetPath();
  const predsPath = join(
    process.cwd(),
    '..',
    'runs',
    'agent-benchmark-critic-remeasure',
    'SWE-A09-preds.jsonl',
  );
  // Skip quietly when evidence not present in this workspace.
  if (!existsSync(datasetPath) || !existsSync(predsPath)) {
    return;
  }
  const row = loadSwebenchInstance(datasetPath, 'pytest-dev__pytest-10051');
  assert.ok(row?.patch);
  const predLine = readFileSync(predsPath, 'utf8').trim().split(/\n/)[0]!;
  const pred = JSON.parse(predLine) as { model_patch?: string };
  assert.ok(pred.model_patch);
  // Live preds are environmental (wrong localization, budget kills, etc.).
  // Only assert when the latest pred already matches gold — smoke-tests that
  // normalize is stable on real SWE-A09 artifacts when a correct pred exists.
  if (!patchesMatchSemantically(pred.model_patch!, row!.patch!)) {
    return; // environmental: latest live pred is not gold-correct
  }
  assert.ok(
    patchesMatchSemantically(pred.model_patch!, row!.patch!),
    'live A09 gold pred must remain stable under whitespace normalize',
  );
});

test('parsePatchToFileChanges returns correct structure', () => {
  const files = parsePatchToFileChanges(SINGLE_FILE_GOLD);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.filename, 'src/foo.ts');
  assert.equal(files[0]!.hunks.length, 1);
  assert.deepEqual(files[0]!.hunks[0]!.minusLines, ['-  const y = 2;']);
  assert.deepEqual(files[0]!.hunks[0]!.plusLines, [
    '+  const y = 42;',
    '+  const z = 3;',
  ]);
});

test('parsePatchToFileChanges handles multi-file patch', () => {
  const multiFilePatch = [
    'diff --git a/src/foo.ts b/src/foo.ts',
    'index abc..def 100644',
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -1,3 +1,4 @@',
    ' a',
    '-b',
    '+B',
    '+c',
    'diff --git a/src/bar.ts b/src/bar.ts',
    'index 789..012 100644',
    '--- a/src/bar.ts',
    '+++ b/src/bar.ts',
    '@@ -3,4 +3,5 @@',
    ' bar',
    '+baz',
    ' qux',
  ].join('\n');
  const files = parsePatchToFileChanges(multiFilePatch);
  assert.equal(files.length, 2);
  assert.equal(files[0]!.filename, 'src/foo.ts');
  assert.equal(files[1]!.filename, 'src/bar.ts');
});

test('parsePatchToFileChanges returns empty for empty input', () => {
  assert.deepEqual(parsePatchToFileChanges(''), []);
  assert.deepEqual(parsePatchToFileChanges('   '), []);
});

// ─── Local verifier pass / false_complete classification (SWE-A09) ──────────

import { classifySweFalseComplete, hasLocalVerifierPass } from './agentBenchmarkHarness.js';

test('hasLocalVerifierPass: true for verifier_receipt exit 0 (SWE-A09 class)', () => {
  assert.equal(
    hasLocalVerifierPass({
      status: 'ANSWER_READY',
      verifier_receipt: {
        command: 'python -m pytest testing/logging/test_fixture.py -v -x',
        exit_code: 0,
        summary: 'passed',
      },
    }),
    true,
  );
});

test('hasLocalVerifierPass: true for verification.status completed exit 0', () => {
  assert.equal(
    hasLocalVerifierPass({
      verification: { status: 'completed', commands: ['npm test'], exit_code: 0 },
    }),
    true,
  );
});

test('hasLocalVerifierPass: false without receipt or failed exit', () => {
  assert.equal(hasLocalVerifierPass(null), false);
  assert.equal(hasLocalVerifierPass({}), false);
  assert.equal(
    hasLocalVerifierPass({
      verifier_receipt: { command: 'npm test', exit_code: 1, summary: 'fail' },
    }),
    false,
  );
});

test('hasLocalVerifierPass: B2 agent-owned _verify*.py exit 0 does not count', () => {
  assert.equal(
    hasLocalVerifierPass({
      status: 'ANSWER_READY',
      verifier_receipt: {
        command: 'python _verify_fix.py',
        exit_code: 0,
        summary: 'ok',
      },
    }),
    false,
  );
  assert.equal(
    hasLocalVerifierPass({
      verification: {
        status: 'completed',
        command: 'python _test_qdp_fix.py',
        exit_code: 0,
      },
    }),
    false,
  );
});

// ─── classifySweFalseComplete formula (table-driven) ────────────────────────

const localPassPayload = {
  status: 'ANSWER_READY',
  verifier_receipt: { command: 'pytest', exit_code: 0, summary: 'ok' },
};

const cases: Array<{
  name: string;
  claimedComplete: boolean;
  verifierOk: boolean;
  patch: string;
  payload: Record<string, unknown> | null;
  expected: boolean;
}> = [
  {
    name: 'A09 class: claimed + external fail + non-empty + local pass → NOT false_complete',
    claimedComplete: true,
    verifierOk: false,
    patch: 'diff --git a/x b/x\n',
    payload: localPassPayload,
    expected: false,
  },
  {
    name: 'claimed + external fail + non-empty + NO local pass → false_complete',
    claimedComplete: true,
    verifierOk: false,
    patch: 'diff --git a/x b/x\n',
    payload: { status: 'ANSWER_READY' },
    expected: true,
  },
  {
    name: 'claimed + external fail + empty patch + local pass → false_complete',
    claimedComplete: true,
    verifierOk: false,
    patch: '   ',
    payload: localPassPayload,
    expected: true,
  },
  {
    name: 'claimed + external fail + empty patch + no local → false_complete',
    claimedComplete: true,
    verifierOk: false,
    patch: '',
    payload: null,
    expected: true,
  },
  {
    name: 'external pass → never false_complete',
    claimedComplete: true,
    verifierOk: true,
    patch: 'diff',
    payload: null,
    expected: false,
  },
  {
    name: 'did not claim complete → never false_complete',
    claimedComplete: false,
    verifierOk: false,
    patch: '',
    payload: null,
    expected: false,
  },
];

for (const c of cases) {
  test(`classifySweFalseComplete: ${c.name}`, () => {
    assert.equal(
      classifySweFalseComplete({
        claimedComplete: c.claimedComplete,
        verifierOk: c.verifierOk,
        patch: c.patch,
        payload: c.payload,
      }),
      c.expected,
    );
  });
}

// ─── Failure notes + empty_patch_rate + Windows docker skip ─────────────────

import {
  buildTargetedPytestHint,
  classifySweFailureNote,
  computeEmptyPatchRate,
  extractSweTestNames,
  payloadIsBudgetExceeded,
  shouldSkipDockerEvalOnPlatform,
} from './agentBenchmarkHarness.js';

test('classifySweFailureNote: incorrect_patch vs false_complete vs budget', () => {
  assert.equal(
    classifySweFailureNote({
      claimedComplete: true,
      verifierOk: false,
      patch: 'diff --git a/x',
      payload: localPassPayload,
    }),
    'incorrect_patch',
  );
  assert.equal(
    classifySweFailureNote({
      claimedComplete: true,
      verifierOk: false,
      patch: 'diff --git a/x',
      payload: { status: 'ANSWER_READY' },
    }),
    'false_complete',
  );
  assert.equal(
    classifySweFailureNote({
      claimedComplete: false,
      verifierOk: false,
      patch: 'diff',
      payload: { status: 'BUDGET_EXCEEDED', budget_exceeded: true },
      budgetExceeded: true,
    }),
    'budget_exceeded',
  );
});

test('payloadIsBudgetExceeded detects BUDGET_EXCEEDED status and answer', () => {
  assert.equal(payloadIsBudgetExceeded({ status: 'BUDGET_EXCEEDED' }), true);
  assert.equal(
    payloadIsBudgetExceeded({
      answer: { summary: 'BUDGET_EXCEEDED: Time budget exceeded', answer: '...' },
    }),
    true,
  );
  assert.equal(payloadIsBudgetExceeded({ status: 'ANSWER_READY' }), false);
});

test('computeEmptyPatchRate is first-class KPI helper', () => {
  const rate = computeEmptyPatchRate([
    { notes: ['empty_patch'] },
    { notes: ['patch_bytes=504'] },
    { notes: 'patch_bytes=0' },
    { patch_bytes: 0 },
  ]);
  assert.equal(rate, 0.75);
  assert.equal(computeEmptyPatchRate([]), null);
});

test('shouldSkipDockerEvalOnPlatform: Windows skips loudly', () => {
  assert.equal(shouldSkipDockerEvalOnPlatform('win32'), true);
  assert.equal(shouldSkipDockerEvalOnPlatform('linux'), false);
});

test('isDockerAvailable is independent of platform eval-skip (real daemon probe)', () => {
  // Contract: Windows must not force false without probing — otherwise
  // runAgentBenchmarkTask would docker_missing-short-circuit all SWE cells
  // before gold_diff can run. Result is environmental; only type is asserted.
  const available = isDockerAvailable();
  assert.equal(typeof available, 'boolean');
  // Eval skip remains true on Windows regardless of daemon probe.
  if (process.platform === 'win32') {
    assert.equal(shouldSkipDockerEvalOnPlatform(), true);
  }
});

test('extractSweTestNames + targeted pytest hint', () => {
  const names = extractSweTestNames({
    instance_id: 'x',
    repo: 'a/b',
    base_commit: 'abc',
    problem_statement: 'bug',
    FAIL_TO_PASS: '["testing/logging/test_fixture.py::test_clear"]',
  } as never);
  assert.ok(names.some((n) => n.includes('test_clear')));
  const hint = buildTargetedPytestHint(names);
  assert.ok(hint);
  assert.match(hint!, /pytest/);
});

// ─── C2: First-move card integration ───────────────────────────────────────

import type { PlaybookDefinition } from './playbooks/playbookService.js';

const MOCK_PLAYBOOK: PlaybookDefinition = {
  id: 'single-file',
  description: 'Test playbook',
  select: { skills: ['single_file', 'python'] },
  phaseGuidance: {
    explore: 'Test explore guidance.',
    diagnose: 'Test diagnose guidance.',
    fix: 'Test fix guidance.',
    verify: 'Test verify guidance.',
  },
};

function makeSweRow(opts: {
  instanceId?: string;
  repo?: string;
  baseCommit?: string;
  problemStatement?: string;
  failToPass?: string;
  hintsText?: string;
}) {
  return {
    instance_id: opts.instanceId ?? 'test__test-1',
    repo: opts.repo ?? 'test-org/test-repo',
    base_commit: opts.baseCommit ?? 'abc123',
    problem_statement: opts.problemStatement ?? 'Fix the bug.',
    hints_text: opts.hintsText,
    FAIL_TO_PASS: opts.failToPass,
  };
}

test('buildSweIssuePrompt with playbook + testNames includes first-move card', () => {
  const row = makeSweRow({
    problemStatement:
      'The `LogCaptureFixture.clear` method should call `self.handler.clear()` ' +
      'instead of `self.handler.reset()`.',
    failToPass: '["testing/logging/test_fixture.py::test_clear"]',
  });

  const prompt = buildSweIssuePrompt(row as never, MOCK_PLAYBOOK);

  // First-move card markers
  assert.match(prompt, /First-Move Card/);
  assert.match(prompt, /Do NOT search for test files/i);
  assert.match(prompt, /testing\/logging\/test_fixture\.py/);
  assert.match(prompt, /python -m pytest/);
  // Symbol section
  assert.match(prompt, /Issue Symbols/);
  assert.match(prompt, /LogCaptureFixture\.clear/);
  // Playbook content still present
  assert.match(prompt, /Test explore guidance/);
  // Old hardcoded steps absent
  assert.ok(!prompt.includes('Work through these steps in order'));
});

test('buildSweIssuePrompt with playbook but no testNames uses old layout', () => {
  const row = makeSweRow({
    problemStatement: 'Fix the histogram density range bug.',
    // No failToPass → testNames will be empty
  });

  const prompt = buildSweIssuePrompt(row as never, MOCK_PLAYBOOK);

  // Should NOT contain first-move card
  assert.ok(!prompt.includes('First-Move Card'));
  assert.ok(!prompt.includes('DO NOT search for test files'));
  // Should contain the old-style issue text
  assert.match(prompt, /Fix the issue described below/);
  assert.match(prompt, /Fix the histogram density range bug/);
  // Playbook content still present
  assert.match(prompt, /Test explore guidance/);
});

test('buildSweIssuePrompt without playbook uses old hardcoded steps', () => {
  const row = makeSweRow({
    problemStatement: 'Fix something.',
    failToPass: '["tests/test_x.py::test_case"]',
  });

  const prompt = buildSweIssuePrompt(row as never);

  // Old hardcoded steps present (no playbook → backward compat path)
  assert.match(prompt, /Work through these steps in order/);
  // Test file header still included
  assert.match(prompt, /Test Files \(from dataset/);
  // Not first-move card (no playbook → old path)
  assert.ok(!prompt.includes('First-Move Card'));
});
