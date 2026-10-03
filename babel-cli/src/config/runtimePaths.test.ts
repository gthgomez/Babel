import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { resolveRuntimeLearningRoot, resolveRuntimePaths } from './runtimePaths.js'

test('does separate installed resources from user directories despite BABEL_ROOT', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel paths é '))
  const packageRoot = join(root, 'read only package')
  const resourceRoot = join(packageRoot, 'resources')
  mkdirSync(resourceRoot, { recursive: true })
  writeFileSync(join(resourceRoot, 'prompt_catalog.yaml'), 'assets: []')
  chmodSync(packageRoot, 0o555)
  try {
    const paths = resolveRuntimePaths({ BABEL_ROOT: join(root, 'wrong'), HOME: join(root, 'user'), BABEL_PROJECT_ROOT: join(root, 'target') }, packageRoot)
    assert.equal(paths.isInstalled, true)
    assert.equal(paths.resourceRoot, resourceRoot)
    assert.equal(paths.packageRoot, packageRoot)
    assert.equal(paths.userConfigRoot, join(root, 'user', '.babel', 'config'))
    assert.equal(paths.userStateRoot, join(root, 'user', '.babel'))
    assert.equal(paths.userCacheRoot, join(root, 'user', '.babel', 'cache'))
    assert.equal(paths.targetProjectRoot, join(root, 'target'))
    assert.equal(resolveRuntimeLearningRoot(resourceRoot, { HOME: join(root, 'user') }, packageRoot), join(root, 'user', '.babel', 'runs', 'local-learning'))
  } finally {
    chmodSync(packageRoot, 0o755)
    rmSync(root, { recursive: true, force: true })
  }
})

test('does preserve source root and resolve user overrides at call time', () => {
  const paths = resolveRuntimePaths({ BABEL_ROOT: '/source', BABEL_CONFIG_DIR: '/user/config', BABEL_STATE_DIR: '/user/state', BABEL_CACHE_DIR: '/user/cache' }, '/source/babel-cli')
  assert.equal(paths.isInstalled, false)
  assert.equal(paths.resourceRoot, resolve('/source'))
  assert.equal(paths.userConfigRoot, resolve('/user/config'))
  assert.equal(paths.userStateRoot, resolve('/user/state'))
  assert.equal(paths.userCacheRoot, resolve('/user/cache'))
  assert.equal(resolveRuntimeLearningRoot(resolve('/source'), {}, '/source/babel-cli'), join(resolve('/source'), 'runs', 'local-learning'))
  assert.equal(resolveRuntimePaths({ BABEL_ROOT: '/other' }, '/source/babel-cli').userConfigRoot, resolve('/other/config'))
})

test('does persist runtime mode inside the overridden user config boundary', async () => {
  const { readRuntimeMode, writeRuntimeMode } = await import('./runtimeMode.js')
  const { resolveExecutorDryRun } = await import('./dryRun.js')
  const root = mkdtempSync(join(tmpdir(), 'babel user ü '))
  const oldConfig = process.env['BABEL_CONFIG_DIR']
  const oldMode = process.env['BABEL_RUNTIME_MODE']
  process.env['BABEL_CONFIG_DIR'] = join(root, 'user config')
  delete process.env['BABEL_RUNTIME_MODE']
  try {
    writeRuntimeMode('plan')
    assert.equal(readRuntimeMode(), 'plan')
    writeFileSync(join(root, 'user config', 'runtime-flags.json'), '{"dryRun":false}')
    assert.equal(resolveExecutorDryRun({ BABEL_CONFIG_DIR: join(root, 'user config') }).source, 'persisted')
    assert.equal(resolveExecutorDryRun({ BABEL_CONFIG_DIR: join(root, 'user config') }).dryRun, false)
  } finally {
    if (oldConfig === undefined) delete process.env['BABEL_CONFIG_DIR']
    else process.env['BABEL_CONFIG_DIR'] = oldConfig
    if (oldMode === undefined) delete process.env['BABEL_RUNTIME_MODE']
    else process.env['BABEL_RUNTIME_MODE'] = oldMode
    rmSync(root, { recursive: true, force: true })
  }
})


test('does retain source paths when prepack stages installed resources in a checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel source é '))
  const packageRoot = join(root, 'babel-cli')
  mkdirSync(join(packageRoot, 'resources'), { recursive: true })
  mkdirSync(join(packageRoot, 'src'))
  writeFileSync(join(root, 'prompt_catalog.yaml'), 'assets: []')
  writeFileSync(join(packageRoot, 'resources', 'prompt_catalog.yaml'), 'assets: []')
  writeFileSync(join(packageRoot, 'src', 'index.ts'), '// source entry')
  try {
    const paths = resolveRuntimePaths({}, packageRoot)
    assert.equal(paths.isInstalled, false)
    assert.equal(paths.resourceRoot, root)
    assert.equal(paths.userConfigRoot, join(root, 'config'))
    assert.equal(paths.userStateRoot, root)
    assert.equal(resolveRuntimePaths({ BABEL_ROOT: join(root, 'override') }, packageRoot).resourceRoot, join(root, 'override'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
