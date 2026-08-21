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
