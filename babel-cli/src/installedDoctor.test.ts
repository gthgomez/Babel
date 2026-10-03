import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { runInstalledDoctor, installedSetupChecklist } from './installedDoctor.js'

it('diagnoses an installed user without contributor files or all provider credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel doctor ü '))
  try {
    mkdirSync(join(root, 'resources'))
    writeFileSync(join(root, 'resources', 'prompt_catalog.yaml'), 'assets: []')
    const paths = { packageRoot: root, resourceRoot: join(root, 'resources'), isInstalled: true,
      userConfigRoot: join(root, 'config'), userStateRoot: join(root, 'state'),
      userCacheRoot: join(root, 'cache'), targetProjectRoot: root }
    const result = runInstalledDoctor({ paths, env: { OPENROUTER_API_KEY: 'doctor-secret-sentinel' }, dockerProbe: () => true })
    assert.equal(result.status, 'ok')
    assert.equal(result.checks.find(c => c.id === 'provider')?.status, 'ok')
    assert.doesNotMatch(JSON.stringify(result), /doctor-secret-sentinel|workspace-map|pwsh|sibling/)
    const absent = runInstalledDoctor({ paths, env: {}, dockerProbe: () => false })
    assert.equal(absent.status, 'fail')
    assert.equal(absent.checks.find(c => c.id === 'docker')?.status, 'fail')
    assert.equal(absent.checks.find(c => c.id === 'provider')?.status, 'warn')
    assert.match(JSON.stringify(installedSetupChecklist()), /babel-agent doctor/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
