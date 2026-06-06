import { mkdirSync, rmSync } from 'node:fs';
import { join }         from 'node:path';
import { tmpdir }       from 'node:os';
import { mkdtempSync }  from 'node:fs';
import { describe, it }  from 'node:test';
import assert from 'node:assert/strict';

describe('resolveProjectRoot', () => {
  it('resolves legacy example_autonomous_agent project id to example_autonomous_agent folder', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'babel-helpers-test-'));
    const workspaceRoot = join(tempRoot, 'workspace');
    const babelRoot = join(workspaceRoot, 'private source repo');
    const antigGravityDir = join(workspaceRoot, 'example_autonomous_agent');
    const originalBabelRoot = process.env['BABEL_ROOT'];

    try {
      mkdirSync(antigGravityDir, { recursive: true });
      mkdirSync(babelRoot, { recursive: true });
      process.env['BABEL_ROOT'] = babelRoot;
      const { resolveProjectRoot } = await import('./helpers.js');

      const resolved = resolveProjectRoot('example_autonomous_agent');
      assert.equal(resolved, antigGravityDir);
    } finally {
      process.env['BABEL_ROOT'] = originalBabelRoot;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
