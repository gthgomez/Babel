// License: Apache-2.0 - see LICENSE
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createRequire } from 'node:module'

const root = new URL('../../', import.meta.url)
const { load } = createRequire(new URL('babel-cli/package.json', root))('js-yaml')
const workflow = load(readFileSync(new URL('.github/workflows/typecheck.yml', root), 'utf8'))

function assertDeadCodeGate(candidate) {
  const job = candidate.jobs['architecture-regressions']
  assert.ok(job, 'architecture-regressions owns architecture and dead-code gates')
  const step = job.steps.find(item => item.run === 'npm run check:dead-code')
  assert.ok(step, 'dead-code ratchet must run as a required CI command')
  assert.equal(step.if, "matrix.os == 'ubuntu-latest'", 'file-graph ratchet runs once on Linux')
  assert.equal(step['working-directory'], 'babel-cli')
  assert.equal(step['continue-on-error'], undefined)
  assert.equal(step.shell, undefined, 'default shell must propagate the exit code')
  for (const gate of ['linux-validation', 'windows-portability']) {
    assert.ok(candidate.jobs[gate].needs.includes('architecture-regressions'), `${gate} must gate the ratchet`)
  }
}

test('W14 dead-code ratchet is a required architecture-regressions step', () => {
  assertDeadCodeGate(workflow)
})

for (const [label, mutate] of [
  ['missing step', w => { w.jobs['architecture-regressions'].steps = w.jobs['architecture-regressions'].steps.filter(step => step.run !== 'npm run check:dead-code') }],
  ['tolerated failure', w => { w.jobs['architecture-regressions'].steps.find(step => step.run === 'npm run check:dead-code')['continue-on-error'] = true }],
  ['skipped step', w => { w.jobs['architecture-regressions'].steps.find(step => step.run === 'npm run check:dead-code').if = 'false' }],
  ['wrong platform', w => { w.jobs['architecture-regressions'].steps.find(step => step.run === 'npm run check:dead-code').if = "matrix.os == 'windows-latest'" }],
  ['wrong working directory', w => { w.jobs['architecture-regressions'].steps.find(step => step.run === 'npm run check:dead-code')['working-directory'] = '.' }],
  ['echo instead of execution', w => { w.jobs['architecture-regressions'].steps.find(step => step.run === 'npm run check:dead-code').run = 'echo npm run check:dead-code' }],
  ['ungated architecture job', w => { w.jobs['linux-validation'].needs = w.jobs['linux-validation'].needs.filter(name => name !== 'architecture-regressions') }],
]) {
  test(`dead-code gate ${label} fails closed`, () => {
    const changed = structuredClone(workflow)
    mutate(changed)
    assert.throws(() => assertDeadCodeGate(changed))
  })
}
