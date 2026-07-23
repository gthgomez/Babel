/**
 * Diff critic unit tests + A09-class acceptance fixtures.
 *
 * A09 (pytest-dev__pytest-10051): agent made LogCaptureHandler.reset use
 * records.clear() — local pytest green, gold wants a new clear() method and
 * LogCaptureFixture.clear → handler.clear(). Critic must REJECT the wrong
 * patch when a deterministic mock models the correct judgment.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import {
  buildDiffCriticPrompt,
  buildDiffCriticRejectionMessage,
  collectWorkspacePatch,
  applyCriticConfidenceThreshold,
  applyVerifierSupersedesCriticPass,
  computeSymbolCoverage,
  decideDiffCriticGate,
  extractIssueApiSymbols,
  heuristicLocalizationReject,
  heuristicSymbolCoverageReject,
  heuristicTestOnlyPatchReject,
  isDiffCriticEnabled,
  parseDiffCriticVerdict,
  runDiffCritic,
  runHeuristicDiffCritic,
  shouldEscalateCriticToPro,
  SWE_DIFF_CRITIC_PASS_CONFIDENCE_THRESHOLD,
  toCriticReceipt,
  type DiffCriticInput,
} from './diffCritic.js';

// ─── A09-class fixtures (from live T1.4 evidence + SWE gold) ──────────────

/** Problem statement excerpt for pytest-10051. */
export const A09_TASK = `caplog.get_records and caplog.clear conflict
# Description

\`caplog.get_records()\` gets decoupled from actual caplog records when \`caplog.clear()\` is called. As a result, after \`caplog.clear()\` is called, \`caplog.get_records()\` is frozen: it does not get cleared, nor does it get new records.

During test set up it is set to the same list as \`caplog.records\`, but the latter gets replaced rather than cleared in \`caplog.clear()\`, which diverges the two objects.

# Reproductive example
\`\`\`python
import logging

def test(caplog) -> None:
    def verify_consistency() -> None:
        assert caplog.get_records("call") == caplog.records

    verify_consistency()
    logging.warning("test")
    verify_consistency()
    caplog.clear()
    verify_consistency()  # fails: assert [<LogRecord: ...>] == []
\`\`\`
`;

/** Actual agent patch from runs/agent-benchmark-t1.4/SWE-A09-preds.jsonl — WRONG. */
export const A09_WRONG_PATCH = `diff --git a/src/_pytest/logging.py b/src/_pytest/logging.py
index a4f4214b1..b60465cb4 100644
--- a/src/_pytest/logging.py
+++ b/src/_pytest/logging.py
@@ -342,7 +342,7 @@ class LogCaptureHandler(logging_StreamHandler):
         super().emit(record)

     def reset(self) -> None:
-        self.records = []
+        self.records.clear()
         self.stream = StringIO()

     def handleError(self, record: logging.LogRecord) -> None:
`;

/** Gold-direction patch: add clear() and route fixture clear → handler.clear(). */
export const A09_GOLDISH_PATCH = `diff --git a/src/_pytest/logging.py b/src/_pytest/logging.py
--- a/src/_pytest/logging.py
+++ b/src/_pytest/logging.py
@@ -345,6 +345,10 @@ def reset(self) -> None:
         self.records = []
         self.stream = StringIO()

+    def clear(self) -> None:
+        self.records.clear()
+        self.stream = StringIO()
+
     def handleError(self, record: logging.LogRecord) -> None:
         if logging.raiseExceptions:
             # Fail the test if the log message is bad (emit failed).
@@ -440,7 +444,7 @@ def messages(self) -> List[str]:

     def clear(self) -> None:
         """Reset the list of log records and the captured log text."""
-        self.handler.reset()
+        self.handler.clear()

     def set_level(self, level: Union[int, str], logger: Optional[str] = None) -> None:
         """Set the level of a logger for the duration of a test.
`;

