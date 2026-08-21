/**
 * Adversarial regressions: candidate-state fidelity in the clean-room grader.
 *
 * Pre-fix defect: deleted production paths were omitted from the candidate
 * representation (captureProductionFiles skipped missing files), so the
 * clean-room baseline RESURRECTED them before running the oracle. A live
 * agent could delete an already-correct file, claim success, and score as
 * NO_CHANGE_REQUIRED success (production_mutated=false, hidden_ok=true).
 *
 * These tests cross the real fs → capture → grader boundaries using the
 * shipped canary catalog, not synthetic mirrors of it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { gradeInCleanRoom, type CleanRoomFile } from './cleanRoomGrade.js'
import {
  captureProductionState,
  materializeCanaryWorkspace,
} from './canary/liveCell.js'
import { contractSuccess } from './canary/runner.js'
import { getCanaryTask } from './canary/tasks.js'

function withWorkspace<T>(specId: string, run: (root: string) => T): T {
  const root = join(tmpdir(), `babel-deletion-regression-${specId}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  materializeCanaryWorkspace(getCanaryTask(specId), root)
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const HIDDEN_ADD = getCanaryTask('C08').oracle_test

test('C08 destructive deletion must fail and never classify as NO_CHANGE success', () => {
  withWorkspace('C08', (root) => {
    // Adversarial candidate: delete the already-correct production file.
    rmSync(join(root, 'src', 'add.js'))

    const captured = captureProductionState(getCanaryTask('C08'), root)
    assert.deepEqual(captured.deletedPaths, ['src/add.js'])
    assert.equal(captured.files.length, 0)

    // Mutation signal must include deletions — no false "nothing changed".
    const mutated =
      captured.files.some((f) => f.contents !== getCanaryTask('C08').files[0]!.start) ||
      captured.deletedPaths.length > 0
    assert.equal(mutated, true, 'deletion must count as a mutation')

    const grade = gradeInCleanRoom({
      startFiles: [{ relativePath: 'src/add.js', contents: getCanaryTask('C08').files[0]!.start }],
      candidateDiffFiles: [],
      candidateDeletedPaths: captured.deletedPaths,
      oracleFiles: [{ relativePath: 'hidden.test.mjs', contents: HIDDEN_ADD }],
      verifierCommand: [process.execPath, 'hidden.test.mjs'],
    })
    assert.equal(
      grade.hidden_ok,
      false,
      'resurrecting the deleted file would let destructive deletion pass',
    )
    assert.deepEqual(grade.deletions_applied, ['src/add.js'])

    // And under the shipped contract, this is not a NO_CHANGE success.
    const row = {
      hidden_ok: grade.hidden_ok,
      false_complete: false,
      honest_block: false,
      production_mutated: mutated,
      claimed_complete: true,
    }
    assert.equal(contractSuccess(getCanaryTask('C08'), row), false)
  })
})

test('C02 multi-file task: deleting one required production file reaches the grader', () => {
  withWorkspace('C02', (root) => {
    const spec = getCanaryTask('C02')
    const secondPath = spec.production_paths[1]!
    rmSync(join(root, secondPath))

    const captured = captureProductionState(spec, root)
    assert.ok(captured.deletedPaths.includes(secondPath))

    // Gold for the remaining file + deletion of the other: oracle must fail
    // because the graded tree faithfully omits the deleted module.
    const gold = spec.files
      .filter((f) => typeof f.gold === 'string' && f.relativePath !== secondPath)
      .map((f) => ({ relativePath: f.relativePath, contents: f.gold as string }))
    const grade = gradeInCleanRoom({
      startFiles: spec.files.map((f) => ({ relativePath: f.relativePath, contents: f.start })),
      candidateDiffFiles: gold,
      candidateDeletedPaths: captured.deletedPaths,
      oracleFiles: [{ relativePath: 'hidden.test.mjs', contents: spec.oracle_test }],
      verifierCommand: [process.execPath, 'hidden.test.mjs'],
    })
    assert.equal(grade.hidden_ok, false)
    assert.deepEqual(grade.deletions_applied, [secondPath])
  })
})

test('modified production file still grades correctly through the same path', () => {
  withWorkspace('C01', (root) => {
    const spec = getCanaryTask('C01')
    writeFileSync(join(root, spec.production_paths[0]!), spec.files[0]!.gold!, 'utf8')

    const captured = captureProductionState(spec, root)
    assert.deepEqual(captured.deletedPaths, [])
    const changed = captured.files.filter((f) => {
      const start = spec.files.find((s) => s.relativePath === f.relativePath)?.start
      return start !== f.contents
    })
    assert.equal(changed.length, 1)

    const grade = gradeInCleanRoom({
      startFiles: spec.files.map((f) => ({ relativePath: f.relativePath, contents: f.start })),
      candidateDiffFiles: changed,
      candidateDeletedPaths: captured.deletedPaths,
      oracleFiles: [{ relativePath: 'hidden.test.mjs', contents: spec.oracle_test }],
      verifierCommand: [process.execPath, 'hidden.test.mjs'],
    })
    assert.equal(grade.hidden_ok, true)
    assert.deepEqual(grade.deletions_applied, [])
  })
})

test('unchanged baseline captures as unchanged with no deletions', () => {
  withWorkspace('C08', (root) => {
    const spec = getCanaryTask('C08')
    const captured = captureProductionState(spec, root)
    assert.deepEqual(captured.deletedPaths, [])
    assert.equal(captured.files.length, 1)
    assert.equal(captured.files[0]!.contents, spec.files[0]!.start)
  })
})

test('legitimate reference solution still passes with deletion plumbing present', () => {
  withWorkspace('C01', (root) => {
    const spec = getCanaryTask('C01')
    const grade = gradeInCleanRoom({
      startFiles: spec.files.map((f) => ({ relativePath: f.relativePath, contents: f.start })),
      candidateDiffFiles: spec.files
        .filter((f) => typeof f.gold === 'string')
        .map((f) => ({ relativePath: f.relativePath, contents: f.gold as string })),
      candidateDeletedPaths: [],
      oracleFiles: [{ relativePath: 'hidden.test.mjs', contents: spec.oracle_test }],
      verifierCommand: [process.execPath, 'hidden.test.mjs'],
    })
    assert.equal(grade.hidden_ok, true)
  })
})

test('newly created required production file reaches the clean room', () => {
  // Production path declared but absent at start; implementation creates it.
  const createdSpec = getCanaryTask('C08')
  const extraRel = 'src/add.generated.js'
  const root = join(tmpdir(), `babel-addition-${Date.now()}`)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'add.js'), createdSpec.files[0]!.start, 'utf8')
  try {
    // Candidate ADDS a generated helper that the oracle imports transitively.
    const captured = captureProductionState(createdSpec, root)
    assert.deepEqual(captured.deletedPaths, [])

    const additions: CleanRoomFile[] = [
      { relativePath: extraRel, contents: 'export const addVersion = 2\n' },
    ]
    const oracle = `${HIDDEN_ADD}\nimport { addVersion } from "./src/add.generated.js";\nif (addVersion !== 2) process.exit(1);\n`
    const grade = gradeInCleanRoom({
      startFiles: [{ relativePath: 'src/add.js', contents: createdSpec.files[0]!.start }],
      candidateDiffFiles: additions,
      oracleFiles: [{ relativePath: 'hidden.test.mjs', contents: oracle }],
      verifierCommand: [process.execPath, 'hidden.test.mjs'],
    })
    assert.equal(grade.hidden_ok, true, 'candidate additions must be materialized for grading')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('grader refuses a path that is both captured and marked deleted', () => {
  assert.throws(
    () =>
      gradeInCleanRoom({
        startFiles: [{ relativePath: 'src/a.js', contents: 'a\n' }],
        candidateDiffFiles: [{ relativePath: 'src/a.js', contents: 'b\n' }],
        candidateDeletedPaths: ['src/a.js'],
        oracleFiles: [],
        verifierCommand: ['node', '-e', 'process.exit(0)'],
      }),
    /integrity/,
  )
})
