import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resetDockerAvailabilityCache, setDockerAvailableForTest } from './config/benchmarkContainer.js'
import { SafeExecutor, getTrustedShellExecutionBackend } from './sandbox.js'
import { isProcessAlive, waitForProcessExit } from './processTree.js'

const environmentNames = [
  'PATH', 'Path', 'BABEL_EXECUTION_PROFILE', 'BABEL_BENCHMARK_DOCKER_IMAGE',
  'BABEL_BENCHMARK_DOCKER_EXTRA_ARGS', 'BABEL_ALLOW_HOST_FALLBACK', 'BABEL_DOCKER_DISABLE',
] as const

function fixture(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-readiness-'))
  const previous = environmentNames.map(name => [name, process.env[name]] as const)
  for (const name of environmentNames.filter(name => name.startsWith('BABEL_'))) delete process.env[name]
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  t.after(async () => {
    try {
      // A sync timeout can leave this single-process fixture behind cmd.exe
      // on Windows. Stop only its recorded PID before removing its cwd.
      const pidPath = join(root, 'partial.pid')
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, 'utf8').trim())
        assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid)
        if (isProcessAlive(pid)) {
          try { process.kill(pid, 'SIGKILL') } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
          assert.equal(await waitForProcessExit(pid, 5_000), true, 'owned fixture must exit before directory cleanup')
        }
      }
      rmSync(root, { recursive: true, force: true })
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      resetDockerAvailabilityCache()
    }
  })
  return root
}

test('owned timeout fixture exits before teardown removes its working directory', async t => {
  let root = ''
  let child: ReturnType<typeof spawn> | undefined
  let closed: ReturnType<typeof once> | undefined
  try {
    await t.test('record an owned sleeper', async t => {
      root = fixture(t)
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: root, stdio: 'ignore', env: { SystemRoot: process.env['SystemRoot'] },
      })
      await once(child, 'spawn')
      closed = once(child, 'close')
      assert.ok(child.pid)
      writeFileSync(join(root, 'partial.pid'), String(child.pid))
      assert.equal(isProcessAlive(child.pid), true)
    })
    assert.ok(child?.pid)
    assert.equal(isProcessAlive(child.pid), false, 'fixture teardown must stop its recorded process')
    assert.equal(existsSync(root), false)
  } finally {
    // Keep a failing cleanup regression from leaking its own direct child.
    child?.kill('SIGKILL')
    await closed
  }
})

for (const missing of ['docker', 'image'] as const) {
  test(`safe_repo reports missing ${missing} before looking for a container tool on the host`, async t => {
    const root = fixture(t)
    process.env['PATH'] = root
    process.env['Path'] = root
    if (missing === 'docker') process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'fixture/sandbox:local'
    setDockerAvailableForTest(missing !== 'docker')
    writeFileSync(join(root, 'keep.txt'), 'original\n')
    const executor = new SafeExecutor(root)
    for (const result of [
      executor.shellExec('python3 --version', '.', 1_000),
      await executor.shellExecAsync('python3 --version', '.', 1_000),
    ]) {
      assert.equal(result.denial?.reason_code, 'isolation_unavailable')
      assert.match(result.stderr, missing === 'docker' ? /Docker/i : /BABEL_BENCHMARK_DOCKER_IMAGE/)
      assert.notEqual(result.exit_code, 0)
      assert.notEqual(result.process_started, true)
      assert.equal(getTrustedShellExecutionBackend(result), undefined)
      assert.equal(result.launch_failure, undefined)
    }
    assert.deepEqual(readdirSync(root), ['keep.txt'])
    assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'original\n')
  })
}

test('sync timeout retains partial effects and reports timed_out instead of a generic termination', t => {
  const root = fixture(t)
  // Owned host supervisor fixture only; this does not qualify safe_repo on Docker.
  process.env['BABEL_EXECUTION_PROFILE'] = 'dev_local'
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  writeFileSync(join(root, 'partial.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    "writeFileSync('partial.pid', String(process.pid))",
    "writeFileSync('partial.txt', 'effect before timeout\\n')",
    "process.stdout.write('started\\n')",
    "process.on('SIGTERM', () => process.exit(0))",
    'setInterval(() => {}, 1000)',
  ].join('\n'))
  const result = new SafeExecutor(root).testRun('node partial.mjs', '.', 1_000)
  assert.equal(result.process_started, true)
  assert.match(result.stdout, /started/)
  assert.equal(readFileSync(join(root, 'partial.txt'), 'utf8'), 'effect before timeout\n')
  assert.notEqual(result.exit_code, 0, 'a SIGTERM handler exiting zero is not verifier success')
  assert.equal(result.launch_failure, undefined, 'a started command is not a missing tool')
  assert.equal(result.process_termination, 'timed_out')
})
