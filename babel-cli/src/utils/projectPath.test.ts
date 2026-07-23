import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveProjectPath } from './projectPath.js';

describe('resolveProjectPath', () => {
  const root = '/tmp/proj';

  test('joins relative paths to projectRoot', () => {
    const resolved = resolveProjectPath(root, 'django/conf/global_settings.py');
    assert.match(resolved.replace(/\\/g, '/'), /Workspace\/proj\/django\/conf\/global_settings\.py$/i);
  });

  test('preserves absolute Windows paths', () => {
    const abs = '/tmp/proj\\src\\a.ts';
    assert.equal(resolveProjectPath(root, abs), abs);
  });

  test('strips file:// prefix', () => {
    const resolved = resolveProjectPath(root, 'file:////tmp/proj/src/a.ts');
    assert.match(resolved.replace(/\\/g, '/'), /C:\/Workspace\/proj\/src\/a\.ts$/i);
  });

  test('empty path returns projectRoot', () => {
    assert.equal(resolveProjectPath(root, '  '), root);
  });
});
