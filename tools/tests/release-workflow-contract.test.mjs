import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { assertTrustedPublishingNpm } from '../check-npm-trusted-publishing.mjs'
const { load } = createRequire(new URL('../../babel-cli/package.json', import.meta.url))('js-yaml')

test('publisher toolchain guards OIDC after frozen source verification and before promotion', () => {
  const publisher = load(readFileSync(new URL('../../.github/workflows/publish-npm.yml', import.meta.url), 'utf8'))
  const producer = load(readFileSync(new URL('../../.github/workflows/typecheck.yml', import.meta.url), 'utf8'))
  const steps = publisher.jobs.publish.steps
  const setup = steps.findIndex(step => step.uses?.startsWith('actions/setup-node@'))
  const verify = steps.findIndex(step => step.name?.startsWith('Verify frozen source'))
  const guard = steps.findIndex(step => step.name === 'Verify npm trusted publishing support')
  const pack = steps.findIndex(step => step.id === 'pack')
  assert.equal(steps[setup].with['node-version'], '24.13.1')
  assert.ok(guard > setup && guard > verify && guard < pack)
  assert.equal(steps[guard].run, 'node tools/check-npm-trusted-publishing.mjs')
  const candidate = producer.jobs['consumer-candidate']
  assert.equal(candidate.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'], '22.19.0')
  const tools = producer.jobs['architecture-regressions'].steps.map(step => step.run ?? '').join('\n')
  for (const name of ['qualified-consumer-promotion', 'package-metadata-drift']) {
    assert.ok(tools.includes(`tools/tests/${name}.test.mjs`))
  }
})

test('trusted publishing npm minimum rejects incompatible and unverifiable versions', () => {
  for (const version of ['10.9.3', '11.4.9', '11.5.0', '11.5.1-beta.0', 'unknown']) {
    assert.throws(() => assertTrustedPublishingNpm(version))
  }
  for (const version of ['11.5.1', '11.9.0\n', '12.0.0']) assert.doesNotThrow(() => assertTrustedPublishingNpm(version))
})

for (const name of ['release', 'publish-npm']) test(`${name} resolves trusted tag identity before executing project lifecycle code`, () => {
  const workflow = load(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
  const job = Object.values(workflow.jobs)[0]
  const checkouts = job.steps.filter(step => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkouts.length, 2)
  assert.equal(checkouts[0].with.ref, '${{ github.workflow_sha }}')
  assert.equal(checkouts[1].with.ref, '${{ steps.tag.outputs.source_sha }}')
  assert.ok(checkouts.every(step => step.with['persist-credentials'] === false))
  const resolve = job.steps.findIndex(step => step.id === 'tag')
  const lifecycle = name === 'publish-npm'
    ? job.steps.findIndex(step => step.id === 'pack')
    : job.steps.findIndex(step => step.run?.includes('npm --prefix'))
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
  assert.match(steps.find(s => s.id === 'pack').run, /qualified-consumer-promotion\.mjs/)
  const promotion = steps.find(s => s.name.startsWith('Publish the validated'))
  assert.match(promotion.run, /Get-FileHash/)
  assert.match(promotion.run, /npm publish \$archive .*--ignore-scripts/)
  assert.match(steps.find(s => s.name === 'Verify publication').run, /EXPECTED_INTEGRITY/)
  assert.equal(workflow.permissions['actions'], 'read')
})
