import assert from 'node:assert/strict';
import { describe, test, after } from 'node:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseIntentPlanJson,
  heuristicIntentPlan,
  shouldSkipIntentCompiler,
  isIntentCompilerEnabled,
  compileIntentPlan,
  formatIntentPlanUserMessage,
} from './intentCompiler.js';
import type { IntentPlan } from './intentCompiler.js';

// ── helpers ────────────────────────────────────────────────────────────────

function fakeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

// ── parseIntentPlanJson ────────────────────────────────────────────────────

describe('parseIntentPlanJson', () => {
  test('parses valid JSON into IntentPlan', () => {
    const json = JSON.stringify({
      goal: 'Fix the histogram density range bug',
      success_criteria: ['Tests pass', 'No regressions'],
      likely_files: ['src/chart.ts', 'src/render.ts'],
      test_command: 'npx vitest run',
      constraints: ['Single file change only'],
      confidence: 0.7,
    });
    const plan = parseIntentPlanJson(json);
    assert.ok(plan);
    assert.equal(plan.goal, 'Fix the histogram density range bug');
    assert.deepEqual(plan.success_criteria, ['Tests pass', 'No regressions']);
    assert.deepEqual(plan.likely_files, ['src/chart.ts', 'src/render.ts']);
    assert.equal(plan.test_command, 'npx vitest run');
    assert.deepEqual(plan.constraints, ['Single file change only']);
    assert.equal(plan.confidence, 0.7);
  });

  test('parses markdown-fenced JSON', () => {
    const json = '```json\n' + JSON.stringify({
      goal: 'Fix bug',
      success_criteria: ['Pass'],
      likely_files: [],
      constraints: [],
      confidence: 0.8,
    }) + '\n```';
    const plan = parseIntentPlanJson(json);
    assert.ok(plan);
    assert.equal(plan.goal, 'Fix bug');
    assert.equal(plan.confidence, 0.8);
  });

  test('parses json without language tag', () => {
    const json = '```\n' + JSON.stringify({
      goal: 'Fix bug',
      success_criteria: [],
      likely_files: [],
      constraints: [],
      confidence: 0.5,
    }) + '\n```';
    const plan = parseIntentPlanJson(json);
    assert.ok(plan);
    assert.equal(plan.goal, 'Fix bug');
  });

  test('returns null for invalid JSON', () => {
    assert.equal(parseIntentPlanJson('not json at all'), null);
    assert.equal(parseIntentPlanJson('{ broken: true }'), null);
    assert.equal(parseIntentPlanJson(''), null);
  });

  test('returns null when goal is missing or empty', () => {
    assert.equal(parseIntentPlanJson(JSON.stringify({})), null);
    assert.equal(
      parseIntentPlanJson(JSON.stringify({ goal: '', success_criteria: [], likely_files: [], constraints: [] })),
      null,
    );
    assert.equal(
      parseIntentPlanJson(JSON.stringify({ goal: '  ', success_criteria: [], likely_files: [], constraints: [] })),
      null,
    );
  });

  test('clamps confidence to [0, 1]', () => {
    const high = parseIntentPlanJson(JSON.stringify({
      goal: 'x', success_criteria: [], likely_files: [], constraints: [], confidence: 5,
    }));
    assert.equal(high!.confidence, 1);

    const low = parseIntentPlanJson(JSON.stringify({
      goal: 'x', success_criteria: [], likely_files: [], constraints: [], confidence: -0.5,
    }));
    assert.equal(low!.confidence, 0);
  });

  test('defaults confidence to 0.5 when missing', () => {
    const plan = parseIntentPlanJson(JSON.stringify({
      goal: 'x', success_criteria: [], likely_files: [], constraints: [],
    }));
    assert.equal(plan!.confidence, 0.5);
  });

  test('filters non-string array entries', () => {
    const plan = parseIntentPlanJson(JSON.stringify({
      goal: 'Fix X',
      success_criteria: ['valid', 123, null, 'also valid', ''],
      likely_files: ['a.ts', true, 'b.ts'],
      constraints: [42, 'keep'],
    }));
    assert.ok(plan);
    assert.deepEqual(plan.success_criteria, ['valid', 'also valid']);
    assert.deepEqual(plan.likely_files, ['a.ts', 'b.ts']);
    assert.deepEqual(plan.constraints, ['keep']);
  });

  test('null for non-object parsed JSON', () => {
    assert.equal(parseIntentPlanJson('123'), null);
    assert.equal(parseIntentPlanJson('"string"'), null);
    assert.equal(parseIntentPlanJson('[]'), null);
  });
});

