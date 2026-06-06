import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readLiteTrustDemoFixture,
  resolveLiteTrustDemoFixturePath,
  runLiteTrustDemo,
} from './liteTrustDemo.js';

function writeTrustDemoRepo(root: string, implementation: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
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

test('lite trust demo fixture describes the private fix-verifier-undo loop', () => {
  const fixture = readLiteTrustDemoFixture(resolveLiteTrustDemoFixturePath());
  assert.equal(fixture.fixture_type, 'babel_lite_trust_demo');
  assert.equal(fixture.visibility, 'private');
  assert.equal(fixture.target_file, 'src/math.js');
  assert.equal(fixture.verifier_command, 'npm test');
});

test('lite trust demo runs success and verifier-fail scenarios offline', { concurrency: false }, async () => {
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
    assert.ok(result.steps.some(step => step.name === 'success:bl_fix_verifier'));
    assert.ok(result.steps.some(step => step.name === 'verifier_fail:bl_fix_rollback_on_fail'));
    assert.ok(result.run_dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
