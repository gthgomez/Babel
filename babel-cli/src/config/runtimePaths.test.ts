import assert from 'node:assert/strict'
import { existsSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { resolveRuntimeLearningRoot, resolveRuntimePaths } from './runtimePaths.js'
import { getAgentRunsRoot, runAgentTeam } from '../services/agentTeams.js'

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

test('does honor state overrides for user stores while retaining source home defaults', async () => {
  const { resolveRuntimeUserStateRoot } = await import('./runtimePaths.js')
  assert.equal(resolveRuntimeUserStateRoot({ HOME: '/user', BABEL_ROOT: '/source', BABEL_STATE_DIR: '/state' }, '/source/babel-cli'), resolve('/state'))
  assert.equal(resolveRuntimeUserStateRoot({ HOME: '/user', BABEL_ROOT: '/source' }, '/source/babel-cli'), resolve('/user/.babel'))
})

test('does place installed resource locks in user state while preserving explicit project scope', async () => {
  const { resolveRuntimeLockRoot, resolveRuntimeUserStateRoot } = await import('./runtimePaths.js')
  const root = mkdtempSync(join(tmpdir(), 'babel locks ü '))
  const packageRoot = join(root, 'package')
  const resourceRoot = join(packageRoot, 'resources')
  mkdirSync(resourceRoot, { recursive: true })
  writeFileSync(join(resourceRoot, 'prompt_catalog.yaml'), 'assets: []')
  try {
    const env = { HOME: join(root, 'home'), BABEL_STATE_DIR: join(root, 'state') }
    assert.equal(resolveRuntimeUserStateRoot({ HOME: join(root, 'home') }, packageRoot), join(root, 'home', '.babel'))
    assert.equal(resolveRuntimeUserStateRoot(env, packageRoot), join(root, 'state'))
    assert.equal(resolveRuntimeLockRoot(resourceRoot, env, packageRoot), join(root, 'state', 'locks'))
    assert.equal(resolveRuntimeLockRoot(join(root, 'project'), env, packageRoot), join(root, 'project', '.babel', 'locks'))
    assert.equal(resolveRuntimeLockRoot(root, env, join(root, 'source')), join(root, '.babel', 'locks'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('does persist session, token, and memory stores under the state override', async () => {
  const { saveSessionState, loadSessionState } = await import('../interactive/session.js')
  const { resolveTokenDbPath } = await import('../services/tokenHistoryDb.js')
  const { resolveMemoryRoot } = await import('../services/memory/memoryStore.js')
  const root = mkdtempSync(join(tmpdir(), 'babel user stores ü '))
  const oldState = process.env['BABEL_STATE_DIR']
  const oldTokenDb = process.env['BABEL_TOKEN_DB_PATH']
  process.env['BABEL_STATE_DIR'] = root
  delete process.env['BABEL_TOKEN_DB_PATH']
  try {
    saveSessionState({ state: { mode: 'chat' }, turnCounter: 0 } as never)
    assert.equal(loadSessionState()?.mode, 'chat')
    assert.ok(existsSync(join(root, 'session.json')))
    assert.ok(existsSync(join(root, 'token-history.json')))
    assert.equal(resolveTokenDbPath(), join(root, 'token_history.db'))
    const memoryRoot = resolveMemoryRoot(join(root, 'target'))
    assert.ok(memoryRoot?.startsWith(join(root, 'projects')))
    assert.ok(existsSync(memoryRoot!))
  } finally {
    if (oldState === undefined) delete process.env['BABEL_STATE_DIR']
    else process.env['BABEL_STATE_DIR'] = oldState
    if (oldTokenDb === undefined) delete process.env['BABEL_TOKEN_DB_PATH']
    else process.env['BABEL_TOKEN_DB_PATH'] = oldTokenDb
    rmSync(root, { recursive: true, force: true })
  }
})

test('does resolve agent runs under user state while retaining explicit source roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel agent state ü-'));
  const previousState = process.env['BABEL_STATE_DIR'];
  const previousRuns = process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_STATE_DIR'] = root;
  delete process.env['BABEL_RUNS_DIR'];
  try {
    assert.equal(getAgentRunsRoot(), join(root, 'runs', 'agents'));
    const projectRoot = join(root, 'project');
    mkdirSync(projectRoot);
    const run = runAgentTeam({
      schema_version: 1,
      id: 'user-state-boundary',
      project_root: projectRoot,
      isolation: 'copy',
      agents: [{
        id: 'reviewer', role: 'reviewer', task: 'Record note only.',
        allowed_tools: ['file_read'], disallowed_tools: ['file_write'],
        write_scope: [], merge_strategy: 'review_only',
        operations: [{ type: 'note', note: 'User state boundary check.' }],
      }],
    });
    assert.equal(run.run_dir.startsWith(join(root, 'runs', 'agents')), true);
    assert.equal(existsSync(join(root, 'runs', 'agents', 'agents.json')), true);
    assert.equal(getAgentRunsRoot({ babelRoot: root }), join(root, 'runs', 'agents'));
    assert.equal(getAgentRunsRoot({ runsRoot: join(root, 'explicit') }), join(root, 'explicit'));
  } finally {
    if (previousState === undefined) delete process.env['BABEL_STATE_DIR'];
    else process.env['BABEL_STATE_DIR'] = previousState;
    if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = previousRuns;
    rmSync(root, { recursive: true, force: true });
  }
});
