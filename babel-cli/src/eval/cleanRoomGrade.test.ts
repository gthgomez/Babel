import assert from 'node:assert/strict'
import test from 'node:test'

import { gradeInCleanRoom } from './cleanRoomGrade.js'

test('clean-room hidden tests fail on baseline and pass after gold production edit', () => {
  const start = [
    { relativePath: 'add.js', contents: 'export function add(a, b) { return a - b }\n' },
  ]
  const oracle = [
    {
      relativePath: 'hidden.test.mjs',
      contents:
        "import assert from 'node:assert/strict'\nimport { add } from './add.js'\nassert.equal(add(2, 2), 4)\n",
    },
  ]
  const cmd = [process.execPath, 'hidden.test.mjs']
  const baseline = gradeInCleanRoom({
    startFiles: start,
    candidateDiffFiles: [],
    oracleFiles: oracle,
    verifierCommand: cmd,
  })
  assert.equal(baseline.hidden_ok, false)
  const gold = gradeInCleanRoom({
    startFiles: start,
    candidateDiffFiles: [
      { relativePath: 'add.js', contents: 'export function add(a, b) { return a + b }\n' },
    ],
    oracleFiles: oracle,
    verifierCommand: cmd,
  })
  assert.equal(gold.hidden_ok, true)
})

test('agent-mutated package.json cannot change harness-owned verifier command', () => {
  const start = [
    { relativePath: 'add.js', contents: 'export function add(a, b) { return a - b }\n' },
    {
      relativePath: 'package.json',
      contents: JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    },
  ]
  const sabotage = [
    {
      relativePath: 'package.json',
      contents: JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    },
  ]
  const oracle = [
    {
      relativePath: 'hidden.test.mjs',
      contents:
        "import assert from 'node:assert/strict'\nimport { add } from './add.js'\nassert.equal(add(2, 2), 4)\n",
    },
  ]
  const graded = gradeInCleanRoom({
    startFiles: start,
    candidateDiffFiles: sabotage,
    oracleFiles: oracle,
    verifierCommand: [process.execPath, 'hidden.test.mjs'],
  })
  assert.equal(graded.hidden_ok, false)
})

// Process-dispatch controls exercise the actual grader tree without contacting Docker.
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import type { CleanRoomGradeInput } from './cleanRoomGrade.js'

const pinnedGraderImage = 'node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7'

function isolatedInput(): CleanRoomGradeInput {
  return {
    startFiles: [{ relativePath: 'add.js', contents: 'export const add = (a, b) => a - b\n' }],
    candidateDiffFiles: [{ relativePath: 'add.js', contents: 'export const add = (a, b) => a + b\n' }],
    oracleFiles: [{ relativePath: 'hidden.test.mjs', contents: 'throw new Error("untrusted code must not run on host")\n' }],
    verifierCommand: ['node', '--test', 'hidden.test.mjs'],
    execution: { kind: 'docker', image: pinnedGraderImage },
  } as CleanRoomGradeInput
}

test('explicit isolated grading dispatches the fresh grader tree only through existing hardened Docker argv', t => {
  let executable = ''
  let argv: readonly string[] = []
  let dispatchCwd: string | undefined
  t.mock.method(childProcess, 'spawnSync', ((command: string, args: readonly string[], options: childProcess.SpawnSyncOptions) => {
    executable = command
    argv = args
    dispatchCwd = options.cwd?.toString()
    return { status: 0, stdout: 'controlled verifier output', stderr: '', pid: 0, signal: null, output: [] }
  }))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const grade = gradeInCleanRoom(isolatedInput())
  assert.equal(executable, 'docker')
  assert.equal(argv.includes(pinnedGraderImage), true)
  assert.equal(argv[argv.indexOf('--network') + 1], 'none')
  assert.equal(argv.includes('--cap-drop=ALL'), true)
  assert.equal(argv.includes('--security-opt=no-new-privileges'), true)
  assert.equal(argv[argv.indexOf('-w') + 1], '/app')
  assert.equal(dispatchCwd, grade.grader_root)
  assert.equal(argv.includes(grade.grader_root.replace(/\\/g, '/') + ':/app'), true)
  assert.equal(argv.slice(-3).join(' '), 'node --test hidden.test.mjs')
  assert.equal(grade.hidden_ok, true)
})

test('isolated grader Docker launch failure never retries candidate code on the host', t => {
  let calls = 0
  let executable = ''
  t.mock.method(childProcess, 'spawnSync', ((command: string) => {
    calls++
    executable = command
    return { status: null, stdout: '', stderr: '', pid: 0, signal: null, output: [], error: Object.assign(new Error('fixture unavailable'), { code: 'ENOENT' }) }
  }))
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const grade = gradeInCleanRoom(isolatedInput())
  assert.equal(executable, 'docker')
  assert.equal(calls, 1)
  assert.equal(grade.hidden_ok, false)
  assert.equal(grade.exit_code, 1)
})

test('isolated grading rejects mutable images, malformed targets and explicit host-fallback configuration before dispatch', t => {
  let calls = 0
  t.mock.method(childProcess, 'spawnSync', (() => { calls++; return { status: 0, stdout: '', stderr: '', pid: 0, signal: null, output: [] } }))
  syncBuiltinESMExports()
  const priorFallback = process.env['BABEL_ALLOW_HOST_FALLBACK']
  t.after(() => {
    if (priorFallback === undefined) delete process.env['BABEL_ALLOW_HOST_FALLBACK']
    else process.env['BABEL_ALLOW_HOST_FALLBACK'] = priorFallback
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const mutable = isolatedInput() as CleanRoomGradeInput & { execution: { kind: string; image: string } }
  mutable.execution.image = 'node:latest'
  assert.throws(() => gradeInCleanRoom(mutable), /isolated grader/i)
  const malformed = { ...isolatedInput(), execution: { kind: 'host', image: pinnedGraderImage } } as unknown as CleanRoomGradeInput
  assert.throws(() => gradeInCleanRoom(malformed), /isolated grader/i)
  process.env['BABEL_ALLOW_HOST_FALLBACK'] = '1'
  assert.throws(() => gradeInCleanRoom(isolatedInput()), /isolated grader/i)
  assert.equal(calls, 0)
})