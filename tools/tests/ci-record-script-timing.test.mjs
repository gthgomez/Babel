import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const wrapper = fileURLToPath(new URL('../ci-record-script-timing.ps1', import.meta.url))

const candidateHead = 'a'.repeat(40)
const checkoutHead = 'b'.repeat(40)

function runWrapper(sidecar, scriptLabel, invokeJson, env = {}, childScriptBody = null) {
  const root = mkdtempSync(join(tmpdir(), 'babel-script-timing-'))
  let invoke = invokeJson
  if (childScriptBody !== null) {
    const child = join(root, 'child.ps1')
    writeFileSync(child, childScriptBody, 'utf8')
    invoke = JSON.stringify(['pwsh', '-NoProfile', '-File', child])
  }
  try {
    const result = spawnSync('pwsh', [
      '-NoProfile', '-File', wrapper,
      '-SidecarPath', sidecar,
      '-Script', scriptLabel,
      '-InvokeJson', invoke,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_RUN_ID: '41312222977',
        GITHUB_RUN_ATTEMPT: '1',
        BABEL_CI_MATRIX_OS: 'windows-latest',
        BABEL_CI_CANDIDATE_HEAD: candidateHead,
        BABEL_CI_CHECKOUT_HEAD: checkoutHead,
        ...env,
      },
    })
    let sidecarText = ''
    try {
      sidecarText = readFileSync(sidecar, 'utf8')
    } catch {
      sidecarText = ''
    }
    return { ...result, sidecar: sidecarText }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function lastRow(result) {
  const lines = result.sidecar.trim().split('\n').filter(Boolean)
  assert.ok(lines.length >= 1, 'expected sidecar row')
  return JSON.parse(lines.at(-1))
}

test('records whole-script timing and preserves success exit code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-sidecar-'))
  const sidecar = join(dir, 'timing.jsonl')
  const result = runWrapper(sidecar, 'tools/tests/example.ps1', null, {}, '$null')
  assert.equal(result.status, 0, result.stderr)
  const row = lastRow(result)
  assert.equal(row.schema, 'babel-ci-script-timing-v1')
  assert.equal(row.measurementScope, 'whole-script')
  assert.equal(row.script, 'tools/tests/example.ps1')
  assert.equal(row.exitCode, 0)
  assert.equal(row.candidateHead, candidateHead)
  assert.equal(row.checkoutHead, checkoutHead)
  assert.equal(String(row.runId), '41312222977')
  assert.equal(String(row.runAttempt), '1')
  assert.equal(row.os, 'windows-latest')
  assert.ok(Number.isFinite(row.elapsedSeconds))
  rmSync(dir, { recursive: true, force: true })
})

test('records timing on failure and preserves nonzero exit without masking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-sidecar-fail-'))
  const sidecar = join(dir, 'timing.jsonl')
  const result = runWrapper(sidecar, 'tools/tests/fail.ps1', null, {}, 'exit 7')
  assert.equal(result.status, 7, result.stderr)
  const row = lastRow(result)
  assert.equal(row.exitCode, 7)
  assert.equal(row.measurementScope, 'whole-script')
  rmSync(dir, { recursive: true, force: true })
})

test('missing executable never exits zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-sidecar-missing-'))
  const sidecar = join(dir, 'timing.jsonl')
  const invokeJson = JSON.stringify(['babel-ci-nonexistent-command-probe-xyz'])
  const result = runWrapper(sidecar, 'tools/tests/missing.ps1', invokeJson)
  assert.notEqual(result.status, 0, result.stderr)
  const row = lastRow(result)
  assert.notEqual(row.exitCode, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('malformed InvokeJson exits nonzero without running child', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-sidecar-badjson-'))
  const sidecar = join(dir, 'timing.jsonl')
  const result = runWrapper(sidecar, 'tools/tests/bad.ps1', '{not-json')
  assert.notEqual(result.status, 0, result.stderr)
  assert.equal(result.sidecar.trim(), '')
  rmSync(dir, { recursive: true, force: true })
})

test('sidecar write failure surfaces on child success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-sidecar-write-ok-'))
  mkdirSync(join(dir, 'blocked'), { recursive: true })
  const sidecar = join(dir, 'blocked')
  const result = runWrapper(sidecar, 'tools/tests/example.ps1', null, {}, '$null')
  assert.notEqual(result.status, 0, result.stderr)
  rmSync(dir, { recursive: true, force: true })
})

test('sidecar write failure does not mask child nonzero exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'babel-sidecar-write-fail-'))
  mkdirSync(join(dir, 'blocked'), { recursive: true })
  const sidecar = join(dir, 'blocked')
  const result = runWrapper(sidecar, 'tools/tests/fail.ps1', null, {}, 'exit 7')
  assert.equal(result.status, 7, result.stderr)
  rmSync(dir, { recursive: true, force: true })
})
