import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveFixScopeFromDiscovery } from '../../services/fixScopeResolver.js';
import { runFixDiscoveryPhase, shouldAttemptFixDiscovery } from './fixDiscoveryLoop.js';

function writeNodeFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: { test: 'node src/math.test.js' },
    }),
    'utf-8',
  );
  writeFileSync(join(root, 'src', 'math.js'), 'export const add = () => 0;\n', 'utf-8');
  writeFileSync(
    join(root, 'src', 'math.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from './math.js';",
      "test('add sums', () => assert.equal(add(1, 2), 3));",
    ].join('\n'),
    'utf-8',
  );
}

test('shouldAttemptFixDiscovery requires fix intent and project root', () => {
  assert.equal(
    shouldAttemptFixDiscovery({
      task: 'fix the failing math test',
      projectRoot: '/tmp/repo',
    }),
    true,
  );
  assert.equal(
    shouldAttemptFixDiscovery({
      task: 'fix the failing math test',
      forcedTargetFile: 'src/math.js',
      projectRoot: '/tmp/repo',
    }),
    false,
  );
});

test('runFixDiscoveryPhase resolves scope from mock discovery observations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-fix-discovery-'));
  const previousOffline = process.env['BABEL_LITE_OFFLINE'];
  process.env['BABEL_LITE_OFFLINE'] = '1';
  try {
    writeNodeFixture(root);
    const bundle = await runFixDiscoveryPhase(
      {
        task: 'fix the failing math test. Only edit src/math.js. Run npm test before completing.',
        projectRoot: root,
        provider: 'mock',
      },
      (discovery) =>
        resolveFixScopeFromDiscovery({
          task: 'fix the failing math test. Only edit src/math.js. Run npm test before completing.',
          projectRoot: root,
          observations: discovery.observations,
          toolCallLog: discovery.toolCallLog,
        }),
    );

    assert.ok(bundle);
    assert.equal(bundle.scope.mode, 'single');
    if (bundle.scope.mode === 'single') {
      assert.equal(bundle.scope.targetFile, 'src/math.js');
    }
    assert.ok(bundle.discovery.toolCallLog.length >= 1);
    assert.ok(bundle.discovery.sessionLoopSteps.length >= 1);
    const tools = bundle.discovery.toolCallLog.map((entry) => entry.tool);
    assert.ok(tools.includes('semantic_search') || tools.includes('grep'));
  } finally {
    if (previousOffline === undefined) {
      delete process.env['BABEL_LITE_OFFLINE'];
    } else {
      process.env['BABEL_LITE_OFFLINE'] = previousOffline;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
