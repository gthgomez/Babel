// License: Apache-2.0 - see LICENSE
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createRequire } from 'node:module'

const root = new URL('../../', import.meta.url)
const { load } = createRequire(new URL('babel-cli/package.json', root))('js-yaml')
const workflow = load(readFileSync(new URL('.github/workflows/typecheck.yml', root), 'utf8'))
const bundled = readFileSync(new URL('tools/validate-public-release.ps1', root), 'utf8')

function assertReleaseValidation(candidate) {
  const job = candidate.jobs['public-release-validation']
  assert.ok(job, 'strict public-release validations need their own CI job')
  assert.equal(job.if, undefined)
  assert.equal(job['continue-on-error'], undefined)
  const commands = job.steps.map(step => step.run ?? '').join('\n')
  for (const unique of ['validate-catalog.ps1', 'check-public-identity.ps1']) {
    assert.ok(bundled.includes(unique), `${unique} must remain part of the strict bundle`)
    assert.ok(commands.includes(unique), `${unique} must run in the gated CI job`)
  }
  assert.equal((commands.match(/resolve-local-stack\.ps1 -TaskCategory backend/g) ?? []).length, 1)
  assert.equal((commands.match(/resolve-local-stack\.ps1 -TaskCategory mobile/g) ?? []).length, 1)
  assert.doesNotMatch(commands, /npm (?:ci|run typecheck)/, 'the job must not repeat required typecheck/install work')
  for (const gate of ['linux-validation', 'windows-portability']) {
    assert.ok(candidate.jobs[gate].needs.includes('public-release-validation'), `${gate} must gate release validation`)
  }
}

test('strict public-release unique validations are gated by the Linux aggregate', () => {
  assertReleaseValidation(workflow)
})

for (const [label, mutate] of [
  ['missing job', w => { delete w.jobs['public-release-validation'] }],
  ['tolerated failure', w => { w.jobs['public-release-validation']['continue-on-error'] = true }],
  ['skipped job', w => { w.jobs['public-release-validation'].if = 'false' }],
  ['missing catalog check', w => { w.jobs['public-release-validation'].steps = w.jobs['public-release-validation'].steps.filter(step => !step.run?.includes('validate-catalog.ps1')) }],
  ['missing identity check', w => { w.jobs['public-release-validation'].steps = w.jobs['public-release-validation'].steps.filter(step => !step.run?.includes('check-public-identity.ps1')) }],
  ['delta-only resolver coverage', w => { w.jobs['public-release-validation'].steps.find(step => step.run?.includes('resolve-local-stack.ps1')).run = 'pwsh -NoProfile -ExecutionPolicy Bypass -File tools/resolve-local-stack.ps1 -TaskCategory backend -Project example_saas_backend -Model codex -PipelineMode deep -Format json' }],
  ['duplicate install/typecheck', w => { w.jobs['public-release-validation'].steps.push({ run: 'npm ci' }) }],
  ['ungated job', w => { w.jobs['linux-validation'].needs = w.jobs['linux-validation'].needs.filter(name => name !== 'public-release-validation') }],
]) {
  test(`release validation ${label} fails closed`, () => {
    const changed = structuredClone(workflow)
    mutate(changed)
    assert.throws(() => assertReleaseValidation(changed))
  })
}
