import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkInstalledDependencies } from '../../babel-cli/scripts/check_installed_dependencies.mjs'

test('dependency consistency distinguishes locked packages, drift, and optional omission', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-dependency-consistency-'))
  const path = join(root, 'node_modules', 'fixture')
  try {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      '': { version: '1' }, 'node_modules/fixture': { version: '2' },
      'node_modules/optional': { version: '1', optional: true },
    } }))
    assert.equal(checkInstalledDependencies(root).status, 'FAIL')
    writeFileSync(join(path, 'package.json'), '{"version":"2"}')
    assert.equal(checkInstalledDependencies(root).status, 'PASS')
    writeFileSync(join(path, 'package.json'), '{"version":"1"}')
    assert.deepEqual(checkInstalledDependencies(root).problems, [{ path: 'node_modules/fixture', reason: 'version-drift' }])
    writeFileSync(join(path, 'package.json'), 'malformed')
    assert.equal(checkInstalledDependencies(root).problems[0].reason, 'invalid-package-metadata')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
