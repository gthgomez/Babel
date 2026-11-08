import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildRecoveryAssessment } from './recovery.js';
import { readCheckpoint, restoreCheckpoint } from './checkpoints.js';
import { usageSummaryFromCostLedger } from './costLedger.js';
import {
  classifySmallFixProviderFailure,
  detectSmallFix,
  resolveSmallFixProvider,
  runSmallFixPath,
  SmallFixRecoverableError,
} from './smallFix.js';
import { readLiteTrustDemoFixture, resolveLiteTrustDemoFixturePath } from './liteTrustDemo.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env['DEEPINFRA_API_KEY'];
const originalDeepSeekApiKey = process.env['DEEPSEEK_API_KEY'];
const originalOpenRouterApiKey = process.env['OPENROUTER_API_KEY'];
const originalProjectRoot = process.env['BABEL_PROJECT_ROOT'];
const originalHostFallback = process.env['BABEL_ALLOW_HOST_FALLBACK'];

test.beforeEach(() => {
  // These tests execute disposable temporary projects on the host. Production
  // remains fail-closed; the fixture boundary is explicitly authorized here.
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  process.env['OPENROUTER_API_KEY'] = 'sk-test-router-key';
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env['DEEPINFRA_API_KEY'];
  } else {
    process.env['DEEPINFRA_API_KEY'] = originalApiKey;
  }
  if (originalDeepSeekApiKey === undefined) {
    delete process.env['DEEPSEEK_API_KEY'];
  } else {
    process.env['DEEPSEEK_API_KEY'] = originalDeepSeekApiKey;
  }
  if (originalOpenRouterApiKey === undefined) {
    delete process.env['OPENROUTER_API_KEY'];
  } else {
    process.env['OPENROUTER_API_KEY'] = originalOpenRouterApiKey;
  }
  if (originalProjectRoot === undefined) {
    delete process.env['BABEL_PROJECT_ROOT'];
  } else {
    process.env['BABEL_PROJECT_ROOT'] = originalProjectRoot;
  }
  if (originalHostFallback === undefined) {
    delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
  } else {
    process.env['BABEL_ALLOW_HOST_FALLBACK'] = originalHostFallback;
  }
});

