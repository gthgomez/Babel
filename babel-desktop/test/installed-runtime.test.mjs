import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as runtime from '../native/runtime.mjs';

test('installed runtime never falls back to a developer checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'Babel install space '));
  try {
    const resourcesPath = join(root, 'resources');
    const cli = join(resourcesPath, 'babel-runtime', 'cli', 'dist', 'index.js');
    const node = join(resourcesPath, 'babel-runtime', 'node', 'node.exe');
    await mkdir(join(resourcesPath, 'babel-runtime', 'cli', 'dist'), {recursive:true});
    await mkdir(join(resourcesPath, 'babel-runtime', 'node'), {recursive:true});
    await writeFile(cli, '');
    const missing = runtime.resolveOfficialCli(join(resourcesPath, 'app'), {isPackaged:true, resourcesPath});
    assert.equal(missing.ready, false, 'a CLI entry without its runtime must not be ready');
    await writeFile(node, '');
    const found = runtime.resolveOfficialCli(join(resourcesPath, 'app'), {isPackaged:true, resourcesPath});
    assert.equal(found.ready, true);
    assert.equal(found.path, cli);
    assert.equal(found.executable, node);
    assert.equal(found.source, 'bundled');
    await rm(cli);
    assert.equal(runtime.resolveOfficialCli(join(resourcesPath, 'app'), {isPackaged:true, resourcesPath}).ready, false);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('bundled environment owns writable paths without importing developer configuration', () => {
  assert.equal(typeof runtime.bundledEnvironment, 'function');
  const env = runtime.bundledEnvironment(join(tmpdir(), 'fresh profile'), {
    BABEL_ROOT:'developer root', BABEL_CONFIG_DIR:'developer config', BABEL_ENV_LOADED:'true',
    NODE_OPTIONS:'--require private-hook.js', NODE_PATH:'developer modules', ELECTRON_RUN_AS_NODE:'1',
    OPENROUTER_API_KEY:'presence fixture only', SystemRoot:'system fixture',
  });
  assert.equal(env.BABEL_ROOT, undefined);
  assert.equal(env.BABEL_ENV_LOADED, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.BABEL_CONFIG_DIR, join(tmpdir(), 'fresh profile', 'engine', 'config'));
  assert.equal(env.BABEL_RUNS_DIR, join(tmpdir(), 'fresh profile', 'engine', 'state', 'runs'));
  assert.equal(env.OPENROUTER_API_KEY, 'presence fixture only');
});
