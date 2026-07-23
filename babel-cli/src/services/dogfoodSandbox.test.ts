import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { promoteDogfoodRun, runDogfoodApply } from './dogfoodSandbox.js';

function writeNodeFixture(root: string): void {
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

const originalFetch = globalThis.fetch;
const originalDeepSeekApiKey = process.env['DEEPSEEK_API_KEY'];

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDeepSeekApiKey === undefined) {
    delete process.env['DEEPSEEK_API_KEY'];
  } else {
    process.env['DEEPSEEK_API_KEY'] = originalDeepSeekApiKey;
  }
});

test('runDogfoodApply shadow mode writes promote artifact without mutating live root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-dogfood-shadow-'));
  try {
    writeNodeFixture(root);
    process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schema_version: 1,
                  summary: 'Fixed add',
                  replacement_content: 'export const add = (a, b) => a + b;\n',
                  confidence: 'high',
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      )) as typeof fetch;

    const before = readFileSync(join(root, 'src', 'math.js'), 'utf-8');
    const result = await runDogfoodApply({
      task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
      projectRoot: root,
      isolation: 'shadow',
      provider: 'mock',
    });

    const after = readFileSync(join(root, 'src', 'math.js'), 'utf-8');
    assert.equal(before, after);
    assert.equal(result.status, 'DOGFOOD_COMPLETE');
    assert.ok(existsSync(result.promoteArtifactPath));
    const artifact = JSON.parse(readFileSync(result.promoteArtifactPath, 'utf-8')) as {
      changed_files: string[];
    };
    assert.deepEqual(artifact.changed_files, ['src/math.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('promoteDogfoodRun copies changed files into live project root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-dogfood-promote-'));
  try {
    writeNodeFixture(root);
    process.env['DEEPSEEK_API_KEY'] = 'sk-test-key';
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  schema_version: 1,
                  summary: 'Fixed add',
                  replacement_content: 'export const add = (a, b) => a + b;\n',
                  confidence: 'high',
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      )) as typeof fetch;

    const run = await runDogfoodApply({
      task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
      projectRoot: root,
      isolation: 'shadow',
      provider: 'mock',
    });
    assert.equal(run.status, 'DOGFOOD_COMPLETE');

    const promoted = promoteDogfoodRun(root, run.runId);
    assert.deepEqual(promoted.changedFiles, ['src/math.js']);
    assert.match(readFileSync(join(root, 'src', 'math.js'), 'utf-8'), /a \+ b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
