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

function assertFrozenTagBeforeLifecycle(job, lifecycleName) {
  const checkouts = job.steps.filter(step => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkouts.length, 2)
  assert.equal(checkouts[0].with.ref, '${{ github.workflow_sha }}')
  assert.equal(checkouts[1].with.ref, '${{ steps.tag.outputs.source_sha }}')
  assert.ok(checkouts.every(step => step.with['persist-credentials'] === false))
  const resolve = job.steps.findIndex(step => step.id === 'tag')
  const lifecycle = job.steps.findIndex(step => step.id === 'pack' || step.run?.includes(lifecycleName))
  const verify = job.steps.findIndex(step => step.name?.startsWith('Verify frozen source'))
  assert.ok(resolve >= 0 && resolve < verify && verify < lifecycle)
  const recheck = job.steps.findIndex(step => step.name?.startsWith('Revalidate tag object'))
  assert.ok(recheck > lifecycle)
  assert.match(job.steps[recheck].run, /resolve-release-tag\.mjs/)
}

for (const name of ['release', 'publish-npm']) test(`${name} resolves trusted tag identity before executing project lifecycle code`, () => {
  const workflow = load(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))
  if (name === 'publish-npm') {
    const job = Object.values(workflow.jobs)[0]
    assertFrozenTagBeforeLifecycle(job, 'npm --prefix')
    const recheck = job.steps.findIndex(step => step.name?.startsWith('Revalidate tag object'))
    const promote = job.steps.findIndex(step => step.name?.startsWith('Publish the validated'))
    assert.ok(recheck < promote)
    assert.match(job.steps[recheck].run, /RUNNER_TEMP\/resolve-release-tag\.mjs/)
    return
  }
  for (const jobName of ['build-portable', 'build-linux']) {
    assertFrozenTagBeforeLifecycle(workflow.jobs[jobName], 'npm --prefix')
  }
  const draft = workflow.jobs['draft-release']
  const checkout = draft.steps.find(step => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout.with.ref, '${{ github.workflow_sha }}')
  assert.equal(checkout.with['persist-credentials'], false)
  const recheck = draft.steps.findIndex(step => step.name?.startsWith('Revalidate tag object'))
  const promote = draft.steps.findIndex(step => step.name?.startsWith('Create draft'))
  assert.ok(recheck >= 0 && recheck < promote)
  assert.match(draft.steps[recheck].run, /resolve-release-tag\.mjs/)
  assert.equal(draft.steps.filter(step => step.uses?.startsWith('actions/checkout@')).length, 1)
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

test('release promotion exercises the exact AppImage bytes and the npm/GitHub channel identity', () => {
  const workflow = load(readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'))
  assert.equal(workflow.permissions.actions, 'read')
  for (const jobName of ['build-portable', 'build-linux']) {
    const job = workflow.jobs[jobName]
    const download = job.steps.find(step => step.name === 'Download the npm-qualified CLI candidate')
    assert.ok(download, `${jobName} must download the qualified candidate`)
    assert.match(download.run, /qualified-consumer-promotion\.mjs/)
    assert.match(download.run, /--source-sha "\$env:RELEASE_SOURCE"|--source-sha "\$RELEASE_SOURCE"/)
    assert.match(download.run, /release_artifact_inventory\.mjs/, 'copied tool must keep its relative import resolvable')
    const build = job.steps.find(step => step.name.startsWith('Build'))
    assert.match(build.run, /--cli-archive/)
  }
  const linux = workflow.jobs['build-linux']
  const smoke = linux.steps.findIndex(step => step.name === 'Launch the packaged AppImage on the released bytes')
  const stage = linux.steps.findIndex(step => step.name === 'Stage Linux release files')
  const sums = linux.steps.findIndex(step => step.name === 'Re-verify SHA256SUMS')
  assert.ok(sums >= 0 && sums < smoke && smoke < stage)
  assert.match(linux.steps[smoke].run, /smoke-linux-appimage\.mjs/)
  assert.match(linux.steps[smoke].run, /release-linux-out/)
  assert.ok(linux.steps.some(step => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'release-linux-smoke'))

  const draft = workflow.jobs['draft-release']
  assert.equal(draft.permissions.actions, 'read')
  const verify = draft.steps.findIndex(step => step.name === 'Verify exact staged release bytes before promotion')
  const promote = draft.steps.findIndex(step => step.name.startsWith('Create draft'))
  assert.ok(verify >= 0 && verify < promote)
  const run = draft.steps[verify].run
  assert.match(run, /tools\/verify-release-bytes\.mjs/)
  assert.match(run, /--npm-candidate "\$RUNNER_TEMP\/npm-candidate"/)
  assert.match(run, /--appimage-evidence release-linux-smoke\/result\.json/)
  assert.match(run, /--result "\$RUNNER_TEMP\/release-qualification\.json"/)
  const install = draft.steps.findIndex(step => step.name === 'Install advisory review dependencies')
  assert.ok(install >= 0 && install < verify, 'advisory tooling deps must exist before verification')
  assert.match(draft.steps[install].run, /npm --prefix babel-cli ci --ignore-scripts/)
  assert.ok(draft.steps.some(step => step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === 'release-qualification'))
  const combine = draft.steps.find(step => step.name === 'Combine checksums and stage the draft').run
  assert.match(combine, /sha256sum \.\/\*\.tgz/)
  assert.match(combine, /sha256sum -c SHA256SUMS/)
})
