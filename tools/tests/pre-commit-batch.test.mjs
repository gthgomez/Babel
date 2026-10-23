import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('batched staged scan preserves space/Unicode locations and scans added triple-plus lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-precommit-batch-'))
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0)
  }
  try {
    mkdirSync(join(root, 'tools/security'), { recursive: true })
    copyFileSync(fileURLToPath(new URL('../security/tracked-scan-common.psm1', import.meta.url)), join(root, 'tools/security/tracked-scan-common.psm1'))
    writeFileSync(join(root, 'tools/security/policy.json'), '{"forbidden_dependency_fingerprints":[]}')
    git('init', '-q')
    writeFileSync(join(root, 'first file.txt'), 'synthetic safe text\n')
    writeFileSync(join(root, 'café.txt'), 'synthetic safe text\n')
    git('add', '--', 'first file.txt', 'café.txt')
    const run = () => spawnSync('pwsh', ['-NoProfile', '-File', fileURLToPath(new URL('../../.githooks/pre-commit.ps1', import.meta.url))], { cwd: root, encoding: 'utf8', windowsHide: true })
    const accepted = run()
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr)
    const synthetic = 'ghp_' + 'a'.repeat(25)
    writeFileSync(join(root, 'first file.txt'), '+++ ' + synthetic + '\n')
    git('add', '--', 'first file.txt')
    const rejected = run()
    assert.equal(rejected.status, 1)
    assert.ok(rejected.stdout.includes('GitHub token'))
    assert.ok(rejected.stdout.includes('first file.txt:1'))
    assert.ok(!rejected.stdout.includes(synthetic) && !rejected.stderr.includes(synthetic))
    mkdirSync(join(root, '.ssh'))
    writeFileSync(join(root, '.ssh', 'id_rsa'), '')
    git('add', '-f', '--', '.ssh/id_rsa')
    const credential = run()
    assert.equal(credential.status, 1)
    assert.ok(credential.stdout.includes('credential-class'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