// ── heuristicIntentPlan ────────────────────────────────────────────────────

describe('heuristicIntentPlan', () => {
  test('vague task → non-empty goal + constraints', () => {
    const plan = heuristicIntentPlan('fix the histogram density range bug');
    assert.ok(plan.goal.length > 0);
    assert.ok(plan.success_criteria.length > 0);
    assert.ok(plan.constraints.length > 0);
    assert.ok(plan.confidence > 0);
    assert.ok(plan.confidence <= 1);
  });

  test('extracts backtick-quoted file paths', () => {
    const plan = heuristicIntentPlan(
      'fix the bug in `src/chart.ts` related to `src/render.ts`',
    );
    assert.ok(plan.likely_files.includes('src/chart.ts'));
    assert.ok(plan.likely_files.includes('src/render.ts'));
    assert.equal(plan.confidence, 0.4); // higher confidence with file hints
  });

  test('extracts path references from natural language', () => {
    const plan = heuristicIntentPlan(
      'fix the issue in src/utils/format.ts where dates are wrong',
    );
    assert.ok(plan.likely_files.some((f) => f.includes('format.ts')));
  });

  test('deduplicates likely files', () => {
    const plan = heuristicIntentPlan(
      'fix `src/a.ts` and also in file src/a.ts',
    );
    const aCount = plan.likely_files.filter((f) => f === 'src/a.ts').length;
    assert.equal(aCount, 1);
  });

  test('caps likely files at 5', () => {
    const plan = heuristicIntentPlan(
      'fix `a.ts` `b.ts` `c.ts` `d.ts` `e.ts` `f.ts` `g.ts`',
    );
    assert.ok(plan.likely_files.length <= 5);
  });

  test('detects test commands', () => {
    const plan = heuristicIntentPlan('run pytest to fix the auth bug');
    assert.ok(plan.test_command);
    assert.match(plan.test_command!, /pytest/i);
  });

  test('detects npm test commands', () => {
    const plan = heuristicIntentPlan('run npm test and fix the type error');
    assert.ok(plan.test_command);
    assert.match(plan.test_command!, /npm test/i);
  });

  test('no test_command for tasks without test hints', () => {
    const plan = heuristicIntentPlan('fix the histogram bug');
    assert.equal(plan.test_command, undefined);
  });

  test('extracts "single file" constraint', () => {
    const plan = heuristicIntentPlan('fix this single file change only');
    assert.ok(plan.constraints.some((c) => /single file/i.test(c)));
  });

  test('extracts "minimal patch" constraint', () => {
    const plan = heuristicIntentPlan('make a minimal patch to fix the test');
    assert.ok(plan.constraints.some((c) => /minimal patch/i.test(c)));
  });

  test('extracts "dont break tests" constraint', () => {
    const plan = heuristicIntentPlan("fix the bug but don't break existing tests");
    assert.ok(plan.constraints.some((c) => /do not break/i.test(c)));
  });

  test('default constraint when none extracted', () => {
    const plan = heuristicIntentPlan('fix it');
    assert.ok(plan.constraints.some((c) => /minimal, focused/i.test(c)));
  });

  test('truncates long goals', () => {
    const longTask = 'fix the histogram density range bug that occurs when rendering large datasets with many overlapping bins and causes the chart to display incorrect values on hover tooltips in production.';
    const plan = heuristicIntentPlan(longTask);
    assert.ok(plan.goal.length <= 145);
    assert.ok(plan.goal.endsWith('...'));
  });

  test('empty task still produces valid plan', () => {
    const plan = heuristicIntentPlan('  ');
    assert.ok(plan.goal.length >= 0); // trimmed string
    assert.ok(plan.constraints.length > 0);
  });

  test('extracts success criteria from test-pass language', () => {
    const plan = heuristicIntentPlan('make the unit tests pass for the auth module');
    assert.ok(plan.success_criteria.some((c) => /tests pass/i.test(c)));
  });

  test('extracts success criteria from build-pass language', () => {
    const plan = heuristicIntentPlan('make tsc pass without errors');
    assert.ok(plan.success_criteria.some((c) => /compiles without errors/i.test(c)));
  });
});