function writeNodeFixture(root: string, implementation: string): void {
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        type: 'module',
        scripts: { test: 'node src/math.test.js' },
      },
      null,
      2,
    ),
    'utf-8',
  );
  writeFileSync(join(root, 'src', 'math.js'), implementation, 'utf-8');
  writeFileSync(
    join(root, 'src', 'math.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from './math.js';",
      '',
      "test('add sums two numbers', () => {",
      '  assert.equal(add(1, 2), 3);',
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function mockSmallFixResponse(replacementContent: string): void {
  process.env['OPENROUTER_API_KEY'] = 'sk-test-router-key';
  // Synthetic provider tests still execute the disposable fixture on the
  // host when Docker is unavailable; make that boundary explicit.
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1';
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    // The live policy certifies exact-route responses only: echo the model
    // identity the runner actually sent (validateObservedModelId rejects
    // substitution), so the fixture stays correct across policy re-routes.
    let sentModel = 'deepseek/deepseek-v4-flash-0731';
    try {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (body && typeof body.model === 'string') sentModel = body.model;
    } catch {
      /* keep fallback identity */
    }
    return new Response(
      JSON.stringify({
        model: sentModel,
        choices: [
          {
            message: {
              content: JSON.stringify({
                schema_version: 1,
                summary: 'Updated math implementation.',
                replacement_content: replacementContent,
                confidence: 'high',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

test('small-fix detection accepts explicit one-file local test repairs', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'math.js'), 'export const add = () => 0;\n', 'utf-8');

    const detected = detectSmallFix({
      projectRoot: root,
      task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
    });

    assert.ok(detected);
    assert.equal(detected.mode, 'single');
    if (detected.mode === 'single') {
      assert.equal(detected.targetFile, 'src/math.js');
      assert.equal(detected.verifierCommand, 'npm test');
      assert.equal(detected.projectRoot, root);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('small-fix detection infers one-file failing test repairs from local context', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-'));
  try {
    writeNodeFixture(root, 'export const add = () => 0;\n');

    const detected = detectSmallFix({
      projectRoot: root,
      task: 'fix the failing math test',
    });

    assert.ok(detected);
    assert.equal(detected.mode, 'single');
    if (detected.mode === 'single') {
      assert.equal(detected.targetFile, 'src/math.js');
      assert.equal(detected.verifierCommand, 'npm test');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('small-fix detection accepts plural "fix failing tests" wording', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-'));
  try {
    writeNodeFixture(root, 'export const add = () => 0;\n');

    const detected = detectSmallFix({
      projectRoot: root,
      task: 'fix failing tests',
    });

    assert.ok(detected);
    assert.equal(detected.mode, 'single');
    if (detected.mode === 'single') {
      assert.equal(detected.targetFile, 'src/math.js');
      assert.equal(detected.verifierCommand, 'npm test');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('small-fix coordinated multi-file scope runs coordinated pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-multi-path-'));
  mockSmallFixResponse('export const value = 1;\n');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
      'utf-8',
    );
    writeFileSync(join(root, 'src', 'a.js'), 'export const value = 0;\n', 'utf-8');
    writeFileSync(join(root, 'src', 'b.js'), 'export const value = 0;\n', 'utf-8');
    process.env['BABEL_PROJECT_ROOT'] = root;

    const result = await runSmallFixPath({
      projectRoot: root,
      task: 'Only edit src/a.js and src/b.js. Run npm test before completing.',
      provider: 'live',
      model: 'deepseek',
      modelTier: 'standard',
    });

    assert.equal(result.status, 'SMALL_FIX_COMPLETE');
    if (result.status === 'SMALL_FIX_COMPLETE') {
      assert.equal(result.targetFile, 'src/a.js');
      assert.deepEqual(result.changedFiles, ['src/a.js', 'src/b.js']);
      const report = JSON.parse(readFileSync(join(result.runDir, '04_execution_report.json'), 'utf8'));
      assert.deepEqual(report.tool_call_log.map((entry: { tool: string }) => entry.tool), ['file_write', 'file_write', 'test_run']);
      assert.equal(report.tool_call_log[2].exit_code, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('coordinated model authentication failure retains both original files and stops inference', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-coordinated-auth-failure-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    writeFileSync(join(root, 'src', 'a.js'), 'original a\n');
    writeFileSync(join(root, 'src', 'b.js'), 'original b\n');
    process.env['BABEL_PROJECT_ROOT'] = root;
    mockSmallFixResponse('proposed change\n');
    const firstResponse = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      if (calls === 1) return firstResponse(...args);
      return new Response(JSON.stringify({ error: { message: 'synthetic unauthorized' } }), { status: 401 });
    }) as typeof fetch;
    await assert.rejects(runSmallFixPath({
      projectRoot: root, task: 'Only edit src/a.js and src/b.js. Run npm test before completing.',
      provider: 'live', model: 'deepseek', modelTier: 'standard',
    }));
    assert.equal(calls, 2);
    assert.equal(readFileSync(join(root, 'src', 'a.js'), 'utf8'), 'original a\n');
    assert.equal(readFileSync(join(root, 'src', 'b.js'), 'utf8'), 'original b\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('coordinated cancellation at verifier dispatch retains changes and prevents verifier execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-coordinated-cancel-verify-'));
  const controller = new AbortController();
  let runDir = '';
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'verifier-marker\',\'ran\')"' } }));
    writeFileSync(join(root, 'src', 'a.js'), 'original a\n');
    writeFileSync(join(root, 'src', 'b.js'), 'original b\n');
    process.env['BABEL_PROJECT_ROOT'] = root;
    mockSmallFixResponse('proposed change\n');
    const result = await runSmallFixPath({
      projectRoot: root, task: 'Only edit src/a.js and src/b.js. Run npm test before completing.',
      provider: 'live', model: 'deepseek', modelTier: 'standard', signal: controller.signal,
      progress: { bindRunDir: dir => { runDir = dir; }, report: (stage, detail) => {
        if (stage === 'verify' && detail?.startsWith('Dispatching')) controller.abort();
      }, finish: () => {}, getTranscript: () => [], getProgressSteps: () => [] },
    });
    assert.equal(result.status, 'SMALL_FIX_FAILED');
    if (result.status === 'SMALL_FIX_FAILED') {
      assert.equal(result.cancelled, true);
      assert.equal(result.retryable, false);
      assert.deepEqual(result.changedFiles, ['src/a.js', 'src/b.js']);
    }
    assert.equal(existsSync(join(root, 'verifier-marker')), false);
    const terminal = JSON.parse(readFileSync(join(runDir, 'terminal_status_summary.json'), 'utf8'));
    assert.equal(terminal.reason_category, 'cancelled');
    assert.equal(terminal.verifier_contract.verifierCompletionSatisfied, false);
    const timeline = JSON.parse(readFileSync(join(runDir, 'repair_attempt_timeline.json'), 'utf8'));
    assert.equal(timeline.attempts[0].verifier_exit_code, null);
    const capsule = JSON.parse(readFileSync(join(runDir, 'small_fix_failure_capsule.json'), 'utf8'));
    assert.equal(capsule.retryable, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('coordinated fix reports missing required verification instead of success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-coordinated-verifier-contract-'));
  let runDir = '';
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"', typecheck: 'node -e "process.exit(0)"' } }));
    writeFileSync(join(root, 'src', 'a.js'), 'original a\n');
    writeFileSync(join(root, 'src', 'b.js'), 'original b\n');
    process.env['BABEL_PROJECT_ROOT'] = root;
    mockSmallFixResponse('proposed change\n');
    const result = await runSmallFixPath({
      projectRoot: root, task: 'Only edit src/a.js and src/b.js. Verifier commands: npm run typecheck && npm test.',
      provider: 'live', model: 'deepseek', modelTier: 'standard',
      progress: { bindRunDir: dir => { runDir = dir; }, report: () => {}, finish: () => {}, getTranscript: () => [], getProgressSteps: () => [] },
    });
    assert.equal(result.status, 'SMALL_FIX_FAILED');
    const terminal = JSON.parse(readFileSync(join(runDir, 'terminal_status_summary.json'), 'utf8'));
    assert.equal(terminal.reason_category, 'verifier_contract');
    assert.equal(terminal.failed_command, null);
    assert.deepEqual(terminal.verifier_contract.missingRequiredVerifiers, ['npm run typecheck']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('coordinated verifier isolation denial retains changes without running the verifier', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-coordinated-verifier-deny-'));
  let runDir = '';
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'verifier-marker\',\'ran\')"' } }));
    writeFileSync(join(root, 'src', 'a.js'), 'original a\n');
    writeFileSync(join(root, 'src', 'b.js'), 'original b\n');
    process.env['BABEL_PROJECT_ROOT'] = root;
    mockSmallFixResponse('proposed change\n');
    delete process.env['BABEL_ALLOW_HOST_FALLBACK'];
    const result = await runSmallFixPath({
      projectRoot: root, task: 'Only edit src/a.js and src/b.js. Run npm test before completing.',
      provider: 'live', model: 'deepseek', modelTier: 'standard',
      progress: { bindRunDir: dir => { runDir = dir; }, report: () => {}, finish: () => {}, getTranscript: () => [], getProgressSteps: () => [] },
    });
    assert.equal(result.status, 'SMALL_FIX_FAILED');
    if (result.status === 'SMALL_FIX_FAILED') {
      assert.equal(result.retryable, false);
      assert.deepEqual(result.changedFiles, ['src/a.js', 'src/b.js']);
    }
    assert.equal(existsSync(join(root, 'verifier-marker')), false);
    const terminal = JSON.parse(readFileSync(join(runDir, 'terminal_status_summary.json'), 'utf8'));
    assert.equal(terminal.verifier_contract.verifierCompletionSatisfied, false);
    const report = JSON.parse(readFileSync(join(runDir, '04_execution_report.json'), 'utf8'));
    assert.equal(report.steps_executed, 2);
    assert.equal(report.tool_call_log.at(-1).policy_blocked, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('coordinated repair authentication failure retains the earlier changes without replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-coordinated-repair-auth-'));
  let calls = 0;
  let runDir = '';
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }));
    writeFileSync(join(root, 'src', 'a.js'), 'original a\n');
    writeFileSync(join(root, 'src', 'b.js'), 'original b\n');
    process.env['BABEL_PROJECT_ROOT'] = root;
    mockSmallFixResponse('proposed change\n');
    const successfulResponse = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      if (calls <= 2) return successfulResponse(...args);
      return new Response(JSON.stringify({ error: { message: 'synthetic unauthorized' } }), { status: 401 });
    }) as typeof fetch;
    const result = await runSmallFixPath({
      projectRoot: root, task: 'Only edit src/a.js and src/b.js. Run npm test before completing.',
      provider: 'live', model: 'deepseek', modelTier: 'standard', maxRepairAttempts: 2,
      progress: { bindRunDir: dir => { runDir = dir; }, report: () => {}, finish: () => {}, getTranscript: () => [], getProgressSteps: () => [] },
    });
    assert.equal(calls, 3);
    assert.equal(result.status, 'SMALL_FIX_FAILED');
    if (result.status === 'SMALL_FIX_FAILED') {
      assert.equal(result.retryable, false);
      assert.deepEqual(result.changedFiles, ['src/a.js', 'src/b.js']);
    }
    assert.equal(readFileSync(join(root, 'src', 'a.js'), 'utf8'), 'proposed change\n');
    assert.equal(readFileSync(join(root, 'src', 'b.js'), 'utf8'), 'proposed change\n');
    const capsule = JSON.parse(readFileSync(join(runDir, 'small_fix_failure_capsule.json'), 'utf8'));
    assert.equal(capsule.retryable, false);
    assert.equal(capsule.failure_code, 'provider_authentication_failed');
    const timeline = JSON.parse(readFileSync(join(runDir, 'repair_attempt_timeline.json'), 'utf8'));
    assert.equal(timeline.attempts[1].status, 'failed');
    assert.equal(timeline.attempts[1].verifier_exit_code, null);
    const terminal = JSON.parse(readFileSync(join(runDir, 'terminal_status_summary.json'), 'utf8'));
    assert.deepEqual(terminal.changed_files, ['src/a.js', 'src/b.js']);
    assert.equal(terminal.verifier_contract.verifierCompletionSatisfied, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('fatal model authentication failure is nonretryable in the retained small-fix capsule', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-auth-failure-'));
  let calls = 0;
  let runDir = '';
  try {
    writeNodeFixture(root, 'export const add = () => 0;\n');
    process.env['BABEL_PROJECT_ROOT'] = root;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'synthetic unauthorized' } }), { status: 401 });
    }) as typeof fetch;
    await assert.rejects(runSmallFixPath({
      projectRoot: root, task: 'Only edit src/math.js. Run npm test before completing.',
      provider: 'live', model: 'deepseek', modelTier: 'standard',
      progress: { bindRunDir: dir => { runDir = dir; }, report: () => {}, finish: () => {}, getTranscript: () => [], getProgressSteps: () => [] },
    }));
    assert.equal(calls, 1);
    const capsule = JSON.parse(readFileSync(join(runDir, 'small_fix_failure_capsule.json'), 'utf8'));
    assert.equal(capsule.failure_code, 'provider_authentication_failed');
    assert.equal(capsule.retryable, false);
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf8'), 'export const add = () => 0;\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a model response arriving after cancellation cannot start a small-fix write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-cancel-model-'));
  const controller = new AbortController();
  try {
    writeNodeFixture(root, 'export const add = () => 0;\n');
    process.env['BABEL_PROJECT_ROOT'] = root;
    mockSmallFixResponse('export const add = (a, b) => a + b;\n');
    const respond = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const response = await respond(...args);
      const body = await response.json() as Record<string, unknown>;
      delete body['usage'];
      controller.abort();
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    let stopped: unknown;
    try {
      await runSmallFixPath({
        projectRoot: root, task: 'Only edit src/math.js. Run npm test before completing.',
        provider: 'live', model: 'deepseek', modelTier: 'standard', signal: controller.signal,
      });
    } catch (error) { stopped = error; }
    assert.equal(controller.signal.aborted, true, 'synthetic provider response must arrive');
    assert.ok(stopped instanceof SmallFixRecoverableError);
    assert.equal(stopped.failureCode, 'cancelled');
    const summary = JSON.parse(readFileSync(join(stopped.runDir, 'terminal_status_summary.json'), 'utf8'));
    assert.equal(summary.reason_category, 'cancelled');
    assert.deepEqual(summary.changed_files, []);
    const capsule = JSON.parse(readFileSync(join(stopped.runDir, 'small_fix_failure_capsule.json'), 'utf8'));
    assert.equal(capsule.retryable, false);
    const ledger = JSON.parse(readFileSync(join(stopped.runDir, 'cost_ledger.json'), 'utf8'));
    assert.ok(ledger.entries.length > 0, 'dispatched inference must retain a cost entry');
    const usage = usageSummaryFromCostLedger(ledger);
    assert.ok((usage.unknownChargeCount ?? 0) > 0);
    assert.equal(usage.completeCostUSD, null);
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf8'), 'export const add = () => 0;\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a pre-cancelled small fix never starts inference or a write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-pre-cancel-'));
  const controller = new AbortController(); controller.abort({ kind: 'cancelled' });
  let calls = 0;
  try {
    writeNodeFixture(root, 'export const add = () => 0;\n');
    process.env['BABEL_PROJECT_ROOT'] = root;
    globalThis.fetch = (async () => { calls++; throw new Error('Unexpected inference'); }) as typeof fetch;
    let stopped: unknown;
    try {
      await runSmallFixPath({ projectRoot: root, task: 'Only edit src/math.js. Run npm test before completing.', provider: 'live', model: 'deepseek', modelTier: 'standard', signal: controller.signal });
    } catch (error) { stopped = error; }
    assert.ok(stopped instanceof Error);
    assert.equal(stopped.name, 'AbortError');
    assert.equal(calls, 0);
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf8'), 'export const add = () => 0;\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cancellation at verifier dispatch retains the completed write and incomplete verification evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-cancel-verify-'));
  const controller = new AbortController();
  let runDir = '';
  try {
    writeNodeFixture(root, 'export const add = () => 0;\n');
    process.env['BABEL_PROJECT_ROOT'] = root;
    mockSmallFixResponse('export const add = (a, b) => a + b;\n');
    const result = await runSmallFixPath({
      projectRoot: root, task: 'Only edit src/math.js. Run npm test before completing.',
      provider: 'live', model: 'deepseek', modelTier: 'standard', signal: controller.signal,
      progress: {
        bindRunDir: dir => { runDir = dir; },
        report: (stage, detail) => { if (stage === 'verify' && detail?.startsWith('Dispatching')) controller.abort(); },
        finish: () => {}, getTranscript: () => [], getProgressSteps: () => [],
      },
    });
    assert.equal(controller.signal.aborted, true);
    assert.equal(result.status, 'SMALL_FIX_FAILED');
    assert.deepEqual(result.changedFiles, ['src/math.js']);
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
    const summary = JSON.parse(readFileSync(join(runDir, 'terminal_status_summary.json'), 'utf8'));
    assert.equal(summary.reason_category, 'cancelled');
    assert.deepEqual(summary.changed_files, ['src/math.js']);
    assert.equal(summary.verifier_contract.verifierCompletionSatisfied, false);
    const capsule = JSON.parse(readFileSync(join(runDir, 'small_fix_failure_capsule.json'), 'utf8'));
    assert.equal(capsule.retryable, false);
    assert.equal(capsule.failure_code, 'cancelled');
    const timeline = JSON.parse(readFileSync(join(runDir, 'repair_attempt_timeline.json'), 'utf8'));
    assert.equal(timeline.attempts[0].status, 'cancelled');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('coordinated fix refuses a linked target before inference or mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-multi-admission-'));
  const outside = mkdtempSync(join(tmpdir(), 'babel-small-fix-multi-outside-'));
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error('Unexpected inference'); }) as typeof fetch;
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    writeFileSync(join(root, 'src', 'a.js'), 'original a\n');
    writeFileSync(join(outside, 'b.js'), 'SYNTHETIC_OUTSIDE_TARGET\n');
    symlinkSync(join(outside, 'b.js'), join(root, 'src', 'b.js'), process.platform === 'win32' ? 'file' : 'file');
    process.env['BABEL_PROJECT_ROOT'] = root;
    await assert.rejects(runSmallFixPath({
      projectRoot: root,
      task: 'Only edit src/a.js and src/b.js. Run npm test before completing.',
      provider: 'live',
      model: 'deepseek',
      modelTier: 'standard',
    }), /unsafe|unavailable|outside/i);
    assert.equal(calls, 0);
    assert.equal(readFileSync(join(root, 'src', 'a.js'), 'utf-8'), 'original a\n');
    assert.equal(readFileSync(join(outside, 'b.js'), 'utf-8'), 'SYNTHETIC_OUTSIDE_TARGET\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('small-fix does not send a junction target outside the project to the provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-junction-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'babel-small-fix-junction-outside-'));
  const canary = 'SYNTHETIC_OUTSIDE_SMALL_FIX_CANARY';
  let captured = '';
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    writeFileSync(join(outside, 'a.js'), canary);
    symlinkSync(outside, join(root, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    globalThis.fetch = (async (_input, init) => {
      captured += String(init?.body ?? '');
      throw new Error('Synthetic provider stopped');
    }) as typeof fetch;
    process.env['BABEL_PROJECT_ROOT'] = root;
    await assert.rejects(
      runSmallFixPath({ projectRoot: root, task: 'Only edit src/a.js. Run npm test before completing.', provider: 'live', model: 'deepseek', modelTier: 'standard' }),
      /Small-fix target is unsafe or unavailable/,
    );
    assert.equal(captured.includes(canary), false, 'outside-project bytes reached the provider request');
    assert.equal(captured, '', 'unsafe target must be rejected before inference');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('small-fix omits hard-linked supplemental files from actual provider requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-links-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'babel-small-fix-links-outside-'));
  const canary = 'SYNTHETIC_SUPPLEMENTAL_HARDLINK_CANARY';
  let captured = '';
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1;\n');
    writeFileSync(join(outside, 'test.js'), canary);
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ canary, scripts: { test: 'node -e "process.exit(0)"' } }));
    linkSync(join(outside, 'test.js'), join(root, 'src', 'a.test.js'));
    linkSync(join(outside, 'package.json'), join(root, 'package.json'));
    globalThis.fetch = (async (_input, init) => {
      captured += String(init?.body ?? '');
      throw new Error('Synthetic provider stopped');
    }) as typeof fetch;
    process.env['BABEL_PROJECT_ROOT'] = root;
    await runSmallFixPath({ projectRoot: root, task: 'Only edit src/a.js. Run npm test before completing.', provider: 'live', model: 'deepseek', modelTier: 'standard' }).catch(() => undefined);
    assert.notEqual(captured, '', 'positive control must reach the provider boundary');
    assert.equal(captured.includes(canary), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('small-fix detection accepts explicit dual-file scoped repairs', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-dual-'));
  try {
    mkdirSync(join(root, 'babel-cli', 'src', 'pipeline'), { recursive: true });
    mkdirSync(join(root, 'babel-cli', 'src', 'evidence'), { recursive: true });
    writeFileSync(
      join(root, 'babel-cli', 'src', 'pipeline', 'runPointers.ts'),
      'export {};\n',
      'utf-8',
    );
    writeFileSync(
      join(root, 'babel-cli', 'src', 'evidence', 'runEvidence.test.ts'),
      "import test from 'node:test';\n",
      'utf-8',
    );

    const detected = detectSmallFix({
      projectRoot: root,
      task: 'Edit babel-cli/src/pipeline/runPointers.ts and babel-cli/src/evidence/runEvidence.test.ts. Run npm --prefix ./babel-cli run typecheck before completing.',
    });

    assert.ok(detected);
    assert.equal(detected.mode, 'dual');
    if (detected.mode === 'dual') {
      assert.equal(detected.sourceFile, 'babel-cli/src/pipeline/runPointers.ts');
      assert.equal(detected.testFile, 'babel-cli/src/evidence/runEvidence.test.ts');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('small-fix detection declines ambiguous failing test repairs', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-'));
  try {
    writeNodeFixture(root, 'export const add = () => 0;\n');
    writeFileSync(
      join(root, 'src', 'strings.js'),
      'export const trim = (value) => value;\n',
      'utf-8',
    );
    writeFileSync(
      join(root, 'src', 'strings.test.js'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { trim } from './strings.js';",
        "test('trim removes spaces', () => assert.equal(trim(' x '), 'x'));",
      ].join('\n'),
      'utf-8',
    );

    assert.equal(
      detectSmallFix({
        projectRoot: root,
        task: 'fix the failing test',
      }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('small-fix detection rejects broad mutation and unsafe verifier commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'math.js'), 'export const add = () => 0;\n', 'utf-8');

    assert.equal(
      detectSmallFix({
        projectRoot: root,
        task: 'Fix the failing tests across the repo. Run npm test before completing.',
      }),
      null,
    );

    assert.equal(
      detectSmallFix({
        projectRoot: root,
        task: 'Only edit src/math.js. Run npm install before completing.',
      }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('classifySmallFixProviderFailure maps credential and network errors to recovery next steps', () => {
  const credential = classifySmallFixProviderFailure(
    new Error('[deepInfraApi] DEEPINFRA_API_KEY is not set.'),
  );
  assert.equal(credential.failureCode, 'credential_missing');
  assert.deepEqual(credential.next, ['babel-harness setup', 'babel-harness provider status']);

  const deepSeekCredential = classifySmallFixProviderFailure(
    new Error('[deepSeekApi] DEEPSEEK_API_KEY is not set.'),
  );
  assert.equal(deepSeekCredential.failureCode, 'credential_missing');
  assert.deepEqual(deepSeekCredential.next, ['babel-harness setup', 'babel-harness provider status']);

  const network = classifySmallFixProviderFailure(
    new Error('[deepInfraApi] Network error (model): fetch failed'),
  );
  assert.equal(network.failureCode, 'provider_network_failed');
  assert.deepEqual(network.next, ['Check connectivity to the selected endpoint', 'babel-harness provider status']);
});

test(
  'small-fix live path fails with structured recoverable error when OPENROUTER_API_KEY is missing',
  { concurrency: false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-credential-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      delete process.env['OPENROUTER_API_KEY'];

      await assert.rejects(
        () =>
          runSmallFixPath({
            projectRoot: root,
            task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
            provider: 'live',
            model: 'deepseek',
            modelTier: 'standard',
          }),
        (error: unknown) => {
          assert.ok(error instanceof SmallFixRecoverableError);
          assert.equal(error.failureCode, 'credential_missing');
          assert.equal(error.recoverable, true);
          assert.deepEqual(error.next, ['babel-harness setup', 'babel-harness provider status']);
          assert.ok(error.runDir.replace(/\\/g, '/').includes('runs/babel-lite'));
          assert.equal(existsSync(join(error.runDir, 'small_fix_failure_capsule.json')), true);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'small-fix live path surfaces network failures as recoverable provider errors',
  { concurrency: false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-network-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
      globalThis.fetch = (async () => {
        throw new Error('fetch failed');
      }) as typeof fetch;

      await assert.rejects(
        () =>
          runSmallFixPath({
            projectRoot: root,
            task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
            provider: 'live',
            model: 'deepseek',
            modelTier: 'standard',
          }),
        (error: unknown) => {
          assert.ok(error instanceof SmallFixRecoverableError);
          assert.equal(error.failureCode, 'provider_network_failed');
          assert.deepEqual(error.next, ['Check connectivity to the selected endpoint', 'babel-harness provider status']);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('resolveSmallFixProvider honors --provider mock and BABEL_LITE_OFFLINE', () => {
  assert.equal(resolveSmallFixProvider({ provider: 'mock' }), 'mock');
  assert.equal(resolveSmallFixProvider({ provider: 'live' }, { BABEL_LITE_OFFLINE: '1' }), 'live');
  assert.equal(resolveSmallFixProvider({}, { BABEL_LITE_OFFLINE: '1' }), 'mock');
  assert.equal(resolveSmallFixProvider({}, { BABEL_SMALL_FIX_PROVIDER: 'mock' }), 'mock');
  assert.equal(resolveSmallFixProvider({}), 'live');
});

test(
  'small-fix offline demo provider fixes trust fixture without network',
  { concurrency: false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-offline-'));
    const fixture = readLiteTrustDemoFixture(resolveLiteTrustDemoFixturePath());
    try {
      writeNodeFixture(root, fixture.broken_implementation);
      process.env['BABEL_PROJECT_ROOT'] = root;

      const result = await runSmallFixPath({
        projectRoot: root,
        task: fixture.task,
        provider: 'mock',
      });

      assert.equal(result.status, 'SMALL_FIX_COMPLETE', 'checks' in result ? result.checks.join('\n') : result.status);
      assert.equal(result.executionMode, 'offline_demo');
      assert.equal(
        readFileSync(join(root, 'src', 'math.js'), 'utf-8'),
        fixture.fixed_implementation,
      );
      assert.ok(result.checks.some((check) => check === 'npm test: passed'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'small-fix path writes one file and preserves verifier output',
  { concurrency: false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      mockSmallFixResponse('export const add = (a, b) => a + b;\n');

      const result = await runSmallFixPath({
        projectRoot: root,
        task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        model: 'deepseek',
        modelTier: 'standard',
      });

      assert.equal(result.status, 'SMALL_FIX_COMPLETE');
      assert.ok(result.runDir.replace(/\\/g, '/').includes('runs/babel-lite'));
      assert.equal(existsSync(join(result.runDir, 'manifest.json')), true);
      assert.equal(existsSync(join(result.runDir, 'request.json')), true);
      assert.deepEqual(result.changedFiles, ['src/math.js']);
      assert.ok(result.checks.some((check) => check === 'npm test: passed'));
      assert.equal(
        readFileSync(join(root, 'src', 'math.js'), 'utf-8'),
        'export const add = (a, b) => a + b;\n',
      );
      assert.equal(existsSync(join(result.runDir, 'small_fix_verifier_stdout.log')), true);
      assert.equal(existsSync(join(result.runDir, 'small_fix_verifier_stderr.log')), true);
      assert.equal(existsSync(join(result.runDir, 'small_fix_scope_before.json')), true);
      assert.equal(existsSync(join(result.runDir, 'small_fix_scope.json')), true);
      assert.equal(existsSync(join(result.runDir, 'small_fix_checkpoint.json')), true);
      assert.equal(existsSync(join(result.runDir, 'changes.diff')), true);
      assert.equal(existsSync(join(result.runDir, 'verifier_plan.json')), true);
      assert.equal(existsSync(join(result.runDir, 'verifier_execution_summary.json')), true);
      const verifierSummary = JSON.parse(
        readFileSync(join(result.runDir, 'verifier_execution_summary.json'), 'utf-8'),
      ) as { verifierCompletionSatisfied: boolean; requiredVerifierCount: number };
      assert.equal(verifierSummary.requiredVerifierCount, 1);
      assert.equal(verifierSummary.verifierCompletionSatisfied, true);
      assert.match(
        readFileSync(join(result.runDir, 'changes.diff'), 'utf-8'),
        /--- a\/src\/math\.js/,
      );
      const checkpoint = JSON.parse(
        readFileSync(join(result.runDir, 'small_fix_checkpoint.json'), 'utf-8'),
      ) as { checkpoint_id: string | null };
      assert.ok(checkpoint.checkpoint_id);
      assert.equal(existsSync(join(result.runDir, 'checkpoints', 'checkpoints.json')), true);
      assert.equal(existsSync(result.scopePath), true);
      assert.ok(
        readFileSync(join(result.runDir, 'small_fix_scope_before.json'), 'utf-8').includes(
          'scope_artifact_type',
        ),
      );
      assert.equal(result.usageSummary.totalTokens, 15);
      assert.equal(result.usageSummary.totalInputTokens, 10);
      assert.equal(result.usageSummary.totalOutputTokens, 5);
      assert.deepEqual(result.changedFiles, ['src/math.js']);
      const telemetry = JSON.parse(
        readFileSync(join(result.runDir, '05_waterfall_telemetry.json'), 'utf-8'),
      ) as Array<{
        attempts_detail?: Array<Record<string, unknown>>;
      }>;
      const attempt = telemetry[0]?.attempts_detail?.[0] ?? {};
      assert.equal(Object.hasOwn(attempt, 'ttft_ms'), true);
      assert.equal(Object.hasOwn(attempt, 'generation_ms'), true);
      assert.equal(typeof attempt['validation_ms'], 'number');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'small-fix repair loop succeeds after verifier failure on first attempt',
  { concurrency: false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-repair-'));
    let modelCalls = 0;
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        modelCalls += 1;
        // Echo the sent model identity: the exact-live-route policy rejects
        // responses whose observed model differs from the request.
        let sentModel = 'deepseek/deepseek-v4-flash-0731';
        try {
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
          if (body && typeof body.model === 'string') sentModel = body.model;
        } catch {
          /* keep fallback identity */
        }
        const replacementContent =
          modelCalls === 1
            ? 'export const add = () => 0;\n'
            : 'export const add = (a, b) => a + b;\n';
        return new Response(
          JSON.stringify({
            model: sentModel,
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    schema_version: 1,
                    summary:
                      modelCalls === 1
                        ? 'First attempt still broken.'
                        : 'Repaired math implementation.',
                    replacement_content: replacementContent,
                    confidence: 'high',
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200 },
        );
      }) as typeof fetch;

      const result = await runSmallFixPath({
        projectRoot: root,
        task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        model: 'deepseek',
        modelTier: 'standard',
        maxRepairAttempts: 2,
      });

      assert.equal(modelCalls, 2);
      assert.equal(result.status, 'SMALL_FIX_COMPLETE');
      if (result.status === 'SMALL_FIX_COMPLETE') {
        assert.equal(result.summary, 'Repaired math implementation.');
        assert.equal(
          readFileSync(join(root, 'src', 'math.js'), 'utf-8'),
          'export const add = (a, b) => a + b;\n',
        );
        assert.equal(existsSync(join(result.runDir, 'repair_attempt_timeline.json')), true);
        const timeline = JSON.parse(
          readFileSync(join(result.runDir, 'repair_attempt_timeline.json'), 'utf-8'),
        ) as { attempts: Array<{ attempt: number; status: string }> };
        assert.equal(timeline.attempts.length, 2);
        assert.equal(timeline.attempts[0]?.status, 'failed');
        assert.equal(timeline.attempts[1]?.status, 'passed');
        const terminal = JSON.parse(
          readFileSync(join(result.runDir, 'terminal_status_summary.json'), 'utf-8'),
        ) as { repair_attempt_timeline_path: string | null };
        assert.ok(terminal.repair_attempt_timeline_path);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'small-fix repair budget exhausted surfaces in checks after final verifier failure',
  { concurrency: false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-repair-budget-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      mockSmallFixResponse('export const add = () => 0;\n');

      const result = await runSmallFixPath({
        projectRoot: root,
        task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        model: 'deepseek',
        modelTier: 'standard',
        maxRepairAttempts: 1,
      });

      assert.equal(result.status, 'SMALL_FIX_FAILED');
      assert.ok(
        result.checks.some((check) => check.includes('repair budget exhausted (1 attempt(s))')),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'small-fix demotes complete status when task declares multiple required verifiers',
  { concurrency: false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-verifier-contract-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            type: 'module',
            scripts: {
              test: 'node src/math.test.js',
              typecheck: 'node -e "process.exit(0)"',
            },
          },
          null,
          2,
        ),
        'utf-8',
      );
      writeFileSync(join(root, 'src', 'math.js'), 'export const add = () => 0;\n', 'utf-8');
      writeFileSync(
        join(root, 'src', 'math.test.js'),
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { add } from './math.js';",
          "test('add sums two numbers', () => assert.equal(add(1, 2), 3));",
        ].join('\n'),
        'utf-8',
      );
      process.env['BABEL_PROJECT_ROOT'] = root;
      mockSmallFixResponse('export const add = (a, b) => a + b;\n');

      const result = await runSmallFixPath({
        projectRoot: root,
        task: 'Fix src/math.js. Verifier commands: npm run typecheck && npm test.',
        model: 'deepseek',
        modelTier: 'standard',
      });

      assert.equal(result.status, 'SMALL_FIX_FAILED');
      assert.ok(result.checks.some((check) => check.includes('missing required verifier')));
      const terminal = JSON.parse(
        readFileSync(join(result.runDir, 'terminal_status_summary.json'), 'utf-8'),
      ) as { reason_category: string; verifier_contract: { missingRequiredVerifiers: string[] } };
      assert.equal(terminal.reason_category, 'verifier_contract');
      assert.deepEqual(terminal.verifier_contract.missingRequiredVerifiers, ['npm run typecheck']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'small-fix verifier failure writes a real recovery capsule',
  { concurrency: false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      mockSmallFixResponse('export const add = ;\n');

      const result = await runSmallFixPath({
        projectRoot: root,
        task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        model: 'deepseek',
        modelTier: 'standard',
        maxRepairAttempts: 1,
      });

      assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf-8'), 'export const add = ;\n');
      assert.equal(result.status, 'SMALL_FIX_FAILED');
      assert.deepEqual(result.changedFiles, ['src/math.js']);
      assert.equal(existsSync(join(result.runDir, 'changes.diff')), true);
      assert.equal(existsSync(join(result.runDir, 'checkpoints', 'checkpoints.json')), true);
      assert.equal(existsSync(join(result.runDir, 'small_fix_scope_before.json')), true);
      assert.equal(existsSync(join(result.runDir, 'small_fix_checkpoint.json')), true);
      const assessment = buildRecoveryAssessment({ run: result.runDir });
      assert.equal(assessment.status, 'CONTINUE_READY');
      assert.equal(assessment.classification, 'rerun_verifier');
      assert.ok(
        assessment.available_artifacts.some(
          (artifact) => artifact.key === 'failure_capsule' && existsSync(artifact.path),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'small-fix rollback-on-fail restores pre-mutation file when verifier fails',
  { concurrency: false },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-rollback-flag-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      mockSmallFixResponse('export const add = ;\n');

      const result = await runSmallFixPath({
        projectRoot: root,
        task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        model: 'deepseek',
        modelTier: 'standard',
        rollbackOnFail: true,
        maxRepairAttempts: 1,
      });

      assert.equal(result.status, 'SMALL_FIX_FAILED');
      assert.deepEqual(result.changedFiles, []);
      assert.ok(result.checks.some((check) => check === 'rollback_on_fail: restored checkpoint'));
      if (result.checks.some((check) => check.includes('DENY_POLICY_INTEGRITY_DRIFT'))) {
        t.diagnostic('Observed policy denial after the fixture write.');
        assert.equal(result.checks.some((check) => check.startsWith('npm test:')), false);
        const capsule = JSON.parse(readFileSync(join(result.runDir, 'small_fix_failure_capsule.json'), 'utf8')) as { retryable: boolean; next_recommended_operator_action: string };
        assert.equal(capsule.retryable, false);
        assert.match(capsule.next_recommended_operator_action, /restored.*policy denial/i);
      }
      assert.equal(
        readFileSync(join(root, 'src', 'math.js'), 'utf-8'),
        'export const add = () => 0;\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'small-fix checkpoint rollback restores pre-mutation file',
  { concurrency: false },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-rollback-'));
    try {
      writeNodeFixture(root, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = root;
      mockSmallFixResponse('export const add = ;\n');

      const result = await runSmallFixPath({
        projectRoot: root,
        task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        model: 'deepseek',
        modelTier: 'standard',
        maxRepairAttempts: 1,
      });

      assert.equal(result.status, 'SMALL_FIX_FAILED');
      assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf-8'), 'export const add = ;\n');
      if (result.checks.some((check) => check.includes('DENY_POLICY_INTEGRITY_DRIFT'))) {
        t.diagnostic('Observed policy denial with a preserved fixture write.');
        assert.deepEqual(result.changedFiles, ['src/math.js']);
        assert.equal(result.checks.some((check) => check.startsWith('npm test:')), false);
        const capsule = JSON.parse(readFileSync(join(result.runDir, 'small_fix_failure_capsule.json'), 'utf8')) as { retryable: boolean; changed_files: string[] };
        assert.equal(capsule.retryable, false);
        assert.deepEqual(capsule.changed_files, ['src/math.js']);
      }
      const checkpointJson = JSON.parse(
        readFileSync(join(result.runDir, 'small_fix_checkpoint.json'), 'utf-8'),
      ) as { checkpoint_id: string | null };
      const checkpointId = checkpointJson.checkpoint_id;
      assert.ok(checkpointId);

      const checkpoint = readCheckpoint(result.runDir, checkpointId);
      const restoreResult = restoreCheckpoint(checkpoint);
      assert.equal(restoreResult.status, 'restored');
      assert.equal(
        readFileSync(join(root, 'src', 'math.js'), 'utf-8'),
        'export const add = () => 0;\n',
      );
      assert.equal(restoreResult.restored_files.includes(join(root, 'src', 'math.js')), true);
      assert.deepEqual(result.changedFiles, ['src/math.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