/**
 * Live A09 false-pass class (2026-07-09): adds clear() but fixture still calls
 * reset() and only rewrites stash — never routes to handler.clear().
 */
export const A09_INCOMPLETE_CLEAR_PATCH = `diff --git a/src/_pytest/logging.py b/src/_pytest/logging.py
--- a/src/_pytest/logging.py
+++ b/src/_pytest/logging.py
@@ -345,6 +345,10 @@ class LogCaptureHandler(logging_StreamHandler):
         self.records = []
         self.stream = StringIO()

+    def clear(self) -> None:
+        self.records.clear()
+        self.stream = StringIO()
+
     def handleError(self, record: logging.LogRecord) -> None:
         if logging.raiseExceptions:
             # Fail the test if the log message is bad (emit failed).
@@ -441,6 +445,11 @@ class LogCaptureFixture:
     def clear(self) -> None:
         """Reset the list of log records and the captured log text."""
         self.handler.reset()
+        # Update the stash records dict to reference the new handler records list,
+        # otherwise get_records() returns a stale reference to the old list.
+        records_dict = self._item.stash[caplog_records_key]
+        for when in records_dict:
+            records_dict[when] = self.handler.records

     def set_level(self, level: Union[int, str], logger: Optional[str] = None) -> None:
         """Set the level of a logger for the duration of a test.
`;

const A09_VERIFIER_PASS = {
  command: 'python -m pytest testing/logging/test_fixture.py -v -x',
  exit_code: 0,
  summary: '1 passed in 0.12s',
};

// ─── Config ───────────────────────────────────────────────────────────────

