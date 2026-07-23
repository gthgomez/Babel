import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensureBabelCliDistReady,
  extractCriticReceiptFromCli,
  inspectBabelCliDistFreshness,
  parseCliJson,
  readLiteTrustDemoFixture,
  resolveBabelCliDistGateMode,
  resolveBabelCliEntry,
  resolveLiteTrustDemoFixturePath,
  runLiteTrustDemo,
} from './liteTrustDemo.js';

function writeTrustDemoRepo(root: string, implementation: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
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

test('lite trust demo fixture describes the private fix-verifier-undo loop', () => {
  const fixture = readLiteTrustDemoFixture(resolveLiteTrustDemoFixturePath());
  assert.equal(fixture.fixture_type, 'babel_lite_trust_demo');
  assert.equal(fixture.visibility, 'private');
  assert.equal(fixture.target_file, 'src/math.js');
  assert.equal(fixture.verifier_command, 'npm test');
});

test('resolveBabelCliDistGateMode maps env aliases', () => {
  assert.equal(resolveBabelCliDistGateMode({}, 'ensure'), 'ensure');
  assert.equal(resolveBabelCliDistGateMode({ BABEL_CLI_DIST_GATE: 'fail' }), 'fail');
  assert.equal(resolveBabelCliDistGateMode({ BABEL_CLI_DIST_GATE: 'warn' }), 'warn');
  assert.equal(resolveBabelCliDistGateMode({ BABEL_CLI_DIST_GATE: 'off' }), 'off');
  assert.equal(resolveBabelCliDistGateMode({ BABEL_CLI_DIST_GATE: 'build' }), 'ensure');
});

test('resolveBabelCliEntry honors BABEL_CLI_ENTRY override', () => {
  const entry = resolveBabelCliEntry({ BABEL_CLI_ENTRY: 'C:/tmp/custom-entry.js' });
  assert.match(entry.replace(/\\/g, '/'), /custom-entry\.js$/);
});

test('inspectBabelCliDistFreshness reports missing and stale dist', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-dist-gate-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
    const missing = inspectBabelCliDistFreshness(root);
    assert.equal(missing.distExists, false);
    assert.equal(missing.isStale, true);
    assert.match(missing.reason, /Missing dist/);

    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.js'), 'export {};\n', 'utf8');
    // Make source newer than dist
    const now = Date.now() / 1000;
    utimesSync(join(root, 'dist', 'index.js'), now - 120, now - 120);
    utimesSync(join(root, 'src', 'index.ts'), now, now);
    const stale = inspectBabelCliDistFreshness(root);
    assert.equal(stale.distExists, true);
    assert.equal(stale.isStale, true);
    assert.match(stale.reason, /Stale dist/);

    // Fresh dist after "rebuild"
    utimesSync(join(root, 'dist', 'index.js'), now + 10, now + 10);
    const fresh = inspectBabelCliDistFreshness(root);
    assert.equal(fresh.isStale, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureBabelCliDistReady skips when BABEL_CLI_ENTRY is set', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-dist-gate-entry-'));
  try {
    const report = ensureBabelCliDistReady({
      packageRoot: root,
      mode: 'fail',
      env: { BABEL_CLI_ENTRY: join(root, 'custom.js') },
      log: () => {},
    });
    assert.equal(report.isStale, false);
    assert.match(report.reason, /BABEL_CLI_ENTRY override/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureBabelCliDistReady fail mode throws on missing dist', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-dist-gate-fail-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export {};\n', 'utf8');
    assert.throws(
      () =>
        ensureBabelCliDistReady({
          packageRoot: root,
          mode: 'fail',
          env: {},
          log: () => {},
        }),
      /dist gate fail/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseCliJson recovers last JSON object after banner noise (P1.2)', () => {
  const payload = parseCliJson('banner line\n{"status":"ANSWER_READY","critic_receipt":{"verdict":"skip"}}\n');
  assert.equal(payload?.['status'], 'ANSWER_READY');
  assert.equal(
    (payload?.['critic_receipt'] as { verdict?: string } | undefined)?.verdict,
    'skip',
  );
  assert.equal(parseCliJson('not json at all'), null);
});

test('extractCriticReceiptFromCli prefers payload then stream (P1.2)', () => {
  const fromPayload = extractCriticReceiptFromCli(
    { critic_receipt: { verdict: 'pass', confidence: 0.9 } },
    '',
    '',
  );
  assert.equal(fromPayload?.verdict, 'pass');
  assert.equal(fromPayload?.source, 'payload');

  const fromStdout = extractCriticReceiptFromCli(
    null,
    'noise\n{"status":"X","critic_receipt":{"verdict":"reject","reasons":["bad"]}}\n',
    '',
  );
  assert.equal(fromStdout?.verdict, 'reject');
  assert.equal(fromStdout?.source, 'stdout_json');

  const fromRegex = extractCriticReceiptFromCli(null, 'critic_verdict=skip after write', '');
  assert.equal(fromRegex?.verdict, 'skip');
  assert.equal(fromRegex?.source, 'stream_regex');
});

test.skip(
  'lite trust demo runs success and verifier-fail scenarios offline',
  { concurrency: false },
  async () => {
    // SKIP: functionality consolidated into chat mode — 'daily' and 'undo' commands removed
    const root = mkdtempSync(join(tmpdir(), 'babel-lite-trust-demo-'));
    const fixture = readLiteTrustDemoFixture(resolveLiteTrustDemoFixturePath());
    try {
      writeTrustDemoRepo(root, fixture.broken_implementation);
      const result = await runLiteTrustDemo({
        projectRoot: root,
        fixturePath: resolveLiteTrustDemoFixturePath(),
      });

      assert.equal(result.status, 'pass');
      assert.equal(result.execution_mode, 'offline_demo');
      assert.equal(result.scenarios.length, 2);
      assert.equal(result.scenarios[0]?.scenario_id, 'success');
      assert.equal(result.scenarios[1]?.scenario_id, 'verifier_fail');
      assert.ok(result.steps.some((step) => step.name === 'success:bl_fix_verifier'));
      assert.ok(result.steps.some((step) => step.name === 'verifier_fail:bl_fix_rollback_on_fail'));
      assert.ok(result.run_dir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
