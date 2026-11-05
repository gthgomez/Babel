import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resetDockerAvailabilityCache, setDockerAvailableForTest } from './config/benchmarkContainer.js'
import { SafeExecutor, getTrustedShellExecutionBackend } from './sandbox.js'

const environmentNames = [
  'PATH', 'Path', 'BABEL_EXECUTION_PROFILE', 'BABEL_BENCHMARK_DOCKER_IMAGE',
  'BABEL_BENCHMARK_DOCKER_EXTRA_ARGS', 'BABEL_ALLOW_HOST_FALLBACK', 'BABEL_DOCKER_DISABLE',
] as const

function fixture(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'babel-readiness-'))
  const previous = environmentNames.map(name => [name, process.env[name]] as const)
  for (const name of environmentNames.filter(name => name.startsWith('BABEL_'))) delete process.env[name]
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    resetDockerAvailabilityCache()
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

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
