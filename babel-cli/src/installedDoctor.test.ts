import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { runInstalledDoctor, installedSetupChecklist, supportsInstalledNode } from './installedDoctor.js'

it('does not report a usable execution environment from a healthy daemon alone',()=>{
  const result=runInstalledDoctor({env:{},dockerProbe:()=>true})
  assert.equal(result.status,'fail')
  assert.equal(result.checks.find(check=>check.id==='sandbox_image')?.status,'fail')
})

it('requires unflagged WASM support and the Node 24 Unicode deletion fix', () => {
  for (const version of ['20.19.0', '22.18.0', '23.11.0', '24.0.0', '24.4.9', '24.5.0', '24.12.0', '24.13.0', '25.0.0', '25.4.0', '26.0.0']) assert.equal(supportsInstalledNode(version), false, version)
  for (const version of ['22.19.0', '22.23.3', '24.13.1', '24.14.0', '24.19.0']) assert.equal(supportsInstalledNode(version), true, version)
})

it('diagnoses an installed user without contributor files or all provider credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel doctor ü '))
  try {
    mkdirSync(join(root, 'resources'))
    writeFileSync(join(root, 'resources', 'prompt_catalog.yaml'), 'assets: []')
    const paths = { packageRoot: root, resourceRoot: join(root, 'resources'), isInstalled: true,
      userConfigRoot: join(root, 'config'), userStateRoot: join(root, 'state'),
      userCacheRoot: join(root, 'cache'), targetProjectRoot: root }
    const result = runInstalledDoctor({ paths, env: { OPENROUTER_API_KEY: 'doctor-secret-sentinel',BABEL_BENCHMARK_DOCKER_IMAGE:`sha256:${'a'.repeat(64)}` }, settings: { schemaVersion: 1, connections: { chosen: { id: 'chosen', provider: 'openrouter', model: 'fixture-model' } }, defaults: { connection: 'chosen' } }, dockerProbe: () => true,imageProbe:()=>true })
    assert.equal(result.status, 'ok')
    assert.equal(result.checks.find(c => c.id === 'provider')?.status, 'ok')
    assert.doesNotMatch(JSON.stringify(result), /doctor-secret-sentinel|workspace-map|pwsh|sibling/)
    const absent = runInstalledDoctor({ paths, env: {}, dockerProbe: () => false })
    assert.equal(absent.status, 'fail')
    assert.equal(absent.checks.find(c => c.id === 'docker')?.status, 'fail')
    assert.equal(absent.checks.find(c => c.id === 'provider')?.status, 'warn')
    assert.match(JSON.stringify(installedSetupChecklist()), /babel-harness doctor/)
    const setup = installedSetupChecklist({ paths })
    assert.equal(setup.provider_configuration.env_file, join(paths.userConfigRoot, '.env'))
    assert.ok(setup.provider_configuration.credential_env_vars.includes('OPENROUTER_API_KEY'))
    assert.doesNotMatch(JSON.stringify(setup), /doctor-secret-sentinel/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


it('explains Docker and the sandbox image for each platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-doctor-platform-'))
  try {
    mkdirSync(join(root, 'resources'))
    writeFileSync(join(root, 'resources', 'prompt_catalog.yaml'), 'assets: []')
    const paths = { packageRoot: root, resourceRoot: join(root, 'resources'), isInstalled: true,
      userConfigRoot: join(root, 'config'), userStateRoot: join(root, 'state'),
      userCacheRoot: join(root, 'cache'), targetProjectRoot: root }
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const down = runInstalledDoctor({ paths, env: { OPENROUTER_API_KEY: 'doctor-secret-sentinel' }, dockerProbe: () => false, platform })
      const docker = down.checks.find(check => check.id === 'docker')?.message ?? ''
      const image = down.checks.find(check => check.id === 'sandbox_image')?.message ?? ''
      assert.equal(docker.includes('doctor-secret-sentinel'), false)
      assert.equal(image.includes('doctor-secret-sentinel'), false)
      assert.match(docker, /Docker is not available/)
      assert.match(image, /BABEL_BENCHMARK_DOCKER_IMAGE/)
      assert.match(image, platform === 'win32' ? /Babel Desktop/ : /only available on Windows/)
      if (platform === 'win32') assert.match(image, /Babel Desktop/)
      else {
        assert.match(image, /Windows/)
        assert.match(image, /babel-harness sandbox prepare/)
      }
      if (platform === 'linux') assert.match(docker, /Docker Engine/)
      if (platform === 'darwin') assert.match(docker, /Docker Desktop for Mac/)
    }
    const up = runInstalledDoctor({ paths, env: {}, dockerProbe: () => true, platform: 'linux' })
    assert.match(up.checks.find(check => check.id === 'docker')?.message ?? '', /Docker is running/)
    assert.match(up.checks.find(check => check.id === 'sandbox_image')?.message ?? '', /sandbox prepare/)
    const setup = installedSetupChecklist({ paths })
    assert.match(setup.provider_configuration.manual_env_example, /your-key-here/)
    assert.match(setup.provider_configuration.manual_env_example, /OPENROUTER_API_KEY=your-key-here|DEEPINFRA_API_KEY=your-key-here/)
    assert.equal(setup.provider_configuration.manual_env_example.includes('doctor-secret-sentinel'), false)
    assert.match(setup.next_command, /babel-harness doctor/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('does not treat an unrelated ambient provider key as a selected connection', () => {
  const result = runInstalledDoctor({ env: { OPENROUTER_API_KEY: 'fixture-only' }, settings: { schemaVersion: 1, connections: {} }, dockerProbe: () => false })
  assert.equal(result.checks.find(check => check.id === 'provider')?.status, 'warn')
  assert.match(result.checks.find(check => check.id === 'provider')?.message ?? '', /setup/)
})
