import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BABEL_RUNS_DIR } from '../../cli/constants.js';
import { runSmallFixPath } from '../../services/smallFix.js';
import { runUndoLane } from './undoLane.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env['DEEPINFRA_API_KEY'];
const originalDeepSeekApiKey = process.env['DEEPSEEK_API_KEY'];

function writeNodeFixture(root: string, implementation: string): void {
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

function withoutLatestRunPointer<T>(fn: () => T): T {
  const latestPath = join(BABEL_RUNS_DIR, '.latest.json');
  const hadLatest = existsSync(latestPath);
  const previousLatest = hadLatest ? readFileSync(latestPath, 'utf-8') : null;
  if (hadLatest) {
    unlinkSync(latestPath);
  }
  try {
    return fn();
  } finally {
    if (hadLatest && previousLatest !== null) {
      writeFileSync(latestPath, previousLatest, 'utf-8');
    }
  }
}

describe('runUndoLane', () => {
  it('refuses undo when no recoverable run exists', () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-undo-lane-empty-'));
    try {
      withoutLatestRunPointer(() => {
        assert.throws(
          () => runUndoLane({ task: 'Restore last checkpoint', projectRoot: repo }),
          /No recoverable run found for bl undo/,
        );
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('restores from the latest small-fix checkpoint and writes undo artifacts under runs/babel-lite', { concurrency: false }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'babel-undo-lane-'));
    try {
      writeNodeFixture(repo, 'export const add = () => 0;\n');
      process.env['BABEL_PROJECT_ROOT'] = repo;
      mockSmallFixResponse('export const add = (a, b) => a + b;\n');

      const fix = await runSmallFixPath({
        projectRoot: repo,
        task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        model: 'deepseek',
        modelTier: 'standard',
      });
      assert.equal(fix.status, 'SMALL_FIX_COMPLETE');
      assert.ok(fix.runDir.replace(/\\/g, '/').includes('runs/babel-lite'));

      const result = runUndoLane({ task: 'Restore last checkpoint', projectRoot: repo });
      assert.equal(result.exitCode, 0);
      assert.equal(result.payload.status, 'UNDO_COMPLETE');
      assert.equal(result.payload.checkpoint.restore_command, 'bl undo');
      assert.ok(result.payload.run_dir?.replace(/\\/g, '/').includes('runs/babel-lite'));
      assert.equal(readFileSync(join(repo, 'src', 'math.js'), 'utf-8'), 'export const add = () => 0;\n');
      assert.match(result.humanText, /Rollback: bl undo/);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env['BABEL_PROJECT_ROOT'];
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
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('prefers the requested project root over a newer global latest pointer', { concurrency: false }, async () => {
    const repoA = mkdtempSync(join(tmpdir(), 'babel-undo-lane-a-'));
    const repoB = mkdtempSync(join(tmpdir(), 'babel-undo-lane-b-'));
    try {
      writeNodeFixture(repoA, 'export const add = () => 0;\n');
      writeNodeFixture(repoB, 'export const add = () => 0;\n');

      process.env['BABEL_PROJECT_ROOT'] = repoA;
      mockSmallFixResponse('export const add = (a, b) => a + b;\n');
      const fixA = await runSmallFixPath({
        projectRoot: repoA,
        task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        model: 'deepseek',
        modelTier: 'standard',
      });
      assert.equal(fixA.status, 'SMALL_FIX_COMPLETE');

      process.env['BABEL_PROJECT_ROOT'] = repoB;
      mockSmallFixResponse('export const add = (a, b) => a + b;\n');
      const fixB = await runSmallFixPath({
        projectRoot: repoB,
        task: 'Fix the failing Node test. Only edit src/math.js. Run npm test before completing.',
        model: 'deepseek',
        modelTier: 'standard',
      });
      assert.equal(fixB.status, 'SMALL_FIX_COMPLETE');

      const result = runUndoLane({ task: 'Restore last checkpoint', projectRoot: repoA });
      assert.equal(result.exitCode, 0);
      assert.equal(result.payload.status, 'UNDO_COMPLETE');
      assert.ok(result.payload.run_dir?.replace(/\\/g, '/').includes(repoA.replace(/\\/g, '/')));
      assert.equal(readFileSync(join(repoA, 'src', 'math.js'), 'utf-8'), 'export const add = () => 0;\n');
      assert.equal(readFileSync(join(repoB, 'src', 'math.js'), 'utf-8'), 'export const add = (a, b) => a + b;\n');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env['BABEL_PROJECT_ROOT'];
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
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });
});