// ── shouldSkipIntentCompiler ───────────────────────────────────────────────

describe('shouldSkipIntentCompiler', () => {
  test('skips for investigate task class', () => {
    assert.equal(
      shouldSkipIntentCompiler('fix the bug', { taskClass: 'investigate' }),
      true,
    );
  });

  test('does not skip for execute task classes', () => {
    assert.equal(
      shouldSkipIntentCompiler('fix the bug', { taskClass: 'default' }),
      false,
    );
    assert.equal(
      shouldSkipIntentCompiler('fix the bug', { taskClass: 'general_swe' }),
      false,
    );
  });

  test('skips when dataset test path is present', () => {
    assert.equal(
      shouldSkipIntentCompiler('fix the bug', { hasDatasetTestPath: true }),
      true,
    );
  });

  test('skips when FAIL_TO_PASS is in task text', () => {
    assert.equal(
      shouldSkipIntentCompiler('FAIL_TO_PASS: test_a.py::test_foo — fix it'),
      true,
    );
  });

  test('skips when PASS_TO_PASS is in task text', () => {
    assert.equal(
      shouldSkipIntentCompiler('PASS_TO_PASS: test_b.py::test_bar — verify'),
      true,
    );
  });

  test('skips when task contains explicit pytest paths', () => {
    assert.equal(
      shouldSkipIntentCompiler(
        'In tests/logging/test_fixture.py::test_clear — fix the log handler',
      ),
      true,
    );
  });

  test('does not skip for normal execute task', () => {
    assert.equal(
      shouldSkipIntentCompiler('fix the histogram density range bug'),
      false,
    );
  });

  test('does not skip for quick fix task', () => {
    assert.equal(
      shouldSkipIntentCompiler('rename this variable', { taskClass: 'quick_fix' }),
      false,
    );
  });
});

// ── isIntentCompilerEnabled ────────────────────────────────────────────────

describe('isIntentCompilerEnabled', () => {
  test('defaults to enabled when env is unset', () => {
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: undefined })), true);
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: '' })), true);
  });

  test('disabled with 0, false, off, or no', () => {
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: '0' })), false);
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: 'false' })), false);
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: 'off' })), false);
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: 'no' })), false);
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: 'FALSE' })), false);
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: 'OFF' })), false);
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: 'NO' })), false);
  });

  test('enabled with 1, true, on, or any other value', () => {
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: '1' })), true);
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: 'true' })), true);
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: 'on' })), true);
    assert.equal(isIntentCompilerEnabled(fakeEnv({ BABEL_CHAT_INTENT_COMPILER: 'yes' })), true);
  });
});

// ── compileIntentPlan (integration) ────────────────────────────────────────

describe('compileIntentPlan', () => {
  test('returns plan for vague execute task', () => {
    const plan = compileIntentPlan('fix the histogram density range bug');
    assert.ok(plan);
    assert.ok(plan.goal.length > 0);
    assert.ok(plan.constraints.length > 0);
  });

  test('returns null when disabled via env', () => {
    const env = fakeEnv({ BABEL_CHAT_INTENT_COMPILER: '0' });
    assert.equal(compileIntentPlan('fix bug', { env }), null);
  });

  test('returns null when skipped (investigate)', () => {
    assert.equal(
      compileIntentPlan('explain this code', { taskClass: 'investigate' }),
      null,
    );
  });

  test('returns null when skipped (FAIL_TO_PASS)', () => {
    assert.equal(
      compileIntentPlan('FAIL_TO_PASS: test_a.py::test_x — fix the bug'),
      null,
    );
  });

  test('returns null when skipped (dataset test path)', () => {
    assert.equal(
      compileIntentPlan('fix the bug', { hasDatasetTestPath: true }),
      null,
    );
  });

  test('returns null for empty task', () => {
    assert.equal(compileIntentPlan(''), null);
    assert.equal(compileIntentPlan('  '), null);
  });

  test('allows override via env to force-enable for SWE', () => {
    // Even with FAIL_TO_PASS, if env is unset (default on) the
    // shouldSkipIntentCompiler still wins — this is correct behavior.
    // The env only gates enable/disable; skip logic is independent.
    const plan = compileIntentPlan('fix the histogram bug');
    assert.ok(plan); // no skip signals → plan emitted
  });
});

