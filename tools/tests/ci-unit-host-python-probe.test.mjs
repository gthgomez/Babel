import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { HOST_PYTHON_UNIT_PATHS, probeUnitShardHostPython } from '../../babel-cli/scripts/ci_unit_host_python_probe.mjs'

test('probe is a no-op when shard selection has no host-python integration tests', () => {
  const { env, record } = probeUnitShardHostPython(['src/other.test.ts'])
  assert.deepEqual(env, {})
  assert.equal(record.required, false)
})

test('probe preserves an explicit BABEL_WORKSPACE_PYTHON without overriding it', () => {
  const interpreter = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim()
  assert.ok(interpreter)
  const { env, record } = probeUnitShardHostPython(HOST_PYTHON_UNIT_PATHS, {
    ...process.env,
    BABEL_WORKSPACE_PYTHON: interpreter,
  })
  assert.deepEqual(env, {})
  assert.equal(record.configuredInterpreter, interpreter)
  assert.equal(record.configuredWorks, true)
  assert.equal(record.resolved, `env:${interpreter}`)
  assert.ok(!('BABEL_WORKSPACE_PYTHON' in env))
})

test('probe does not auto-discover when explicit binding is present', () => {
  const { env, record } = probeUnitShardHostPython(HOST_PYTHON_UNIT_PATHS, {
    ...process.env,
    BABEL_WORKSPACE_PYTHON: '/nonexistent/babel/python-should-not-auto-fallback',
  })
  assert.deepEqual(env, {})
  assert.equal(record.configuredWorks, false)
  assert.equal(record.resolved, null)
  assert.match(record.coordinatorAction ?? '', /Configured BABEL_WORKSPACE_PYTHON/)
  assert.ok(!('BABEL_WORKSPACE_PYTHON' in env))
})
