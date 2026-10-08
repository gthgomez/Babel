import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const { load } = createRequire(new URL('../../babel-cli/package.json', import.meta.url))('js-yaml')

for (const name of ['release', 'publish-npm']) test(`${name} resolves trusted tag identity before executing project lifecycle code`, () => {
  const workflow = load(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
  const job = Object.values(workflow.jobs)[0]
  const checkouts = job.steps.filter(step => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkouts.length, 2)
  assert.equal(checkouts[0].with.ref, '${{ github.workflow_sha }}')
  assert.equal(checkouts[1].with.ref, '${{ steps.tag.outputs.source_sha }}')
  assert.ok(checkouts.every(step => step.with['persist-credentials'] === false))
  const resolve = job.steps.findIndex(step => step.id === 'tag')
  const lifecycle = job.steps.findIndex(step => step.run?.includes('npm --prefix'))
  const verify = job.steps.findIndex(step => step.name?.startsWith('Verify frozen source'))
  assert.ok(resolve >= 0 && resolve < verify && verify < lifecycle)
  const recheck = job.steps.findIndex(step => step.name?.startsWith('Revalidate tag object'))
  const promote = job.steps.findIndex(step => step.name?.startsWith(name === 'release' ? 'Create draft' : 'Publish the validated'))
  assert.ok(recheck > lifecycle && recheck < promote)
  assert.match(job.steps[recheck].run, /RUNNER_TEMP\/resolve-release-tag\.mjs/)
})
test('dry run and publication share validation, exact bytes and a registry integrity comparison', () => {
  const workflow = load(readFileSync(new URL('../../.github/workflows/publish-npm.yml', import.meta.url), 'utf8'))
  const steps = workflow.jobs.publish.steps
  assert.match(steps.find(s => s.id === 'pack').run, /run package:release/)
  const promotion = steps.find(s => s.name.startsWith('Publish the validated'))
  assert.match(promotion.run, /Get-FileHash/)
  assert.match(promotion.run, /npm publish \$archive .*--ignore-scripts/)
  assert.match(steps.find(s => s.name === 'Verify publication').run, /EXPECTED_INTEGRITY/)
})
