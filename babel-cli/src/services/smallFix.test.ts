import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildRecoveryAssessment } from './recovery.js';
import { readCheckpoint, restoreCheckpoint } from './checkpoints.js';
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
const originalProjectRoot = process.env['BABEL_PROJECT_ROOT'];

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
  if (originalProjectRoot === undefined) {
    delete process.env['BABEL_PROJECT_ROOT'];
  } else {
    process.env['BABEL_PROJECT_ROOT'] = originalProjectRoot;
  }
});

function writeNodeFixture(root: string, implementation: string): void {
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node src/math.test.js' },
  }, null, 2), 'utf-8');
  writeFileSync(join(root, 'src', 'math.js'), implementation, 'utf-8');
  writeFileSync(join(root, 'src', 'math.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './math.js';",
    '',
    "test('add sums two numbers', () => {",
    '  assert.equal(add(1, 2), 3);',
    '});',
    '',
  ].join('\n'), 'utf-8');
}

function mockSmallFixResponse(replacementContent: string): void {
  process.env['DEEPSEEK_API_KEY'] = 'test-key';
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          schema_version: 1,
          summary: 'Updated math implementation.',
          replacement_content: replacementContent,
          confidence: 'high',
        }),
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200 })) as typeof fetch;
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
    assert.equal(detected.targetFile, 'src/math.js');
    assert.equal(detected.verifierCommand, 'npm test');
    assert.equal(detected.projectRoot, root);
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
    assert.equal(detected.targetFile, 'src/math.js');
    assert.equal(detected.verifierCommand, 'npm test');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('small-fix detection declines ambiguous failing test repairs', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-'));
  try {
    writeNodeFixture(root, 'export const add = () => 0;\n');
    writeFileSync(join(root, 'src', 'strings.js'), 'export const trim = (value) => value;\n', 'utf-8');
    writeFileSync(join(root, 'src', 'strings.test.js'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { trim } from './strings.js';",
      "test('trim removes spaces', () => assert.equal(trim(' x '), 'x'));",
    ].join('\n'), 'utf-8');

    assert.equal(detectSmallFix({
      projectRoot: root,
      task: 'fix the failing test',
    }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('small-fix detection rejects broad mutation and unsafe verifier commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'math.js'), 'export const add = () => 0;\n', 'utf-8');

    assert.equal(detectSmallFix({
      projectRoot: root,
      task: 'Fix the failing tests across the repo. Run npm test before completing.',
    }), null);

    assert.equal(detectSmallFix({
      projectRoot: root,
      task: 'Only edit src/math.js. Run npm install before completing.',
    }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('classifySmallFixProviderFailure maps credential and network errors to recovery next steps', () => {
  const credential = classifySmallFixProviderFailure(new Error('[deepInfraApi] DEEPINFRA_API_KEY is not set.'));
  assert.equal(credential.failureCode, 'credential_missing');
  assert.deepEqual(credential.next, ['check DEEPINFRA_API_KEY', 'bl undo']);

  const deepSeekCredential = classifySmallFixProviderFailure(new Error('[deepSeekApi] DEEPSEEK_API_KEY is not set.'));
  assert.equal(deepSeekCredential.failureCode, 'credential_missing');
  assert.deepEqual(deepSeekCredential.next, ['check DEEPSEEK_API_KEY', 'bl undo']);

  const network = classifySmallFixProviderFailure(new Error('[deepInfraApi] Network error (model): fetch failed'));
  assert.equal(network.failureCode, 'provider_network_failed');
  assert.deepEqual(network.next, ['check DEEPINFRA_API_KEY', 'bl undo']);
});

test('small-fix live path fails with structured recoverable error when DEEPSEEK_API_KEY is missing', { concurrency: false }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-credential-'));
  try {
    writeNodeFixture(root, 'export const add = () => 0;\n');
    process.env['BABEL_PROJECT_ROOT'] = root;
    delete process.env['DEEPSEEK_API_KEY'];

    await assert.rejects(
      () => runSmallFixPath({
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
        assert.deepEqual(error.next, ['check DEEPSEEK_API_KEY', 'bl undo']);
        assert.ok(error.runDir.replace(/\\/g, '/').includes('runs/babel-lite'));
        assert.equal(existsSync(join(error.runDir, 'small_fix_failure_capsule.json')), true);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('small-fix live path surfaces network failures as recoverable provider errors', { concurrency: false }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-small-fix-network-'));
  try {
    writeNodeFixture(root, 'export const add = () => 0;\n');
    process.env['BABEL_PROJECT_ROOT'] = root;
    process.env['DEEPSEEK_API_KEY'] = 'test-key';
    globalThis.fetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;

    await assert.rejects(
      () => runSmallFixPath({
        projectRoot: root,
        task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        provider: 'live',
        model: 'deepseek',
        modelTier: 'standard',
      }),
      (error: unknown) => {
        assert.ok(error instanceof SmallFixRecoverableError);
        assert.equal(error.failureCode, 'provider_network_failed');
        assert.deepEqual(error.next, ['check DEEPSEEK_API_KEY', 'bl undo']);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSmallFixProvider honors --provider mock and BABEL_LITE_OFFLINE', () => {
  assert.equal(resolveSmallFixProvider({ provider: 'mock' }), 'mock');
  assert.equal(resolveSmallFixProvider({ provider: 'live' }, { BABEL_LITE_OFFLINE: '1' }), 'live');
  assert.equal(resolveSmallFixProvider({}, { BABEL_LITE_OFFLINE: '1' }), 'mock');
  assert.equal(resolveSmallFixProvider({}, { BABEL_SMALL_FIX_PROVIDER: 'mock' }), 'mock');
  assert.equal(resolveSmallFixProvider({}), 'live');
});

test('small-fix offline demo provider fixes trust fixture without network', { concurrency: false }, async () => {
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

    assert.equal(result.status, 'SMALL_FIX_COMPLETE');
    assert.equal(result.executionMode, 'offline_demo');
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf-8'), fixture.fixed_implementation);
    assert.ok(result.checks.some(check => check === 'npm test: passed'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('small-fix path writes one file and preserves verifier output', { concurrency: false }, async () => {
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
    assert.ok(result.checks.some(check => check === 'npm test: passed'));
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf-8'), 'export const add = (a, b) => a + b;\n');
    assert.equal(existsSync(join(result.runDir, 'small_fix_verifier_stdout.log')), true);
    assert.equal(existsSync(join(result.runDir, 'small_fix_verifier_stderr.log')), true);
    assert.equal(existsSync(join(result.runDir, 'small_fix_scope_before.json')), true);
    assert.equal(existsSync(join(result.runDir, 'small_fix_scope.json')), true);
    assert.equal(existsSync(join(result.runDir, 'small_fix_checkpoint.json')), true);
    assert.equal(existsSync(join(result.runDir, 'changes.diff')), true);
    assert.match(readFileSync(join(result.runDir, 'changes.diff'), 'utf-8'), /--- a\/src\/math\.js/);
    const checkpoint = JSON.parse(readFileSync(join(result.runDir, 'small_fix_checkpoint.json'), 'utf-8')) as { checkpoint_id: string | null };
    assert.ok(checkpoint.checkpoint_id);
    assert.equal(existsSync(join(result.runDir, 'checkpoints', 'checkpoints.json')), true);
    assert.equal(existsSync(result.scopePath), true);
    assert.ok(readFileSync(join(result.runDir, 'small_fix_scope_before.json'), 'utf-8').includes('scope_artifact_type'));
    assert.equal(result.usageSummary.totalTokens, 15);
    assert.equal(result.usageSummary.totalInputTokens, 10);
    assert.equal(result.usageSummary.totalOutputTokens, 5);
    assert.deepEqual(result.changedFiles, ['src/math.js']);
    const telemetry = JSON.parse(readFileSync(join(result.runDir, '05_waterfall_telemetry.json'), 'utf-8')) as Array<{
      attempts_detail?: Array<Record<string, unknown>>;
    }>;
    const attempt = telemetry[0]?.attempts_detail?.[0] ?? {};
    assert.equal(Object.hasOwn(attempt, 'ttft_ms'), true);
    assert.equal(Object.hasOwn(attempt, 'generation_ms'), true);
    assert.equal(typeof attempt['validation_ms'], 'number');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('small-fix verifier failure writes a real recovery capsule', { concurrency: false }, async () => {
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
    assert.ok(assessment.available_artifacts.some(artifact => artifact.key === 'failure_capsule' && existsSync(artifact.path)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('small-fix rollback-on-fail restores pre-mutation file when verifier fails', { concurrency: false }, async () => {
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
    });

    assert.equal(result.status, 'SMALL_FIX_FAILED');
    assert.deepEqual(result.changedFiles, []);
    assert.ok(result.checks.some(check => check === 'rollback_on_fail: restored checkpoint'));
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf-8'), 'export const add = () => 0;\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('small-fix checkpoint rollback restores pre-mutation file', { concurrency: false }, async () => {
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
    });

    assert.equal(result.status, 'SMALL_FIX_FAILED');
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf-8'), 'export const add = ;\n');
    const checkpointJson = JSON.parse(readFileSync(join(result.runDir, 'small_fix_checkpoint.json'), 'utf-8')) as { checkpoint_id: string | null };
    const checkpointId = checkpointJson.checkpoint_id;
    assert.ok(checkpointId);

    const checkpoint = readCheckpoint(result.runDir, checkpointId);
    const restoreResult = restoreCheckpoint(checkpoint);
    assert.equal(restoreResult.status, 'restored');
    assert.equal(readFileSync(join(root, 'src', 'math.js'), 'utf-8'), 'export const add = () => 0;\n');
    assert.equal(restoreResult.restored_files.includes(join(root, 'src', 'math.js')), true);
    assert.deepEqual(result.changedFiles, ['src/math.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