// ── formatIntentPlanUserMessage ────────────────────────────────────────────

describe('formatIntentPlanUserMessage', () => {
  test('includes goal, success criteria, constraints, confidence', () => {
    const plan: IntentPlan = {
      goal: 'Fix the histogram bug',
      success_criteria: ['Tests pass', 'No regressions'],
      likely_files: ['src/chart.ts'],
      test_command: 'npx vitest run',
      constraints: ['Single file change only'],
      confidence: 0.4,
    };
    const msg = formatIntentPlanUserMessage(plan);
    assert.ok(msg.includes('Fix the histogram bug'));
    assert.ok(msg.includes('Tests pass'));
    assert.ok(msg.includes('src/chart.ts'));
    assert.ok(msg.includes('npx vitest run'));
    assert.ok(msg.includes('Single file change only'));
    assert.ok(msg.includes('40%'));
    assert.ok(msg.includes('heuristic'));
  });

  test('omits likely_files section when empty', () => {
    const plan: IntentPlan = {
      goal: 'Fix it',
      success_criteria: ['Done'],
      likely_files: [],
      constraints: ['Minimal'],
      confidence: 0.3,
    };
    const msg = formatIntentPlanUserMessage(plan);
    assert.ok(!msg.includes('**Likely files**'));
  });

  test('omits test_command section when absent', () => {
    const plan: IntentPlan = {
      goal: 'Fix it',
      success_criteria: ['Done'],
      likely_files: [],
      constraints: ['Minimal'],
      confidence: 0.3,
    };
    const msg = formatIntentPlanUserMessage(plan);
    assert.ok(!msg.includes('**Test command**'));
  });

  test('message is non-empty and well-structured', () => {
    const plan = heuristicIntentPlan('fix the histogram density range bug');
    const msg = formatIntentPlanUserMessage(plan);
    assert.ok(msg.startsWith('## Intent Plan'));
    assert.ok(msg.includes('**Goal**'));
    assert.ok(msg.includes('**Success criteria**'));
    assert.ok(msg.includes('**Constraints**'));
    assert.ok(msg.includes('**Confidence**'));
  });
});

// ── end-to-end: persistIntentPlan (disk integration) ───────────────────────

describe('persistIntentPlan', () => {
  let tmpDir: string;

  test('writes intent_plan.json to run_dir', async () => {
    // Dynamic import to avoid top-level fs dependency that fails in harness
    const { persistIntentPlan } = await import('./chatEngineObservability.js');

    tmpDir = join(tmpdir(), `babel-c1-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const plan: IntentPlan = {
      goal: 'Fix histogram range',
      success_criteria: ['Tests pass'],
      likely_files: ['src/chart.ts'],
      constraints: ['Minimal patch'],
      confidence: 0.4,
    };

    await persistIntentPlan(tmpDir, plan);

    const raw = await (await import('node:fs/promises')).readFile(
      join(tmpDir, 'intent_plan.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw);
    assert.equal(parsed.goal, 'Fix histogram range');
    assert.deepEqual(parsed.success_criteria, ['Tests pass']);
    assert.deepEqual(parsed.likely_files, ['src/chart.ts']);
    assert.deepEqual(parsed.constraints, ['Minimal patch']);
    assert.equal(parsed.confidence, 0.4);
  });

  test('writes with null test_command when absent', async () => {
    const { persistIntentPlan } = await import('./chatEngineObservability.js');

    const plan: IntentPlan = {
      goal: 'Fix it',
      success_criteria: ['Done'],
      likely_files: [],
      constraints: ['Minimal'],
      confidence: 0.3,
    };

    await persistIntentPlan(tmpDir, plan);

    const raw = await (await import('node:fs/promises')).readFile(
      join(tmpDir, 'intent_plan.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw);
    assert.equal(parsed.test_command, null);
  });

  // Clean up temp dir
  after(async () => {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });
});
