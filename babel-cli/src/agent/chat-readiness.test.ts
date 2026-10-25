import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { resetDockerAvailabilityCache, setDockerAvailableForTest } from '../config/benchmarkContainer.js'
import { evaluateChatReadiness, readinessByCapability } from './chat-readiness.js'

const envKeys = [
  'BABEL_EXECUTION_PROFILE',
  'BABEL_REQUIRE_CLEAN_TREE',
  'BABEL_DIRTY_TREE',
  'BABEL_DOCKER_DISABLE',
  'BABEL_ALLOW_HOST_FALLBACK',
  'BABEL_BENCHMARK_DOCKER_IMAGE',
  'BABEL_BENCHMARK_DOCKER_EXTRA_ARGS',
] as const

function withEnv(
  t: TestContext,
  overrides: Record<string, string>,
  run: (root: string) => void,
): void {
  const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  const root = mkdtempSync(join(tmpdir(), 'babel-readiness-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const key of envKeys) delete process.env[key]
  Object.assign(process.env, { BABEL_EXECUTION_PROFILE: 'dev_local', BABEL_DOCKER_DISABLE: 'true' }, overrides)
  let gitRepo = true
  t.mock.method(childProcess, 'spawnSync', (command: string, args: readonly string[]) => {
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
      return {
        pid: 1,
        output: ['', gitRepo ? 'true\n' : 'false\n', ''],
        stdout: gitRepo ? 'true\n' : 'false\n',
        stderr: '',
        status: 0,
        signal: null,
      }
    }
    if (command === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
      const stdout = process.env['BABEL_DIRTY_TREE'] === '1' || process.env['BABEL_TEST_GIT_DIRTY'] === '1'
        ? ' M src/target.ts\n'
        : ''
      return { pid: 1, output: ['', stdout, ''], stdout, stderr: '', status: 0, signal: null }
    }
    return childProcess.spawnSync(command, [...args])
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    resetDockerAvailabilityCache()
    for (const key of envKeys) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
  })
  try {
    run(root)
  } finally {
    delete process.env['BABEL_TEST_GIT_DIRTY']
  }
}

test('clean Git host profile: shell and file edit ready, sandbox not required', t => {
  withEnv(t, { BABEL_DIRTY_TREE: '0' }, root => {
    const items = evaluateChatReadiness({ projectRoot: root, env: process.env })
    assert.equal(readinessByCapability(items, 'run_shell')?.ready, true)
    assert.equal(readinessByCapability(items, 'native_file_edit')?.ready, true)
    assert.equal(readinessByCapability(items, 'sandbox_isolation')?.reasonCode, 'SANDBOX_NOT_REQUIRED')
  })
})

test('safe_repo without image: sandbox probe fails closed without host grant', t => {
  withEnv(t, {
    BABEL_EXECUTION_PROFILE: 'safe_repo',
    BABEL_DOCKER_DISABLE: 'false',
    BABEL_ALLOW_HOST_FALLBACK: '0',
  }, root => {
    const sandbox = readinessByCapability(
      evaluateChatReadiness({ projectRoot: root, env: process.env }),
      'sandbox_isolation',
    )
    assert.equal(sandbox?.ready, false)
    assert.equal(sandbox?.reasonCode, 'SANDBOX_PROBE_FAILED')
    assert.equal(readinessByCapability(evaluateChatReadiness({ projectRoot: root, env: process.env }), 'run_shell')?.ready, false)
  })
})

test('safe_repo with docker image and probe: sandbox ready', t => {
  withEnv(t, {
    BABEL_EXECUTION_PROFILE: 'safe_repo',
    BABEL_DOCKER_DISABLE: 'false',
    BABEL_BENCHMARK_DOCKER_IMAGE: 'fixture/image:test',
  }, root => {
    setDockerAvailableForTest(true)
    const sandbox = readinessByCapability(
      evaluateChatReadiness({ projectRoot: root, env: process.env }),
      'sandbox_isolation',
    )
    assert.equal(sandbox?.ready, true)
  })
})

test('explicit host escalation grant allows shell when docker absent', t => {
  withEnv(t, {
    BABEL_EXECUTION_PROFILE: 'safe_repo',
    BABEL_ALLOW_HOST_FALLBACK: '1',
    BABEL_DIRTY_TREE: '0',
  }, root => {
    const shell = readinessByCapability(
      evaluateChatReadiness({ projectRoot: root, env: process.env }),
      'run_shell',
    )
    assert.equal(shell?.ready, true)
  })
})

test('non-Git root blocks shell readiness', t => {
  const root = mkdtempSync(join(tmpdir(), 'babel-readiness-nogit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const prior = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  Object.assign(process.env, { BABEL_EXECUTION_PROFILE: 'dev_local', BABEL_DOCKER_DISABLE: 'true' })
  t.mock.method(childProcess, 'spawnSync', (command: string, args: readonly string[]) => {
    if (command === 'git' && args[0] === 'rev-parse') {
      return { pid: 1, output: ['', 'false\n', ''], stdout: 'false\n', stderr: '', status: 0, signal: null }
    }
    return childProcess.spawnSync(command, [...args])
  })
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    for (const key of envKeys) {
      if (prior[key] === undefined) delete process.env[key]
      else process.env[key] = prior[key]
    }
  })
  const items = evaluateChatReadiness({ projectRoot: root, env: process.env })
  assert.equal(readinessByCapability(items, 'run_shell')?.reasonCode, 'NON_GIT_PROJECT_ROOT')
})

test('alternate_native_edit_succeeds_without_shell when shell blocked', t => {
  withEnv(t, {
    BABEL_EXECUTION_PROFILE: 'safe_repo',
    BABEL_DOCKER_DISABLE: 'false',
    BABEL_ALLOW_HOST_FALLBACK: '0',
    BABEL_DIRTY_TREE: '0',
  }, root => {
    const items = evaluateChatReadiness({
      projectRoot: root,
      env: process.env,
      mutationTargets: ['src/helper.ts'],
      allowsFileOnlyAlternate: true,
    })
    assert.equal(readinessByCapability(items, 'run_shell')?.ready, false)
    assert.equal(readinessByCapability(items, 'native_file_edit')?.ready, true)
  })
})

test('required_execution_requests_prerequisite blocks file-only completion', t => {
  withEnv(t, {
    BABEL_EXECUTION_PROFILE: 'safe_repo',
    BABEL_DOCKER_DISABLE: 'false',
    BABEL_ALLOW_HOST_FALLBACK: '0',
  }, root => {
    const file = readinessByCapability(
      evaluateChatReadiness({
        projectRoot: root,
        env: process.env,
        requiresShellExecution: true,
        allowsFileOnlyAlternate: false,
      }),
      'native_file_edit',
    )
    assert.equal(file?.ready, false)
    assert.equal(file?.reasonCode, 'REQUIRED_EXECUTION_PREREQUISITE')
  })
})