describe('isDiffCriticEnabled', () => {
  test('honors explicit disable', () => {
    const prev = process.env['BABEL_DIFF_CRITIC'];
    const headless = process.env['BABEL_HEADLESS'];
    const ci = process.env['CI'];
    try {
      process.env['BABEL_DIFF_CRITIC'] = '0';
      process.env['BABEL_HEADLESS'] = '1';
      assert.equal(isDiffCriticEnabled(), false);
    } finally {
      restoreEnv('BABEL_DIFF_CRITIC', prev);
      restoreEnv('BABEL_HEADLESS', headless);
      restoreEnv('CI', ci);
    }
  });

  test('default on when headless', () => {
    const prev = process.env['BABEL_DIFF_CRITIC'];
    const headless = process.env['BABEL_HEADLESS'];
    const ci = process.env['CI'];
    try {
      delete process.env['BABEL_DIFF_CRITIC'];
      process.env['BABEL_HEADLESS'] = '1';
      delete process.env['CI'];
      assert.equal(isDiffCriticEnabled(), true);
    } finally {
      restoreEnv('BABEL_DIFF_CRITIC', prev);
      restoreEnv('BABEL_HEADLESS', headless);
      restoreEnv('CI', ci);
    }
  });

  test('default off without headless/CI unless forced', () => {
    const prev = process.env['BABEL_DIFF_CRITIC'];
    const headless = process.env['BABEL_HEADLESS'];
    const ci = process.env['CI'];
    try {
      delete process.env['BABEL_DIFF_CRITIC'];
      delete process.env['BABEL_HEADLESS'];
      delete process.env['CI'];
      assert.equal(isDiffCriticEnabled(), false);
      process.env['BABEL_DIFF_CRITIC'] = '1';
      assert.equal(isDiffCriticEnabled(), true);
    } finally {
      restoreEnv('BABEL_DIFF_CRITIC', prev);
      restoreEnv('BABEL_HEADLESS', headless);
      restoreEnv('CI', ci);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ─── Parse ────────────────────────────────────────────────────────────────

describe('parseDiffCriticVerdict', () => {
  test('parses pass JSON', () => {
    const v = parseDiffCriticVerdict(
      '{"verdict":"pass","confidence":0.9,"reasons":["matches root cause"]}',
    );
    assert.equal(v.verdict, 'pass');
    assert.equal(v.confidence, 0.9);
    assert.deepEqual(v.reasons, ['matches root cause']);
  });

  test('parses approved + string confidence aliases', () => {
    const v = parseDiffCriticVerdict(
      '{"verdict":"approved","confidence":"medium","reasons":["ok"]}',
    );
    assert.equal(v.verdict, 'pass');
    assert.equal(v.confidence, 0.55);
  });

  test('parses reject JSON with fences', () => {
    const v = parseDiffCriticVerdict(
      '```json\n{"verdict":"reject","confidence":0.85,"reasons":["wrong method"]}\n```',
    );
    assert.equal(v.verdict, 'reject');
    assert.equal(v.reasons[0], 'wrong method');
  });

  test('empty → skip (fail-open parse)', () => {
    const v = parseDiffCriticVerdict('');
    assert.equal(v.verdict, 'skip');
    assert.equal(v.skippedReason, 'empty_response');
  });

  test('garbage → skip', () => {
    const v = parseDiffCriticVerdict('I think it looks fine overall.');
    assert.equal(v.verdict, 'skip');
  });
});

// ─── Prompt ───────────────────────────────────────────────────────────────

describe('buildDiffCriticPrompt', () => {
  test('includes task, patch, and local-verifier warning', () => {
    const prompt = buildDiffCriticPrompt({
      task: A09_TASK,
      patch: A09_WRONG_PATCH,
      verifierReceipt: A09_VERIFIER_PASS,
    });
    assert.match(prompt, /caplog\.clear/);
    assert.match(prompt, /self\.records\.clear\(\)/);
    assert.match(prompt, /exit_code: 0/);
    assert.match(prompt, /A09-class incorrect_patch/);
    assert.match(prompt, /"verdict":"pass"\|"reject"/);
  });
});

// ─── Rejection message ────────────────────────────────────────────────────

describe('buildDiffCriticRejectionMessage', () => {
  test('lists reasons and forbids completion', () => {
    const msg = buildDiffCriticRejectionMessage({
      verdict: 'reject',
      reasons: ['edited reset() instead of adding clear()'],
      confidence: 0.9,
    });
    assert.match(msg, /DIFF CRITIC REJECTED/);
    assert.match(msg, /edited reset/);
    assert.match(msg, /Do NOT claim complete/);
  });

  // P2.3 golden: critic reject → user-facing message must carry each reason
  test('golden: reject injects every reason into the user repair message', () => {
    const reasons = [
      'wrong localization: patched reset() instead of clear()',
      'symbol coverage: issue requires clear() API',
    ];
    const msg = buildDiffCriticRejectionMessage({
      verdict: 'reject',
      reasons,
      confidence: 0.88,
    });
    assert.match(msg, /DIFF CRITIC REJECTED/);
    for (const reason of reasons) {
      assert.match(msg, new RegExp(reason.replace(/[()]/g, '\\$&')));
    }
    assert.match(msg, /1\.\s+wrong localization/);
    assert.match(msg, /2\.\s+symbol coverage/);
    assert.match(msg, /Re-read the task root cause/);
    assert.match(msg, /re-run the\s+verifier/i);
  });
});

// ─── Gate policy (hard-block, no soft-allow) ──────────────────────────────

describe('decideDiffCriticGate', () => {
  const MAX = 2;

  test('pass allows and resets strikes', () => {
    const g = decideDiffCriticGate('pass', 2, MAX);
    assert.equal(g.decision, 'allow');
    assert.equal(g.strikesAfter, 0);
  });

  test('skip allows fail-open without resetting strikes', () => {
    const g = decideDiffCriticGate('skip', 1, MAX);
    assert.equal(g.decision, 'allow');
    assert.equal(g.strikesAfter, 1);
  });

  test('reject within budget forces re-mutate (reject)', () => {
    assert.equal(decideDiffCriticGate('reject', 0, MAX).decision, 'reject');
    assert.equal(decideDiffCriticGate('reject', 0, MAX).strikesAfter, 1);
    assert.equal(decideDiffCriticGate('reject', 1, MAX).decision, 'reject');
    assert.equal(decideDiffCriticGate('reject', 1, MAX).strikesAfter, 2);
  });

  test('reject past budget hard-blocks — never soft-allows', () => {
    const g = decideDiffCriticGate('reject', 2, MAX);
    assert.equal(g.decision, 'block');
    assert.equal(g.strikesAfter, 3);
    assert.match(g.reason ?? '', /hard-block after 3 critic strikes/);
  });

  test('terminal reject hard-blocks even on first strike', () => {
    const g = decideDiffCriticGate('reject', 0, MAX, { terminal: true });
    assert.equal(g.decision, 'block');
    assert.equal(g.strikesAfter, 1);
    assert.match(g.reason ?? '', /turn budget exhausted/);
  });
});

describe('verifier supersedes critic pass', () => {
  test('red local verifier demotes pass', () => {
    const v = applyVerifierSupersedesCriticPass(
      { verdict: 'pass', reasons: ['looks good'], confidence: 0.95 },
      {
        verifierReceipt: { command: 'pytest', exit_code: 1, summary: 'fail' },
        requireGreenVerifier: true,
      },
    );
    assert.equal(v.verdict, 'reject');
    assert.ok(v.reasons.some((r) => /exit_code=1/.test(r)));
  });

  test('missing receipt demotes pass when required', () => {
    const v = applyVerifierSupersedesCriticPass(
      { verdict: 'pass', reasons: ['ok'], confidence: 0.9 },
      { verifierReceipt: null, requireGreenVerifier: true },
    );
    assert.equal(v.verdict, 'reject');
  });

  test('green receipt keeps pass', () => {
    const v = applyVerifierSupersedesCriticPass(
      { verdict: 'pass', reasons: ['ok'], confidence: 0.9 },
      {
        verifierReceipt: { command: 'pytest', exit_code: 0, summary: 'ok' },
        requireGreenVerifier: true,
      },
    );
    assert.equal(v.verdict, 'pass');
  });
});

describe('confidence threshold + two-tier escalate', () => {
  test('pass below threshold becomes reject', () => {
    const v = applyCriticConfidenceThreshold(
      { verdict: 'pass', confidence: 0.4, reasons: ['maybe'] },
      0.6,
    );
    assert.equal(v.verdict, 'reject');
    assert.match(v.reasons.join(' '), /below pass threshold/);
  });

  test('pass at/above threshold stays pass', () => {
    const v = applyCriticConfidenceThreshold(
      { verdict: 'pass', confidence: 0.9, reasons: ['ok'] },
      0.6,
    );
    assert.equal(v.verdict, 'pass');
  });

  test('SWE tier escalates any flash pass to pro', () => {
    assert.equal(
      shouldEscalateCriticToPro(
        { verdict: 'pass', confidence: 0.95, reasons: [] },
        { sweTier: true },
      ),
      true,
    );
    assert.equal(
      shouldEscalateCriticToPro(
        { verdict: 'reject', confidence: 0.95, reasons: [] },
        { sweTier: true },
      ),
      false,
    );
  });

  test('two-tier: pro can override flash pass; receipt logs model+tier', async () => {
    let calls = 0;
    const verdict = await runDiffCritic(
      {
        task: 'fix foo.bar',
        patch: 'diff --git a/x.py\n+def bar():\n+  return 1\n',
        changedFiles: ['x.py'],
      },
      async () => {
        calls++;
        if (calls === 1) {
          return JSON.stringify({ verdict: 'pass', confidence: 0.9, reasons: ['flash ok'] });
        }
        return JSON.stringify({
          verdict: 'reject',
          confidence: 0.85,
          reasons: ['pro sees wrong API'],
        });
      },
      {
        skipHeuristic: true,
        sweTier: true,
        model: 'deepseek-v4-flash',
        proModel: 'deepseek-v4-pro',
        invokePro: async () =>
          JSON.stringify({
            verdict: 'reject',
            confidence: 0.85,
            reasons: ['pro sees wrong API'],
          }),
      },
    );
    assert.equal(verdict.verdict, 'reject');
    assert.equal(verdict.tier, 'pro');
    assert.equal(verdict.model, 'deepseek-v4-pro');
    const receipt = toCriticReceipt(verdict);
    assert.equal(receipt['tier'], 'pro');
    assert.equal(receipt['model'], 'deepseek-v4-pro');
  });

  test('SWE uses higher pass confidence threshold (0.75)', async () => {
    const verdict = await runDiffCritic(
      {
        task: 'fix foo',
        patch: 'diff --git a/x.py\n+def foo():\n+  return 1\n',
        changedFiles: ['x.py'],
      },
      async () =>
        JSON.stringify({
          verdict: 'pass',
          confidence: 0.6,
          reasons: ['borderline flash pass'],
        }),
      {
        skipHeuristic: true,
        sweTier: true,
        // force no pro escalate by... wait, SWE always escalates pass.
        // Provide pro that also returns 0.6 pass — both demoted.
        invokePro: async () =>
          JSON.stringify({
            verdict: 'pass',
            confidence: 0.6,
            reasons: ['pro also borderline'],
          }),
      },
    );
    assert.equal(verdict.verdict, 'reject');
    assert.ok(verdict.reasons.some((r) => /below pass threshold/i.test(r)));
    assert.ok(SWE_DIFF_CRITIC_PASS_CONFIDENCE_THRESHOLD >= 0.75);
  });

  test('SWE pro infra failure demotes flash pass (fail-closed) and surfaces error', async () => {
    let proAttempts = 0;
    const verdict = await runDiffCritic(
      {
        task: 'fix foo',
        patch: 'diff --git a/x.py\n+def foo():\n+  return 1\n',
        changedFiles: ['x.py'],
      },
      async () =>
        JSON.stringify({
          verdict: 'pass',
          confidence: 0.95,
          reasons: ['flash high confidence'],
        }),
      {
        skipHeuristic: true,
        sweTier: true,
        invokePro: async () => {
          proAttempts++;
          throw new Error('HTTP 429 rate limit');
        },
      },
    );
    assert.equal(verdict.verdict, 'reject');
    assert.equal(proAttempts, 2, 'pro should be retried once');
    assert.ok(verdict.reasons.some((r) => /HTTP 429/i.test(r)));
    assert.ok(verdict.reasons.some((r) => /pro escalate required|demoting flash/i.test(r)));
    assert.equal(verdict.skippedReason, 'pro_infra_error');
  });

  test('non-SWE pro infra failure fail-opens flash pass', async () => {
    const verdict = await runDiffCritic(
      {
        task: 'fix foo',
        patch: 'diff --git a/x.py\n+def foo():\n+  return 1\n',
        changedFiles: ['x.py'],
      },
      async () =>
        JSON.stringify({
          verdict: 'pass',
          confidence: 0.5, // low-margin → escalate even without sweTier
          reasons: ['flash ok'],
        }),
      {
        skipHeuristic: true,
        sweTier: false,
        confidenceThreshold: 0.6,
        invokePro: async () => {
          throw new Error('network down');
        },
      },
    );
    // low confidence still demoted by threshold; use higher conf for open path
    assert.ok(verdict.reasons.some((r) => /kept flash verdict|infra error/i.test(r)));
  });

  test('non-SWE high-conf flash kept when pro infra fails (after threshold)', async () => {
    // Force escalate with sweTier false by using confidence below thr+0.15
    // thr=0.5, conf=0.55 → escalate; then pro fails; conf 0.55 >= 0.5 → pass
    const verdict = await runDiffCritic(
      {
        task: 'fix foo',
        patch: 'diff --git a/x.py\n+def foo():\n+  return 1\n',
        changedFiles: ['x.py'],
      },
      async () =>
        JSON.stringify({
          verdict: 'pass',
          confidence: 0.55,
          reasons: ['flash ok'],
        }),
      {
        skipHeuristic: true,
        sweTier: false,
        confidenceThreshold: 0.5,
        invokePro: async () => {
          throw new Error('network down');
        },
      },
    );
    assert.equal(verdict.verdict, 'pass');
    assert.ok(verdict.reasons.some((r) => /kept flash verdict/i.test(r)));
  });
});

describe('symbol coverage + localization gate', () => {
  test('extracts issue API symbols from backticks and calls', () => {
    const syms = extractIssueApiSymbols(
      'caplog.clear() conflicts with get_records; also LogCaptureHandler.reset',
    );
    assert.ok(syms.some((s) => /clear/i.test(s)));
  });

  test('A09 wrong patch still rejected by combined heuristic', () => {
    const h = runHeuristicDiffCritic(A09_TASK, A09_WRONG_PATCH);
    assert.ok(h);
    assert.equal(h!.verdict, 'reject');
  });

  test('symbol coverage rejects when required APIs missing from patch adds', () => {
    const task =
      'Implement `widget.frobnicate` and call `handler.frobnicate` when done. Do not only touch `reset`.';
    const patch = [
      'diff --git a/src/x.py b/src/x.py',
      '--- a/src/x.py',
      '+++ b/src/x.py',
      '@@ -1,3 +1,3 @@',
      ' def reset(self):',
      '-    self.records = []',
      '+    self.records.clear()',
    ].join('\n');
    const score = computeSymbolCoverage(task, patch, {
      expectedApis: ['frobnicate', 'handler.frobnicate'],
    });
    assert.ok(score.required.length >= 1);
    assert.equal(score.coverage, 0);
    const rej = heuristicSymbolCoverageReject(task, patch, {
      expectedApis: ['frobnicate'],
    });
    assert.ok(rej);
    assert.equal(rej!.verdict, 'reject');
    assert.equal(rej!.tier, 'heuristic');
  });

  test('test-only patch with named APIs is rejected', () => {
    const task =
      'Fix `Symbol.__new__` to handle the extra kwarg in sympy.core.symbol.';
    const patch = [
      'diff --git a/sympy/core/tests/test_symbol.py b/sympy/core/tests/test_symbol.py',
      '--- a/sympy/core/tests/test_symbol.py',
      '+++ b/sympy/core/tests/test_symbol.py',
      '@@ -10,3 +10,5 @@',
      ' def test_new():',
      '+    s = Symbol("x", extra=None)',
      '+    assert s is not None',
    ].join('\n');
    const rej = heuristicTestOnlyPatchReject(task, patch);
    assert.ok(rej, 'test-only patch with named API should be rejected');
    assert.equal(rej!.verdict, 'reject');
    assert.match(rej!.reasons.join(' '), /test/i);
    assert.match(rej!.reasons.join(' '), /Symbol/i);
  });

  test('test-only patch with no strong APIs is not rejected', () => {
    const task = 'Fix the failing test in the repo.';
    const patch = [
      'diff --git a/tests/test_math.py b/tests/test_math.py',
      '--- a/tests/test_math.py',
      '+++ b/tests/test_math.py',
      '@@ -1,3 +1,3 @@',
      ' def test_add():',
      '-    assert add(1, 2) == 4',
      '+    assert add(1, 2) == 3',
    ].join('\n');
    const rej = heuristicTestOnlyPatchReject(task, patch);
    assert.equal(rej, null, 'no strong API → no test-only reject');
  });

  test('patch touching implementation file is not flagged test-only', () => {
    const task = 'Fix `Symbol.__new__` in sympy.core.symbol.';
    const patch = [
      'diff --git a/sympy/core/symbol.py b/sympy/core/symbol.py',
      '--- a/sympy/core/symbol.py',
      '+++ b/sympy/core/symbol.py',
      '@@ -50,3 +50,3 @@',
      ' class Symbol:',
      '-    def __new__(cls, name):',
      '+    def __new__(cls, name, **kwargs):',
    ].join('\n');
    const rej = heuristicTestOnlyPatchReject(task, patch);
    assert.equal(rej, null, 'implementation file touched → fine');
  });

  test('changedFiles param takes precedence over diff extraction', () => {
    const task = 'Fix `Symbol.__new__` in sympy.core.symbol.';
    // Diff mentions an impl file, but changedFiles says only test files
    const patch = [
      'diff --git a/sympy/core/symbol.py b/sympy/core/symbol.py',
      '--- a/sympy/core/symbol.py',
      '+++ b/sympy/core/symbol.py',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const rej = heuristicTestOnlyPatchReject(task, patch, [
      'sympy/core/tests/test_symbol.py',
    ]);
    assert.ok(rej, 'changedFiles param should be used for file detection');
  });
});

// ─── A09-class acceptance (mock critic) ───────────────────────────────────

describe('A09-class critic acceptance', () => {
  test('heuristic REJECTS wrong reset()→clear() localization without LLM', () => {
    const h = heuristicLocalizationReject(A09_TASK, A09_WRONG_PATCH);
    assert.ok(h, 'heuristic should fire on A09 wrong patch');
    assert.equal(h!.verdict, 'reject');
    assert.ok(h!.confidence >= 0.75);
    assert.ok(h!.reasons.some((r) => /clear|reset|localization/i.test(r)));
  });

  test('heuristic does NOT reject gold-direction clear() patch', () => {
    const h = heuristicLocalizationReject(A09_TASK, A09_GOLDISH_PATCH);
    assert.equal(h, null);
  });

  test('heuristic REJECTS incomplete clear() (adds method, still routes reset)', () => {
    const h = heuristicLocalizationReject(A09_TASK, A09_INCOMPLETE_CLEAR_PATCH);
    assert.ok(h, 'incomplete A09-class patch must be rejected without LLM');
    assert.equal(h!.verdict, 'reject');
    assert.ok(h!.reasons.some((r) => /handler\.clear|routes fixture/i.test(r)));
  });

  test('runDiffCritic uses heuristic reject before invoking LLM on A09 wrong patch', async () => {
    let invoked = false;
    const verdict = await runDiffCritic(
      {
        task: A09_TASK,
        patch: A09_WRONG_PATCH,
        verifierReceipt: A09_VERIFIER_PASS,
      },
      async () => {
        invoked = true;
        return JSON.stringify({ verdict: 'pass', confidence: 0.99, reasons: ['should not run'] });
      },
    );
    assert.equal(verdict.verdict, 'reject');
    assert.equal(invoked, false, 'LLM must not be called when heuristic rejects');
    assert.equal(verdict.model, 'heuristic-localization');
  });

  test('LLM path REJECTS wrong patch when heuristic skipped (prompt contract)', async () => {
    const input: DiffCriticInput = {
      task: A09_TASK,
      patch: A09_WRONG_PATCH,
      verifierReceipt: A09_VERIFIER_PASS,
      proposedAnswer: 'Fixed by clearing records in place in reset(). Tests pass.',
      changedFiles: ['src/_pytest/logging.py'],
    };

    // Deterministic mock that implements the intended critic judgment for A09.
    const verdict = await runDiffCritic(
      input,
      async (prompt) => {
        // Sanity: critic prompt must surface the wrong edit + green verifier.
        assert.match(prompt, /self\.records\.clear\(\)/);
        assert.match(prompt, /exit_code: 0/);
        assert.match(prompt, /caplog\.get_records and caplog\.clear/);
        assert.match(prompt, /reject-biased|When in doubt/i);
        return JSON.stringify({
          verdict: 'reject',
          confidence: 0.92,
          reasons: [
            'Patch edits LogCaptureHandler.reset() but the bug is about caplog.clear() decoupling get_records from records',
            'Gold direction requires a separate clear() that mutates the list in place and routes fixture clear() to it; reset() should keep replacing the list',
            'Local verifier exit 0 is insufficient — narrow test can pass on wrong localization',
          ],
        });
      },
      { model: 'mock-a09-critic', skipHeuristic: true },
    );

    assert.equal(verdict.verdict, 'reject', 'A09 wrong patch must be rejected');
    assert.ok(verdict.confidence >= 0.8);
    assert.ok(verdict.reasons.some((r) => /clear|reset|localization/i.test(r)));
    assert.equal(verdict.model, 'mock-a09-critic');

    const receipt = toCriticReceipt(verdict);
    assert.equal(receipt['verdict'], 'reject');
  });

  test('mock critic PASSES gold-direction clear() patch', async () => {
    const input: DiffCriticInput = {
      task: A09_TASK,
      patch: A09_GOLDISH_PATCH,
      verifierReceipt: A09_VERIFIER_PASS,
      proposedAnswer: 'Added LogCaptureHandler.clear() and routed fixture clear to it.',
      changedFiles: ['src/_pytest/logging.py'],
    };

    const verdict = await runDiffCritic(input, async (prompt) => {
      assert.match(prompt, /def clear\(self\)/);
      assert.match(prompt, /self\.handler\.clear\(\)/);
      return JSON.stringify({
        verdict: 'pass',
        confidence: 0.88,
        reasons: [
          'Adds clear() that mutates records in place so get_records stays coupled',
          'Fixture clear() now calls handler.clear() instead of reset()',
        ],
      });
    });

    assert.equal(verdict.verdict, 'pass');
    assert.ok(verdict.confidence >= 0.8);
  });

  test('empty patch rejects without calling model when no files', async () => {
    let called = false;
    const verdict = await runDiffCritic(
      { task: A09_TASK, patch: '', changedFiles: [] },
      async () => {
        called = true;
        return '{}';
      },
    );
    assert.equal(verdict.verdict, 'reject');
    assert.equal(called, false);
  });
});

// ─── collectWorkspacePatch ────────────────────────────────────────────────

describe('collectWorkspacePatch', () => {
  test('returns git diff from a temp repo with a mutation', () => {
    const root = join(tmpdir(), `babel-critic-${randomBytes(4).toString('hex')}`);
    mkdirSync(root, { recursive: true });
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@est',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@est',
    };
    try {
      assert.equal(spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' }).status, 0);
      writeFileSync(join(root, 'a.txt'), 'hello\n', 'utf8');
      assert.equal(
        spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8', env: gitEnv }).status,
        0,
      );
      assert.equal(
        spawnSync('git', ['commit', '-m', 'init'], { cwd: root, encoding: 'utf8', env: gitEnv })
          .status,
        0,
      );
      writeFileSync(join(root, 'a.txt'), 'hello world\n', 'utf8');

      const collected = collectWorkspacePatch(root);
      assert.equal(collected.source, 'git');
      assert.match(collected.text, /hello world/);
      assert.ok(collected.files.some((f) => f.includes('a.txt')));
    } finally {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back to tool_log when git has no diff', () => {
    const root = join(tmpdir(), `babel-critic-fb-${randomBytes(4).toString('hex')}`);
    mkdirSync(root, { recursive: true });
    try {
      writeFileSync(join(root, 'x.ts'), 'export const x = 1;\n', 'utf8');
      const collected = collectWorkspacePatch(root, {
        mutationTargets: [join(root, 'x.ts')],
      });
      // No git repo → empty git, fallback to tool log
      assert.equal(collected.source, 'tool_log');
      assert.match(collected.text, /export const x/);
    } finally {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });
});
